# Paris Dakar Controle

Sistema offline-first de controle de frota (Supabase). Veículos passam por
**portarias** e vão a **destinos**; a regra central é que um carro nunca pode
estar em dois lugares ao mesmo tempo, garantida por trava no banco.

Projeto Supabase: `https://jjjvieragarzplulikbv.supabase.co`
(o histórico de decisões desta implementação está em [`docs/CONVERSA.md`](docs/CONVERSA.md)).

## Stack

Postgres (Supabase) · Supabase Auth · Supabase Storage · Supabase Realtime ·
Edge Functions (Deno) · PWA vanilla JS (zero framework, zero build step).

## Estrutura

```
supabase/migrations/      SQL versionado: schema, RLS, RPC de negócio, trigger de signup
supabase/migrations/down/ reversão (apaga dados — só dev)
supabase/functions/       Edge Functions: movimentacoes, vistorias, importar-veiculos, usuarios
supabase/seed.sql         portarias, destinos e dado de exemplo
frontend/                 PWA (login, painel, movimentações, vistoria, veículos, cadastros, importação, usuários)
scripts/                  criar-master.mjs, importar-planilha.mjs, servir-frontend.mjs
tests/run.mjs             testes de integração contra o Supabase (anti-duplicidade, RLS, vistoria, rate limit)
docs/CONVERSA.md          decisões tomadas durante a construção do projeto
```

## Instalação

```bash
cp .env.example .env
# preencha SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
# (Project Settings → API no painel do Supabase)

supabase link --project-ref jjjvieragarzplulikbv
supabase db push                          # aplica as migrations
supabase db execute -f supabase/seed.sql  # portarias, destinos, veículo de exemplo
npm run deploy:functions                  # publica as Edge Functions
npm run criar-master                      # cria/promove o usuário MASTER
```

## Execução

```bash
npm run dev        # PWA em http://localhost:5173
npm run test        # testes de integração contra o projeto Supabase
npm run importar -- ./caminho/planilha.xls admin@empresa.com 'senha'

## Deploy na Vercel

O projeto está totalmente configurado para deploy automático na Vercel.

1. Conecte o repositório Git à Vercel.
2. Defina as Variáveis de Ambiente no painel da Vercel:
   - `SUPABASE_URL` = `https://jjjvieragarzplulikbv.supabase.co`
   - `SUPABASE_ANON_KEY` = `<sua-anon-key>`
3. O comando de build (`npm run build`) gerará o `frontend/config.js` dinamicamente durante o deploy.
4. Veja o passo a passo completo em [`docs/DEPLOY_VERCEL.md`](docs/DEPLOY_VERCEL.md).
```

## Primeiro acesso

1. `npm run criar-master` cria o usuário master (`SEED_MASTER_EMAIL` no `.env`,
   padrão `admin@empresa.com`) e imprime um link de definição de senha —
   a senha nunca é gerada nem transportada pelo servidor em texto puro.
2. Entre no PWA com esse usuário. Como MASTER você vê os menus "Portarias e
   destinos", "Importar planilha" e "Usuários".
3. Convide os usuários de manutenção pela tela "Usuários" — eles recebem
   e-mail de convite e definem a própria senha.

## Backup

Backups automáticos ficam no painel do Supabase (Database → Backups). Teste
o restore periodicamente — backup nunca restaurado não é backup, é esperança.
Para exportar manualmente: `supabase db dump -f backup.sql`.

## Segurança

RLS habilitada em toda tabela exposta pela API; a única porta de escrita para
`movimentacoes` e `vistorias` são as RPCs transacionais (`registrar_movimentacao`,
`decidir_movimentacao`, `registrar_vistoria`, `registrar_foto_vistoria`,
`importar_veiculos`) — nunca INSERT/UPDATE direto pelo cliente. Detalhes e
checklist completo em `docs/CONVERSA.md` (seção 3) e nas referências da skill
`engenharia-fullstack-segura` usada para construir este projeto.

**Vetor de Ataque:** cliente com a `anon key` (pública, está no bundle do PWA)
tenta inserir uma linha direto em `movimentacoes` via `POST /rest/v1/movimentacoes`,
pulando a trava anti-duplicidade que só existe na RPC.

**Defesa Aplicada:** RLS na tabela só tem policies de `SELECT`/`DELETE`; sem
policy de `INSERT`, o PostgREST recusa a escrita por padrão (sem política =
sem acesso). A escrita só acontece via `SECURITY DEFINER` com o índice único
parcial `idx_veiculo_pendente` como garantia final no nível do banco.
