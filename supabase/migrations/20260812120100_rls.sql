-- =====================================================================
-- Paris Dakar Controle — 02 | Autorização: helpers + RLS + Storage
-- Regra: sem política = sem acesso. O cliente usa a anon key, que é pública;
-- a RLS É o backend de leitura.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers (schema app, fora do PostgREST)
-- SECURITY DEFINER + search_path fixo. Sem o search_path, security definer
-- é escalação de privilégio (atacante cria objeto em outro schema e sequestra).
-- Além disso, o DEFINER evita recursão infinita da RLS de perfis_usuario.
-- ---------------------------------------------------------------------
create or replace function app.papel_atual()
returns text
language sql
stable
security definer
set search_path = public, app
as $$
  select p.papel
    from public.perfis_usuario p
   where p.id = auth.uid() and p.ativo
   limit 1;
$$;

create or replace function app.eh_master()
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select coalesce(app.papel_atual() = 'MASTER', false);
$$;

create or replace function app.esta_ativo()
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1 from public.perfis_usuario p where p.id = auth.uid() and p.ativo
  );
$$;

grant execute on function app.papel_atual(), app.eh_master(), app.esta_ativo()
  to authenticated;

-- ---------------------------------------------------------------------
-- Trava de escalação de privilégio em perfis_usuario
-- Coluna sensível (papel, ativo, colaborador_id) só muda por MASTER.
-- ---------------------------------------------------------------------
create or replace function app.tg_bloqueia_escalacao_perfil()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
begin
  if app.eh_master()
     or coalesce((select auth.role()), '') in ('service_role', 'supabase_auth_admin')
     or current_user in ('postgres', 'supabase_auth_admin', 'service_role', 'dashboard_user')
  then
    return new;
  end if;
  if new.papel is distinct from old.papel
     or new.ativo is distinct from old.ativo
     or new.colaborador_id is distinct from old.colaborador_id
     or new.id is distinct from old.id then
    raise exception 'PERMISSAO_NEGADA: alteracao de papel/status exige MASTER'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_perfis_bloqueia_escalacao on public.perfis_usuario;
create trigger tg_perfis_bloqueia_escalacao
  before update on public.perfis_usuario
  for each row execute function app.tg_bloqueia_escalacao_perfil();

-- ---------------------------------------------------------------------
-- Habilitar RLS em tudo que a API expõe
-- ---------------------------------------------------------------------
alter table public.perfis_usuario enable row level security;
alter table public.veiculos       enable row level security;
alter table public.portarias      enable row level security;
alter table public.destinos       enable row level security;
alter table public.movimentacoes  enable row level security;
alter table public.vistorias      enable row level security;
alter table public.fotos_vistoria enable row level security;
alter table public.logs_auditoria enable row level security;
alter table public.rate_limits    enable row level security;  -- sem política: ninguém acessa via API

-- =====================================================================
-- perfis_usuario
-- =====================================================================
drop policy if exists perfis_select_proprio      on public.perfis_usuario;
drop policy if exists perfis_select_master       on public.perfis_usuario;
drop policy if exists perfis_update_proprio_nome on public.perfis_usuario;
drop policy if exists perfis_insert_master       on public.perfis_usuario;
drop policy if exists perfis_update_master       on public.perfis_usuario;
drop policy if exists perfis_delete_master       on public.perfis_usuario;

create policy perfis_select_proprio on public.perfis_usuario
  for select to authenticated using (id = auth.uid());

create policy perfis_select_master on public.perfis_usuario
  for select to authenticated using (app.eh_master());

-- Usuário edita o próprio nome; o trigger acima barra papel/ativo.
create policy perfis_update_proprio_nome on public.perfis_usuario
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy perfis_insert_master on public.perfis_usuario
  for insert to authenticated with check (app.eh_master());

create policy perfis_update_master on public.perfis_usuario
  for update to authenticated using (app.eh_master()) with check (app.eh_master());

create policy perfis_delete_master on public.perfis_usuario
  for delete to authenticated using (app.eh_master());

