-- =====================================================================
-- DOWN — Paris Dakar Controle (reverte 01..04)
--
-- ATENÇÃO: este script APAGA DADOS (DROP TABLE). Rode apenas em ambiente
-- de desenvolvimento e somente após confirmação explícita. Em produção,
-- faça backup e restore testado antes.
-- A tabela `colaboradores` (pré-existente) NÃO é tocada.
-- =====================================================================

drop trigger if exists tg_auth_novo_usuario on auth.users;

drop policy if exists vistorias_storage_select on storage.objects;
drop policy if exists vistorias_storage_insert on storage.objects;
drop policy if exists vistorias_storage_delete on storage.objects;
delete from storage.objects where bucket_id = 'vistorias';
delete from storage.buckets where id = 'vistorias';

drop function if exists public.importar_veiculos(jsonb);
drop function if exists public.registrar_foto_vistoria(uuid,text,text);
drop function if exists public.registrar_vistoria(uuid,int,text,text,uuid);
drop function if exists public.decidir_movimentacao(uuid,text,text);
drop function if exists public.registrar_movimentacao(uuid,text,uuid,uuid,timestamptz,text,uuid);

drop table if exists public.fotos_vistoria;
drop table if exists public.vistorias;
drop table if exists public.movimentacoes;
drop table if exists public.veiculos;
drop table if exists public.destinos;
drop table if exists public.portarias;
drop table if exists public.perfis_usuario;
drop table if exists public.logs_auditoria;
drop table if exists public.rate_limits;

drop schema if exists app cascade;
