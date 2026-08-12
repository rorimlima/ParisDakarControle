-- =====================================================================
-- Paris Dakar Controle — 01 | Schema base
-- Tabelas, constraints, índices, triggers.
-- Reversível por: migrations/down/20260812120000_init_schema.down.sql
-- =====================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- busca por placa/modelo (ILIKE)

-- Schema interno: NÃO exposto pelo PostgREST. Helpers de autorização vivem aqui
-- para não virarem endpoint público.
create schema if not exists app;
revoke all on schema app from anon, authenticated;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Trigger genérico de atualizado_em
-- ---------------------------------------------------------------------
create or replace function app.tg_atualizado_em()
returns trigger
language plpgsql
set search_path = public, app
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- perfis_usuario
-- ---------------------------------------------------------------------
create table if not exists public.perfis_usuario (
  id             uuid primary key references auth.users(id) on delete cascade,
  nome           text not null check (length(btrim(nome)) between 2 and 120),
  papel          text not null check (papel in ('MASTER', 'MANUTENCAO')),
  colaborador_id uuid null,
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

-- FK opcional para a tabela `colaboradores` JÁ EXISTENTE.
-- Condicional: se a tabela não existir neste ambiente, a migration não quebra.
do $$
begin
  if to_regclass('public.colaboradores') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'colaboradores'
          and column_name = 'id' and data_type = 'uuid'
     )
     and not exists (
       select 1 from pg_constraint where conname = 'perfis_usuario_colaborador_id_fkey'
     )
  then
    execute 'alter table public.perfis_usuario
             add constraint perfis_usuario_colaborador_id_fkey
             foreign key (colaborador_id) references public.colaboradores(id)
             on delete set null';
  end if;
end;
$$;

drop trigger if exists tg_perfis_usuario_atualizado_em on public.perfis_usuario;
create trigger tg_perfis_usuario_atualizado_em
  before update on public.perfis_usuario
  for each row execute function app.tg_atualizado_em();