-- =====================================================================
-- veiculos / portarias / destinos
-- Leitura: qualquer autenticado ATIVO. Escrita: só MASTER.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['veiculos','portarias','destinos'] loop
    execute format('drop policy if exists %I_select_autenticado on public.%I', t, t);
    execute format('drop policy if exists %I_insert_master on public.%I', t, t);
    execute format('drop policy if exists %I_update_master on public.%I', t, t);
    execute format('drop policy if exists %I_delete_master on public.%I', t, t);

    execute format($f$create policy %I_select_autenticado on public.%I
                      for select to authenticated using (app.esta_ativo())$f$, t, t);
    execute format($f$create policy %I_insert_master on public.%I
                      for insert to authenticated with check (app.eh_master())$f$, t, t);
    execute format($f$create policy %I_update_master on public.%I
                      for update to authenticated
                      using (app.eh_master()) with check (app.eh_master())$f$, t, t);
    execute format($f$create policy %I_delete_master on public.%I
                      for delete to authenticated using (app.eh_master())$f$, t, t);
  end loop;
end;
$$;

-- =====================================================================
-- movimentacoes
-- SELECT/DELETE por RLS. INSERT/UPDATE **não têm política**: a única porta
-- é a RPC SECURITY DEFINER, que roda a trava anti-duplicidade em transação.
-- Sem isso, o cliente poderia inserir direto e furar a regra de negócio.
-- =====================================================================
drop policy if exists mov_select_proprio on public.movimentacoes;
drop policy if exists mov_select_master  on public.movimentacoes;
drop policy if exists mov_delete_master  on public.movimentacoes;

create policy mov_select_proprio on public.movimentacoes
  for select to authenticated using (usuario_id = auth.uid() and app.esta_ativo());

create policy mov_select_master on public.movimentacoes
  for select to authenticated using (app.eh_master());

create policy mov_delete_master on public.movimentacoes
  for delete to authenticated using (app.eh_master());

-- =====================================================================
-- vistorias / fotos_vistoria — mesmo raciocínio (escrita via RPC)
-- =====================================================================
drop policy if exists vist_select_proprio on public.vistorias;
drop policy if exists vist_select_master  on public.vistorias;

create policy vist_select_proprio on public.vistorias
  for select to authenticated using (usuario_id = auth.uid() and app.esta_ativo());

create policy vist_select_master on public.vistorias
  for select to authenticated using (app.eh_master());

drop policy if exists fotos_select_proprio on public.fotos_vistoria;
drop policy if exists fotos_select_master  on public.fotos_vistoria;

create policy fotos_select_proprio on public.fotos_vistoria
  for select to authenticated using (
    exists (select 1 from public.vistorias v
             where v.id = fotos_vistoria.vistoria_id and v.usuario_id = auth.uid())
    and app.esta_ativo()
  );

create policy fotos_select_master on public.fotos_vistoria
  for select to authenticated using (app.eh_master());

-- =====================================================================
-- logs_auditoria — só MASTER lê; escrita apenas por SECURITY DEFINER
-- =====================================================================
drop policy if exists logs_select_master on public.logs_auditoria;
create policy logs_select_master on public.logs_auditoria
  for select to authenticated using (app.eh_master());

-- =====================================================================
-- STORAGE — bucket privado `vistorias`
-- Caminho: {vistoria_id}/{tipo}_{timestamp}.jpg
-- file_size_limit e allowed_mime_types são validados pelo servidor do Storage,
-- não pelo cliente.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vistorias', 'vistorias', false, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Extrai o vistoria_id da primeira pasta do caminho sem estourar em path inválido.
create or replace function app.vistoria_id_do_caminho(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare v uuid;
begin
  begin
    v := (storage.foldername(p_name))[1]::uuid;
  exception when others then
    return null;
  end;
  return v;
end;
$$;

create or replace function app.pode_gravar_vistoria(p_vistoria_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1 from public.vistorias v
     where v.id = p_vistoria_id
       and (v.usuario_id = auth.uid() or app.eh_master())
  );
$$;

grant execute on function app.vistoria_id_do_caminho(text), app.pode_gravar_vistoria(uuid)
  to authenticated;

drop policy if exists vistorias_storage_select on storage.objects;
drop policy if exists vistorias_storage_insert on storage.objects;
drop policy if exists vistorias_storage_delete on storage.objects;

create policy vistorias_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vistorias'
    and app.pode_gravar_vistoria(app.vistoria_id_do_caminho(name))
  );

create policy vistorias_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vistorias'
    and app.pode_gravar_vistoria(app.vistoria_id_do_caminho(name))
  );

create policy vistorias_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'vistorias'
    and app.pode_gravar_vistoria(app.vistoria_id_do_caminho(name))
  );
