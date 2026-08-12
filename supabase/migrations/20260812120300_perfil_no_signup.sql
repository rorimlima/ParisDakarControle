-- =====================================================================
-- Paris Dakar Controle — 04 | Perfil criado junto com o usuário do Auth
--
-- O papel vem de raw_app_meta_data (app_metadata), que SÓ a service_role
-- escreve. Se viesse de user_metadata, qualquer usuário se promoveria a
-- MASTER no próprio signUp — é o furo clássico de projeto Supabase.
-- =====================================================================

create or replace function app.tg_novo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_papel text := coalesce(
                    new.raw_app_meta_data ->> 'papel',
                    new.raw_app_metadata ->> 'papel',
                    'MANUTENCAO'
                  );
  v_nome  text := coalesce(
                    nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''),
                    nullif(btrim(new.raw_user_metadata ->> 'nome'), ''),
                    split_part(coalesce(new.email, 'Usuario'), '@', 1)
                  );
begin
  if v_papel not in ('MASTER','MANUTENCAO') then
    v_papel := 'MANUTENCAO';
  end if;

  if length(btrim(v_nome)) < 2 then
    v_nome := rpad(v_nome, 2, '_');
  end if;

  insert into public.perfis_usuario (id, nome, papel, ativo)
  values (new.id, left(v_nome, 120), v_papel, true)
  on conflict (id) do update
    set papel = excluded.papel,
        nome = excluded.nome,
        ativo = excluded.ativo;

  return new;
end;
$$;

drop trigger if exists tg_auth_novo_usuario on auth.users;
create trigger tg_auth_novo_usuario
  after insert on auth.users
  for each row execute function app.tg_novo_usuario();
