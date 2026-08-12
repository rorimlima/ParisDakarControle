-- =====================================================================
-- Paris Dakar Controle — Migração: Entrega de Veículo & Assinatura Digital
-- Adiciona suporte a Entrega (status INATIVO), histórico de entregas,
-- assinatura digital e reativação automática ao entrar na portaria.
-- =====================================================================

-- 1. Atualiza constraint de status dos veículos para aceitar 'INATIVO'
alter table public.veiculos drop constraint if exists veiculos_status_check;
alter table public.veiculos add constraint veiculos_status_check
  check (status in ('DISPONIVEL','EM_TRANSITO','NA_PORTARIA','NO_DESTINO','INATIVO'));

-- 2. Adiciona colunas relativas à entrega em veiculos
alter table public.veiculos add column if not exists km_entrega int null check (km_entrega is null or km_entrega >= 0);
alter table public.veiculos add column if not exists data_entrega timestamptz null;
alter table public.veiculos add column if not exists ultima_entrega_id uuid null;

-- 3. Tabela de histórico de entregas com recebedor, entregador e assinatura
create table if not exists public.entregas_veiculo (
  id                uuid primary key default gen_random_uuid(),
  veiculo_id        uuid not null references public.veiculos(id) on delete cascade,
  km_entrega        int not null check (km_entrega >= 0),
  data_hora_entrega timestamptz not null default now(),
  entregador_id     uuid null references auth.users(id) on delete set null,
  entregador_nome   text not null,
  recebedor_nome    text not null check (length(btrim(recebedor_nome)) >= 2),
  recebedor_doc     text null,
  assinatura_url    text null,
  observacoes       text null,
  criado_em         timestamptz not null default now()
);

create index if not exists idx_entregas_veiculo on public.entregas_veiculo(veiculo_id, data_hora_entrega desc);

-- Adicionar FK de veiculos.ultima_entrega_id apontando para entregas_veiculo
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'veiculos_ultima_entrega_id_fkey'
  ) then
    alter table public.veiculos
      add constraint veiculos_ultima_entrega_id_fkey
      foreign key (ultima_entrega_id) references public.entregas_veiculo(id) on delete set null;
  end if;
end;
$$;

-- RLS para entregas_veiculo
alter table public.entregas_veiculo enable row level security;

drop policy if exists entregas_select_autenticado on public.entregas_veiculo;
drop policy if exists entregas_insert_autenticado on public.entregas_veiculo;

create policy entregas_select_autenticado on public.entregas_veiculo
  for select to authenticated using (app.esta_ativo());

create policy entregas_insert_autenticado on public.entregas_veiculo
  for insert to authenticated with check (app.esta_ativo());

-- 4. RPC para registrar a entrega do veículo
create or replace function public.registrar_entrega_veiculo(
  p_veiculo_id        uuid,
  p_km_entrega        int,
  p_data_hora_entrega timestamptz default now(),
  p_entregador_id     uuid default null,
  p_entregador_nome   text default null,
  p_recebedor_nome    text default null,
  p_recebedor_doc     text default null,
  p_assinatura_url    text default null,
  p_observacoes       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid              uuid := auth.uid();
  v_veiculo          public.veiculos;
  v_entregador_nome  text;
  v_entrega          public.entregas_veiculo;
begin
  if not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  if p_km_entrega is null or p_km_entrega < 0 then
    raise exception 'ENTRADA_INVALIDA: KM de entrega e obrigatorio e deve ser maior ou igual a zero'
      using errcode = 'PD007';
  end if;

  if p_recebedor_nome is null or length(btrim(p_recebedor_nome)) < 2 then
    raise exception 'ENTRADA_INVALIDA: Nome do recebedor e obrigatorio'
      using errcode = 'PD007';
  end if;

  -- Trava a linha do veículo
  select * into v_veiculo from public.veiculos where id = p_veiculo_id for update;
  if not found then
    raise exception 'NAO_ENCONTRADO: veiculo inexistente' using errcode = 'PD004';
  end if;

  -- Resolver nome do entregador
  if p_entregador_nome is not null and length(btrim(p_entregador_nome)) > 0 then
    v_entregador_nome := btrim(p_entregador_nome);
  else
    select nome into v_entregador_nome from public.perfis_usuario where id = coalesce(p_entregador_id, v_uid);
    v_entregador_nome := coalesce(v_entregador_nome, 'Responsável da Manutenção');
  end if;

  -- Insere o registro de entrega
  insert into public.entregas_veiculo (
    veiculo_id, km_entrega, data_hora_entrega, entregador_id,
    entregador_nome, recebedor_nome, recebedor_doc, assinatura_url, observacoes
  ) values (
    p_veiculo_id, p_km_entrega, coalesce(p_data_hora_entrega, now()),
    coalesce(p_entregador_id, v_uid), v_entregador_nome,
    btrim(p_recebedor_nome), nullif(btrim(p_recebedor_doc), ''),
    p_assinatura_url, nullif(btrim(p_observacoes), '')
  ) returning * into v_entrega;

  -- Atualiza o veículo para INATIVO
  update public.veiculos
     set status = 'INATIVO',
         km_entrega = p_km_entrega,
         data_entrega = coalesce(p_data_hora_entrega, now()),
         ultima_entrega_id = v_entrega.id
   where id = p_veiculo_id;

  perform app.log('ENTREGA_VEICULO', 'veiculos', p_veiculo_id, jsonb_build_object(
    'entrega_id', v_entrega.id,
    'km_entrega', p_km_entrega,
    'recebedor', p_recebedor_nome,
    'entregador', v_entregador_nome
  ));

  return to_jsonb(v_entrega);
end;
$$;

-- 5. Atualizar registrar_movimentacao para proibir saída de veículo INATIVO
create or replace function public.registrar_movimentacao(
  p_veiculo_id   uuid,
  p_tipo         text,
  p_portaria_id  uuid default null,
  p_destino_id   uuid default null,
  p_observacoes  text default null,
  p_client_op_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid       uuid := auth.uid();
  v_veiculo   public.veiculos;
  v_nova      public.movimentacoes;
  v_data      timestamptz := now();
  v_existente public.movimentacoes;
  v_pend      record;
begin
  if not app.esta_ativo() then
    raise exception 'PERMISSAO_NEGADA' using errcode = 'PD003';
  end if;

  if p_client_op_id is not null then
    select * into v_existente from public.movimentacoes where client_op_id = p_client_op_id;
    if found then
      return to_jsonb(v_existente);
    end if;
  end if;

  if p_tipo not in ('ENTRADA_PORTARIA','SAIDA_PORTARIA','CHEGADA_DESTINO','SAIDA_DESTINO') then
    raise exception 'TIPO_INVALIDO: tipo de movimentacao desconhecido' using errcode = 'PD007';
  end if;

  select * into v_veiculo from public.veiculos
   where id = p_veiculo_id and ativo
   for update;
  if not found then
    raise exception 'NAO_ENCONTRADO: veiculo inexistente ou inativo' using errcode = 'PD004';
  end if;

  -- Se veículo está INATIVO (Entregue), só permite ENTRADA_PORTARIA
  if v_veiculo.status = 'INATIVO' and p_tipo <> 'ENTRADA_PORTARIA' then
    raise exception 'ESTADO_INVALIDO: Veiculo esta INATIVO (Entregue). E necessario registrar uma Entrada na portaria para reativa-lo.'
      using errcode = 'PD005';
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
