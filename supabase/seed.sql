-- =====================================================================
-- Paris Dakar Controle — seed idempotente
-- Rode quantas vezes quiser: usa ON CONFLICT em chave natural.
-- O usuário MASTER é criado por `npm run criar-master` (Admin API),
-- não aqui: senha em SQL versionado é segredo no código.
-- =====================================================================

insert into public.portarias (nome, codigo, exige_vistoria) values
  ('Paris Dakar',        'PARIS_DAKAR', true),
  ('PDV Veículos',       'PDV',         false),
  ('Portaria Oficina',   'OFICINA',     false)
on conflict (codigo) do update
  set nome = excluded.nome,
      exige_vistoria = excluded.exige_vistoria;

insert into public.destinos (nome, codigo, portaria_id) values
  ('Pátio Matriz',      'PATIO_MATRIZ', (select id from public.portarias where codigo = 'PARIS_DAKAR')),
  ('Loja PDV',          'LOJA_PDV',     (select id from public.portarias where codigo = 'PDV')),
  ('Oficina Mecânica',  'OFICINA_MEC',  (select id from public.portarias where codigo = 'OFICINA')),
  ('Lavagem',           'LAVAGEM',      null),
  ('Despachante',       'DESPACHANTE',  null),
  ('Cliente / Entrega', 'ENTREGA',      null)
on conflict (codigo) do update set nome = excluded.nome;

-- Veículo do critério de aceite (mesma linha da planilha real).
insert into public.veiculos
  (cod_veiculo, placa, chassi, marca, modelo, cor, ano_fabricacao, ano_modelo)
values
  ('12959', 'TEX7D54', '9BD358ATSTYP70691', 'FIAT - SEMINOVOS', 'ARGO DRIVE 1.0', 'CINZA', 2025, 2026)
on conflict (cod_veiculo) do nothing;
