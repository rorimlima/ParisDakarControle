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