-- ---------------------------------------------------------------------
-- portarias
-- ---------------------------------------------------------------------
create table if not exists public.portarias (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null check (length(btrim(nome)) between 2 and 120),
  codigo         text not null unique check (codigo ~ '^[A-Z0-9_-]{2,30}$'),
  exige_vistoria boolean not null default false,
  ativo          boolean not null default true,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

drop trigger if exists tg_portarias_atualizado_em on public.portarias;
create trigger tg_portarias_atualizado_em
  before update on public.portarias
  for each row execute function app.tg_atualizado_em();

-- ---------------------------------------------------------------------
-- destinos
-- ---------------------------------------------------------------------
create table if not exists public.destinos (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (length(btrim(nome)) between 2 and 120),
  codigo        text not null unique check (codigo ~ '^[A-Z0-9_-]{2,30}$'),
  portaria_id   uuid null references public.portarias(id) on delete set null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_destinos_portaria on public.destinos(portaria_id);

drop trigger if exists tg_destinos_atualizado_em on public.destinos;
create trigger tg_destinos_atualizado_em
  before update on public.destinos
  for each row execute function app.tg_atualizado_em();

-- ---------------------------------------------------------------------
-- veiculos
--
-- DECISÕES sobre os dados reais da planilha Rel_MalaDireta.xls (213 linhas):
--  * cod_veiculo é a ÚNICA chave natural confiável (0 vazios, 0 duplicados)
--    -> UNIQUE NOT NULL.
--  * placa vem vazia em 29 linhas -> nullable + UNIQUE (Postgres permite
--    múltiplos NULL em índice único). Exigir NOT NULL rejeitaria 13% da frota.
--  * chassi vem lixo em 18 linhas ("11", "13", "18", "9895"...), com colisões
--    -> nullable + UNIQUE + CHECK de formato (17 alfanuméricos, sem I/O/Q).
--    O importador grava NULL e devolve aviso na linha em vez de abortar.
-- ---------------------------------------------------------------------
create table if not exists public.veiculos (
  id                uuid primary key default gen_random_uuid(),
  cod_veiculo       text not null unique check (length(btrim(cod_veiculo)) between 1 and 40),
  placa             text null unique check (placa is null or placa ~ '^[A-Z0-9]{7}$'),
  chassi            text null unique check (chassi is null or chassi ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  marca             text null,
  modelo            text null,
  cor               text null,
  ano_fabricacao    int null check (ano_fabricacao is null or ano_fabricacao between 1900 and 2100),
  ano_modelo        int null check (ano_modelo is null or ano_modelo between 1900 and 2100),
  status            text not null default 'DISPONIVEL'
                    check (status in ('DISPONIVEL','EM_TRANSITO','NA_PORTARIA','NO_DESTINO')),
  localizacao_atual uuid null,
  -- localizacao_atual aponta ora para portarias ora para destinos; sem essa
  -- coluna a UI teria que adivinhar em qual tabela procurar (e faria 2 queries).
  localizacao_tipo  text null check (localizacao_tipo in ('PORTARIA','DESTINO')),
  ativo             boolean not null default true,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  constraint veiculos_localizacao_coerente check (
    (localizacao_atual is null and localizacao_tipo is null)
    or (localizacao_atual is not null and localizacao_tipo is not null)
  )
);

create index if not exists idx_veiculos_status      on public.veiculos(status) where ativo;
create index if not exists idx_veiculos_localizacao on public.veiculos(localizacao_atual);
create index if not exists idx_veiculos_placa_trgm  on public.veiculos using gin (placa gin_trgm_ops);
create index if not exists idx_veiculos_modelo_trgm on public.veiculos using gin (modelo gin_trgm_ops);

drop trigger if exists tg_veiculos_atualizado_em on public.veiculos;
create trigger tg_veiculos_atualizado_em
  before update on public.veiculos
  for each row execute function app.tg_atualizado_em();

-- ---------------------------------------------------------------------
-- movimentacoes
-- ---------------------------------------------------------------------
create table if not exists public.movimentacoes (
  id            uuid primary key default gen_random_uuid(),
  veiculo_id    uuid not null references public.veiculos(id) on delete restrict,
  tipo          text not null check (tipo in
                  ('ENTRADA_PORTARIA','SAIDA_PORTARIA','CHEGADA_DESTINO','SAIDA_DESTINO')),
  portaria_id   uuid null references public.portarias(id) on delete restrict,
  destino_id    uuid null references public.destinos(id)  on delete restrict,
  usuario_id    uuid not null references auth.users(id)   on delete restrict,
  status        text not null default 'PENDENTE'
                check (status in ('PENDENTE','APROVADO','REJEITADO')),
  data_hora     timestamptz not null,
  observacoes   text null check (observacoes is null or length(observacoes) <= 1000),
  -- Idempotência da fila offline: o cliente gera o uuid; reenvio não duplica.
  client_op_id  uuid null unique,
  decidido_por  uuid null references auth.users(id) on delete set null,
  decidido_em   timestamptz null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint movimentacoes_local_coerente check (
    (tipo in ('ENTRADA_PORTARIA','SAIDA_PORTARIA') and portaria_id is not null and destino_id is null)
    or
    (tipo in ('CHEGADA_DESTINO','SAIDA_DESTINO')   and destino_id  is not null and portaria_id is null)
  ),
  constraint movimentacoes_decisao_coerente check (
    (status = 'PENDENTE' and decidido_em is null)
    or (status <> 'PENDENTE' and decidido_em is not null)
  )
);

-- TRAVA FÍSICA anti-duplicidade: no máximo UMA movimentação pendente por veículo.
-- Duas requisições simultâneas -> a segunda estoura unique_violation no banco.
create unique index if not exists idx_veiculo_pendente
  on public.movimentacoes (veiculo_id) where status = 'PENDENTE';

create index if not exists idx_mov_veiculo_data on public.movimentacoes(veiculo_id, data_hora desc);
create index if not exists idx_mov_usuario      on public.movimentacoes(usuario_id);   -- usado pela RLS
create index if not exists idx_mov_status       on public.movimentacoes(status) where status = 'PENDENTE';
create index if not exists idx_mov_portaria     on public.movimentacoes(portaria_id);
create index if not exists idx_mov_destino      on public.movimentacoes(destino_id);

drop trigger if exists tg_movimentacoes_atualizado_em on public.movimentacoes;
create trigger tg_movimentacoes_atualizado_em
  before update on public.movimentacoes
  for each row execute function app.tg_atualizado_em();

-- ---------------------------------------------------------------------
-- vistorias
-- ---------------------------------------------------------------------
create table if not exists public.vistorias (
  id               uuid primary key default gen_random_uuid(),
  movimentacao_id  uuid not null references public.movimentacoes(id) on delete cascade,
  veiculo_id       uuid not null references public.veiculos(id) on delete restrict,
  usuario_id       uuid not null references auth.users(id) on delete restrict,
  data_hora        timestamptz not null default now(),
  km               int null check (km is null or km between 0 and 3000000),
  nivel_combustivel text null check (nivel_combustivel in
                     ('VAZIO','UM_QUARTO','METADE','TRES_QUARTOS','CHEIO')),
  observacoes      text null check (observacoes is null or length(observacoes) <= 1000),
  client_op_id     uuid null unique,
  criado_em        timestamptz not null default now()
);

create unique index if not exists idx_vistoria_por_movimentacao
  on public.vistorias(movimentacao_id);
create index if not exists idx_vistorias_veiculo on public.vistorias(veiculo_id);
create index if not exists idx_vistorias_usuario on public.vistorias(usuario_id);

-- ---------------------------------------------------------------------
-- fotos_vistoria
-- ---------------------------------------------------------------------
create table if not exists public.fotos_vistoria (
  id          uuid primary key default gen_random_uuid(),
  vistoria_id uuid not null references public.vistorias(id) on delete cascade,
  tipo        text not null check (tipo in
                ('DIANTEIRA','TRASEIRA','LATERAL_ESQUERDA','LATERAL_DIREITA',
                 'INTERIOR','PAINEL','KM','AVARIA')),
  url         text not null check (length(url) between 3 and 500),
  criado_em   timestamptz not null default now(),
  unique (vistoria_id, url)
);

create index if not exists idx_fotos_vistoria on public.fotos_vistoria(vistoria_id);

-- ---------------------------------------------------------------------
-- logs_auditoria — ação sensível registrada, sem PII além do id do autor
-- ---------------------------------------------------------------------
create table if not exists public.logs_auditoria (
  id          bigint generated always as identity primary key,
  usuario_id  uuid null references auth.users(id) on delete set null,
  acao        text not null,
  entidade    text not null,
  entidade_id uuid null,
  dados       jsonb null,
  criado_em   timestamptz not null default now()
);

create index if not exists idx_logs_criado_em on public.logs_auditoria(criado_em desc);
create index if not exists idx_logs_entidade  on public.logs_auditoria(entidade, entidade_id);

-- ---------------------------------------------------------------------
-- rate_limits — contador por janela, compartilhado entre isolates das
-- Edge Functions (memória de isolate não serve: cada instância teria o seu).
-- ---------------------------------------------------------------------
create table if not exists public.rate_limits (
  chave         text not null,
  janela_inicio timestamptz not null,
  contador      int not null default 0,
  primary key (chave, janela_inicio)
);

create index if not exists idx_rate_limits_janela on public.rate_limits(janela_inicio);
