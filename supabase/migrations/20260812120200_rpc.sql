-- =====================================================================
-- Paris Dakar Controle — 03 | Regra de negócio no banco (RPC)
--
-- Tudo que o usuário se beneficiaria em falsear roda aqui: SECURITY DEFINER,
-- search_path fixo, autorização checada explicitamente (dentro de DEFINER a
-- RLS não se aplica — a checagem tem que ser manual e é).
--
-- SQLSTATEs próprios (mapeados para HTTP na Edge Function e no frontend):
--   PD001 conflito: já existe movimentação pendente        -> 409
--   PD002 vistoria obrigatória ausente                     -> 422
--   PD003 permissão negada                                 -> 403
--   PD004 recurso não encontrado / inativo                 -> 404
--   PD005 estado inválido para a operação                  -> 409
--   PD006 rate limit                                       -> 429
--   PD007 entrada inválida                                 -> 400
-- =====================================================================

-- Fuso de exibição das mensagens ao usuário.
create or replace function app.tz()
returns text language sql immutable as $$ select 'America/Fortaleza'::text $$;

-- ---------------------------------------------------------------------
-- Rate limit por janela fixa, compartilhado entre isolates
-- ---------------------------------------------------------------------
create or replace function app.consumir_rate_limit(
  p_chave text, p_limite int, p_janela_segundos int
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_janela timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_janela_segundos) * p_janela_segundos
  );
  v_contador int;
begin
  insert into public.rate_limits (chave, janela_inicio, contador)
  values (p_chave, v_janela, 1)
  on conflict (chave, janela_inicio)
    do update set contador = public.rate_limits.contador + 1
  returning contador into v_contador;

  if v_contador > p_limite then
    raise exception 'RATE_LIMIT: muitas requisicoes, tente novamente em instantes'
      using errcode = 'PD006';
  end if;

  -- limpeza barata e oportunista (1 em ~50 chamadas)
  if random() < 0.02 then
    delete from public.rate_limits where janela_inicio < now() - interval '1 hour';
  end if;
end;
$$;

/*
 * Rate limit chamado de fora, em TRANSAÇÃO PRÓPRIA.
 *
 * Detalhe que costuma passar batido: o `perform app.consumir_rate_limit(...)`
 * feito DENTRO de registrar_movimentacao é desfeito junto com o rollback
 * quando a própria função lança exceção — ou seja, tentativa recusada não
 * conta. Por isso a Edge Function chama esta RPC ANTES, numa requisição
 * separada: esse incremento commita mesmo que a operação seguinte falhe.
 */
create or replace function public.checar_limite(
  p_recurso text, p_limite int default 60, p_janela_segundos int default 60
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if auth.uid() is null then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;
  -- a chave é derivada do JWT, nunca de parâmetro do cliente
  perform app.consumir_rate_limit(
    left(regexp_replace(coalesce(p_recurso, 'geral'), '[^a-z_]', '', 'g'), 20)
      || ':' || auth.uid()::text,
    greatest(1, least(p_limite, 1000)),
    greatest(1, least(p_janela_segundos, 3600))
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Normalização compartilhada entre importação e cadastro manual
-- ---------------------------------------------------------------------
create or replace function app.normaliza_placa(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

create or replace function app.normaliza_chassi(p text)
returns text language sql immutable as $$
  -- Chassi (VIN) válido: 17 posições, sem I, O e Q. Fora disso vira NULL:
  -- a planilha real traz "11", "13", "9895" repetidos, que colidiriam no UNIQUE.
  select case
    when regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g') ~ '^[A-HJ-NPR-Z0-9]{17}$'
      then regexp_replace(upper(p), '[^A-Z0-9]', '', 'g')
    else null
  end
$$;

create or replace function app.log(
  p_acao text, p_entidade text, p_entidade_id uuid, p_dados jsonb default null
) returns void
language sql
security definer
set search_path = public, app
as $$
  insert into public.logs_auditoria (usuario_id, acao, entidade, entidade_id, dados)
  values (auth.uid(), p_acao, p_entidade, p_entidade_id, p_dados);
$$;

-- =====================================================================
-- REGISTRAR MOVIMENTAÇÃO — trava anti-duplicidade (requisito crítico)
--
-- Três camadas de defesa contra dois usuários no mesmo instante:
--   1. SELECT ... FOR UPDATE na linha do veículo  -> serializa as transações
--   2. Verificação explícita de PENDENTE          -> mensagem clara
--   3. Índice único parcial idx_veiculo_pendente  -> garantia física do banco
-- =====================================================================
create or replace function public.registrar_movimentacao(
  p_veiculo_id   uuid,
  p_tipo         text,
  p_portaria_id  uuid    default null,
  p_destino_id   uuid    default null,
  p_data_hora    timestamptz default null,
  p_observacoes  text    default null,
  p_client_op_id uuid    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid       uuid := auth.uid();
  v_existente public.movimentacoes;
  v_veiculo   public.veiculos;
  v_pend      record;
  v_nova      public.movimentacoes;
  v_data      timestamptz := coalesce(p_data_hora, now());
begin
  if v_uid is null or not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA: usuario nao autenticado ou inativo' using errcode = 'PD003';
  end if;

  perform app.consumir_rate_limit('mov:' || v_uid::text, 60, 60);

  if p_tipo not in ('ENTRADA_PORTARIA','SAIDA_PORTARIA','CHEGADA_DESTINO','SAIDA_DESTINO') then
    raise exception 'ENTRADA_INVALIDA: tipo de movimentacao desconhecido' using errcode = 'PD007';
  end if;

  if v_data > now() + interval '5 minutes' then
    raise exception 'ENTRADA_INVALIDA: data_hora no futuro' using errcode = 'PD007';
  end if;

  -- Idempotência da fila offline: reenvio da mesma operação devolve a original.
  if p_client_op_id is not null then
    select * into v_existente from public.movimentacoes where client_op_id = p_client_op_id;
    if found then
      if v_existente.usuario_id <> v_uid and not app.eh_master() then
        raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
      end if;
      return to_jsonb(v_existente) || jsonb_build_object('idempotente', true);
    end if;
  end if;

  -- (1) trava a linha do veículo: a segunda transação espera aqui
  select * into v_veiculo from public.veiculos
   where id = p_veiculo_id and ativo
   for update;
  if not found then
    raise exception 'NAO_ENCONTRADO: veiculo inexistente ou inativo' using errcode = 'PD004';
  end if;

  if p_tipo in ('ENTRADA_PORTARIA','SAIDA_PORTARIA') then
    if not exists (select 1 from public.portarias where id = p_portaria_id and ativo) then
      raise exception 'NAO_ENCONTRADO: portaria inexistente ou inativa' using errcode = 'PD004';
    end if;
    p_destino_id := null;
  else
    if not exists (select 1 from public.destinos where id = p_destino_id and ativo) then
      raise exception 'NAO_ENCONTRADO: destino inexistente ou inativo' using errcode = 'PD004';
    end if;
    p_portaria_id := null;
  end if;

  -- (2) verificação explícita, para devolver mensagem legível
  select m.data_hora, coalesce(p.nome, 'outro usuario') as nome
    into v_pend
    from public.movimentacoes m
    left join public.perfis_usuario p on p.id = m.usuario_id
   where m.veiculo_id = p_veiculo_id and m.status = 'PENDENTE'
   limit 1;

  if found then
    raise exception 'MOVIMENTACAO_PENDENTE: Existe uma movimentacao pendente para este veiculo registrada por % as %. Aguarde a aprovacao.',
      v_pend.nome,
      to_char(v_pend.data_hora at time zone app.tz(), 'DD/MM/YYYY HH24:MI')
      using errcode = 'PD001';
  end if;

  -- (3) o índice único parcial é a última linha de defesa
  begin
    insert into public.movimentacoes
      (veiculo_id, tipo, portaria_id, destino_id, usuario_id, status,
       data_hora, observacoes, client_op_id)
    values
      (p_veiculo_id, p_tipo, p_portaria_id, p_destino_id, v_uid, 'PENDENTE',
       v_data, nullif(btrim(p_observacoes), ''), p_client_op_id)
    returning * into v_nova;
  exception when unique_violation then
    select m.data_hora, coalesce(p.nome, 'outro usuario') as nome
      into v_pend
      from public.movimentacoes m
      left join public.perfis_usuario p on p.id = m.usuario_id
     where m.veiculo_id = p_veiculo_id and m.status = 'PENDENTE'
     limit 1;
    raise exception 'MOVIMENTACAO_PENDENTE: Existe uma movimentacao pendente para este veiculo registrada por % as %. Aguarde a aprovacao.',
      coalesce(v_pend.nome, 'outro usuario'),
      to_char(coalesce(v_pend.data_hora, now()) at time zone app.tz(), 'DD/MM/YYYY HH24:MI')
      using errcode = 'PD001';
  end;

  perform app.log('MOVIMENTACAO_CRIADA', 'movimentacoes', v_nova.id,
                  jsonb_build_object('tipo', p_tipo, 'veiculo_id', p_veiculo_id));

  return to_jsonb(v_nova);
end;
$$;

-- =====================================================================
-- DECIDIR MOVIMENTAÇÃO — aprovar ou rejeitar, e mover o veículo na MESMA
-- transação. Vistoria obrigatória é checada aqui, não no frontend.
-- =====================================================================
create or replace function public.decidir_movimentacao(
  p_movimentacao_id uuid,
  p_decisao         text,          -- 'APROVADO' | 'REJEITADO'
  p_observacoes     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid       uuid := auth.uid();
  v_mov       public.movimentacoes;
  v_exige     boolean := false;
  v_tem_foto  boolean := false;
  v_status    text;
  v_loc       uuid;
  v_loc_tipo  text;
begin
  if v_uid is null or not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  perform app.consumir_rate_limit('dec:' || v_uid::text, 60, 60);

  if p_decisao not in ('APROVADO','REJEITADO') then
    raise exception 'ENTRADA_INVALIDA: decisao deve ser APROVADO ou REJEITADO' using errcode = 'PD007';
  end if;

  select * into v_mov from public.movimentacoes
   where id = p_movimentacao_id
   for update;
  if not found then
    raise exception 'NAO_ENCONTRADO: movimentacao inexistente' using errcode = 'PD004';
  end if;

  -- IDOR: dentro de SECURITY DEFINER a RLS não roda. Checagem explícita.
  if v_mov.usuario_id <> v_uid and not app.eh_master() then
    raise exception 'PERMISSAO_NEGADA: apenas o autor ou o master pode decidir' using errcode = 'PD003';
  end if;

  if v_mov.status <> 'PENDENTE' then
    raise exception 'ESTADO_INVALIDO: movimentacao ja esta %', v_mov.status using errcode = 'PD005';
  end if;

  if p_decisao = 'APROVADO' then
    if v_mov.tipo = 'ENTRADA_PORTARIA' then
      select p.exige_vistoria into v_exige from public.portarias p where p.id = v_mov.portaria_id;
      if coalesce(v_exige, false) then
        select exists (
          select 1
            from public.vistorias v
            join public.fotos_vistoria f on f.vistoria_id = v.id
           where v.movimentacao_id = v_mov.id
        ) into v_tem_foto;
        if not v_tem_foto then
          raise exception 'VISTORIA_OBRIGATORIA: esta portaria exige vistoria com ao menos uma foto antes da aprovacao'
            using errcode = 'PD002';
        end if;
      end if;
    end if;

    v_status := case v_mov.tipo
                  when 'ENTRADA_PORTARIA' then 'NA_PORTARIA'
                  when 'SAIDA_PORTARIA'   then 'EM_TRANSITO'
                  when 'CHEGADA_DESTINO'  then 'NO_DESTINO'
                  when 'SAIDA_DESTINO'    then 'EM_TRANSITO'
                end;
    -- Em trânsito, guardamos a última posição conhecida (de onde saiu):
    -- "sumiu do mapa" é pior para operação do que "saiu de X".
    v_loc      := coalesce(v_mov.portaria_id, v_mov.destino_id);
    v_loc_tipo := case when v_mov.portaria_id is not null then 'PORTARIA' else 'DESTINO' end;

    update public.veiculos
       set status = v_status,
           localizacao_atual = v_loc,
           localizacao_tipo  = v_loc_tipo
     where id = v_mov.veiculo_id;
  end if;

  update public.movimentacoes
     set status      = p_decisao,
         decidido_por = v_uid,
         decidido_em  = now(),
         observacoes  = coalesce(nullif(btrim(p_observacoes), ''), observacoes)
   where id = v_mov.id
   returning * into v_mov;

  perform app.log('MOVIMENTACAO_' || p_decisao, 'movimentacoes', v_mov.id,
                  jsonb_build_object('veiculo_id', v_mov.veiculo_id, 'tipo', v_mov.tipo));

  return to_jsonb(v_mov);
end;
$$;

-- =====================================================================
-- VISTORIA
-- =====================================================================
create or replace function public.registrar_vistoria(
  p_movimentacao_id   uuid,
  p_km                int  default null,
  p_nivel_combustivel text default null,
  p_observacoes       text default null,
  p_client_op_id      uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid uuid := auth.uid();
  v_mov public.movimentacoes;
  v_vis public.vistorias;
begin
  if v_uid is null or not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  perform app.consumir_rate_limit('vis:' || v_uid::text, 60, 60);

  if p_client_op_id is not null then
    select * into v_vis from public.vistorias where client_op_id = p_client_op_id;
    if found then
      if v_vis.usuario_id <> v_uid and not app.eh_master() then
        raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
      end if;
      return to_jsonb(v_vis) || jsonb_build_object('idempotente', true);
    end if;
  end if;

  select * into v_mov from public.movimentacoes where id = p_movimentacao_id for update;
  if not found then
    raise exception 'NAO_ENCONTRADO: movimentacao inexistente' using errcode = 'PD004';
  end if;
  if v_mov.usuario_id <> v_uid and not app.eh_master() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;
  if v_mov.status <> 'PENDENTE' then
    raise exception 'ESTADO_INVALIDO: movimentacao ja decidida' using errcode = 'PD005';
  end if;

  select * into v_vis from public.vistorias where movimentacao_id = v_mov.id;
  if found then
    update public.vistorias
       set km = coalesce(p_km, km),
           nivel_combustivel = coalesce(p_nivel_combustivel, nivel_combustivel),
           observacoes = coalesce(nullif(btrim(p_observacoes), ''), observacoes)
     where id = v_vis.id
     returning * into v_vis;
    return to_jsonb(v_vis);
  end if;

  insert into public.vistorias
    (movimentacao_id, veiculo_id, usuario_id, km, nivel_combustivel, observacoes, client_op_id)
  values
    (v_mov.id, v_mov.veiculo_id, v_uid, p_km, p_nivel_combustivel,
     nullif(btrim(p_observacoes), ''), p_client_op_id)
  returning * into v_vis;

  perform app.log('VISTORIA_CRIADA', 'vistorias', v_vis.id,
                  jsonb_build_object('movimentacao_id', v_mov.id));

  return to_jsonb(v_vis);
end;
$$;

create or replace function public.registrar_foto_vistoria(
  p_vistoria_id uuid,
  p_tipo        text,
  p_url         text
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid uuid := auth.uid();
  v_vis public.vistorias;
  v_foto public.fotos_vistoria;
begin
  if v_uid is null or not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  select * into v_vis from public.vistorias where id = p_vistoria_id;
  if not found then
    raise exception 'NAO_ENCONTRADO: vistoria inexistente' using errcode = 'PD004';
  end if;
  if v_vis.usuario_id <> v_uid and not app.eh_master() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  -- O caminho tem que estar dentro da pasta da própria vistoria: sem isso o
  -- usuário registraria como sua uma foto de outra vistoria.
  if position(p_vistoria_id::text || '/' in p_url) <> 1 then
    raise exception 'ENTRADA_INVALIDA: caminho fora da pasta da vistoria' using errcode = 'PD007';
  end if;

  insert into public.fotos_vistoria (vistoria_id, tipo, url)
  values (p_vistoria_id, p_tipo, p_url)
  on conflict (vistoria_id, url) do update set tipo = excluded.tipo
  returning * into v_foto;

  return to_jsonb(v_foto);
end;
$$;

-- =====================================================================
-- IMPORTAÇÃO DE PLANILHA — recebe as linhas já parseadas pela Edge Function.
-- Cada linha roda em seu próprio bloco de exceção (savepoint implícito):
-- linha ruim não derruba o lote e nunca fica gravada pela metade.
-- =====================================================================
create or replace function public.importar_veiculos(p_linhas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid         uuid := auth.uid();
  v_linha       jsonb;
  v_i           int := 0;
  v_importadas  int := 0;
  v_atualizadas int := 0;
  v_erros       jsonb := '[]'::jsonb;
  v_avisos      jsonb := '[]'::jsonb;
  v_cod    text; v_placa text; v_chassi text;
  v_ano    text; v_anof int; v_anom int;
  v_id     uuid; v_aviso text;
begin
  if v_uid is null or not app.eh_master() then
    raise exception 'PERMISSAO_NEGADA: importacao restrita ao usuario MASTER' using errcode = 'PD003';
  end if;

  perform app.consumir_rate_limit('imp:' || v_uid::text, 5, 60);

  if jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'ENTRADA_INVALIDA: esperado array de linhas' using errcode = 'PD007';
  end if;
  if jsonb_array_length(p_linhas) > 20000 then
    raise exception 'ENTRADA_INVALIDA: limite de 20000 linhas por importacao' using errcode = 'PD007';
  end if;

  for v_linha in select * from jsonb_array_elements(p_linhas) loop
    v_i := v_i + 1;
    v_aviso := null;
    begin
      v_cod := nullif(btrim(coalesce(v_linha->>'cod_veiculo', '')), '');
      if v_cod is null then
        raise exception 'coluna "Veiculo" (cod_veiculo) vazia';
      end if;

      v_placa  := app.normaliza_placa(v_linha->>'placa');
      v_chassi := app.normaliza_chassi(v_linha->>'chassi');

      if v_chassi is null and nullif(btrim(coalesce(v_linha->>'chassi','')), '') is not null then
        v_aviso := 'chassi invalido ignorado';
      end if;

      -- "2025/2026" -> 2025 / 2026 ; "2020" -> 2020 / 2020
      v_ano := btrim(coalesce(v_linha->>'ano', ''));
      v_anof := nullif(substring(v_ano from '^(\d{4})'), '')::int;
      v_anom := coalesce(nullif(substring(v_ano from '/\s*(\d{4})'), '')::int, v_anof);

      -- Chave de deduplicação, em ordem de confiança.
      select id into v_id from public.veiculos where cod_veiculo = v_cod;
      if v_id is null and v_placa is not null then
        select id into v_id from public.veiculos where placa = v_placa;
      end if;
      if v_id is null and v_chassi is not null then
        select id into v_id from public.veiculos where chassi = v_chassi;
      end if;

      if v_id is null then
        insert into public.veiculos
          (cod_veiculo, placa, chassi, marca, modelo, cor, ano_fabricacao, ano_modelo)
        values
          (v_cod, v_placa, v_chassi,
           nullif(btrim(coalesce(v_linha->>'marca','')), ''),
           nullif(btrim(coalesce(v_linha->>'modelo','')), ''),
           nullif(btrim(coalesce(v_linha->>'cor','')), ''),
           v_anof, v_anom);
        v_importadas := v_importadas + 1;
      else
        update public.veiculos
           set cod_veiculo    = v_cod,
               placa          = coalesce(v_placa, placa),
               chassi         = coalesce(v_chassi, chassi),
               marca          = coalesce(nullif(btrim(coalesce(v_linha->>'marca','')), ''), marca),
               modelo         = coalesce(nullif(btrim(coalesce(v_linha->>'modelo','')), ''), modelo),
               cor            = coalesce(nullif(btrim(coalesce(v_linha->>'cor','')), ''), cor),
               ano_fabricacao = coalesce(v_anof, ano_fabricacao),
               ano_modelo     = coalesce(v_anom, ano_modelo)
         where id = v_id;
        v_atualizadas := v_atualizadas + 1;
      end if;

      if v_aviso is not null then
        v_avisos := v_avisos || jsonb_build_object('linha', v_i, 'cod_veiculo', v_cod, 'aviso', v_aviso);
      end if;

    exception when others then
      v_erros := v_erros || jsonb_build_object(
        'linha', v_i,
        'cod_veiculo', coalesce(v_cod, ''),
        'motivo', regexp_replace(sqlerrm, '\s+', ' ', 'g')
      );
    end;
  end loop;

  perform app.log('IMPORTACAO_VEICULOS', 'veiculos', null,
                  jsonb_build_object('total', v_i, 'importadas', v_importadas,
                                     'atualizadas', v_atualizadas,
                                     'erros', jsonb_array_length(v_erros)));

  return jsonb_build_object(
    'total', v_i,
    'importadas', v_importadas,
    'atualizadas', v_atualizadas,
    'avisos', v_avisos,
    'erros', v_erros
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Permissões: revoga do anon; só usuário autenticado chama.
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.registrar_movimentacao(uuid,text,uuid,uuid,timestamptz,text,uuid)',
    'public.decidir_movimentacao(uuid,text,text)',
    'public.registrar_vistoria(uuid,int,text,text,uuid)',
    'public.registrar_foto_vistoria(uuid,text,text)',
    'public.importar_veiculos(jsonb)',
    'public.checar_limite(text,int,int)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Realtime: publica só o necessário. Realtime respeita RLS.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and tablename = 'veiculos') then
      execute 'alter publication supabase_realtime add table public.veiculos';
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and tablename = 'movimentacoes') then
      execute 'alter publication supabase_realtime add table public.movimentacoes';
    end if;
  end if;
end;
$$;

-- Realtime de UPDATE/DELETE precisa da linha antiga completa para filtrar por RLS.
alter table public.veiculos      replica identity full;
alter table public.movimentacoes replica identity full;
