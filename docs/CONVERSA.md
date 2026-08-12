# Paris Dakar Controle — Registro da conversa e decisões

Este arquivo documenta a sessão que gerou este projeto: o pedido original, a
análise da planilha real, as decisões técnicas tomadas e os pontos que ainda
precisam de ação humana antes de ir para produção.

Projeto Supabase de destino: **https://jjjvieragarzplulikbv.supabase.co**

---

## 1. Pedido original

Sistema leve e **offline-first** de controle de frota sobre **Supabase**
(Postgres + Auth + Storage + Realtime + Edge Functions), com:

- Carros que transitam por **portarias** e vão para **destinos**.
- Regra crítica: **um carro não pode estar em dois lugares ao mesmo tempo**
  (trava anti-duplicidade de movimentação pendente).
- Vistoria com fotos **obrigatória** na portaria "Paris Dakar" antes da aprovação.
- Importação de planilha Excel mapeada por **nome de coluna**.
- Dois papéis: `MANUTENCAO` (só vê/edita o que criou) e `MASTER` (vê tudo).
- RLS em todas as tabelas — nunca confiar no client.
- Fila offline em IndexedDB, sincronizando em ordem quando a conexão volta.

A especificação completa está no PDF/markdown original fornecido pelo usuário
(seção "PARIS DAKAR CONTROLE: Sistema Offline-First de Controle de Frota").

## 2. Planilha real analisada (`Rel_MalaDireta.xls`)

Arquivo `.xls` (formato BIFF/OLE2, não xlsx), 213 linhas de dados, 48 colunas.
A leitura direta da planilha mudou três decisões de schema em relação à
especificação original:

| Achado na planilha | Impacto | Decisão tomada |
|---|---|---|
| 29 linhas com **placa vazia** (13% da frota) | `placa NOT NULL` rejeitaria essas linhas | `placa` ficou `nullable` + `UNIQUE` (Postgres permite múltiplos `NULL` num índice único) |
| 18 linhas com **chassi lixo**: `"11"`, `"13"`, `"18"`, `"9895"` — inclusive repetido entre carros diferentes | `chassi UNIQUE NOT NULL` quebraria por colisão | `chassi` ficou `nullable` + `UNIQUE` + `CHECK` de formato VIN (17 posições, sem `I`/`O`/`Q`). O importador grava `NULL` e devolve **aviso** na linha, sem abortar o lote |
| `cod_veiculo`: 0 vazios, 0 duplicados | É a única chave 100% confiável | Chave primária de deduplicação na importação; ordem de busca: `cod_veiculo` → `placa` → `chassi` |
| Coluna "Ano" no formato `"2025/2026"` | Precisa quebrar em fabricação/modelo | Parser por regex: `ano_fabricacao` = primeiros 4 dígitos, `ano_modelo` = os 4 dígitos após a barra (ou igual ao de fabricação se não houver barra) |

Critério de aceite verificado manualmente contra a linha real da planilha:
`FIAT - SEMINOVOS | ARGO DRIVE 1.0 | 9BD358ATSTYP70691 | TEX7D54 | 12959 | 2025/2026 | CINZA`
→ grava `cod_veiculo=12959`, `ano_fabricacao=2025`, `ano_modelo=2026`. Coberto
pelo teste `MASTER importa e grava ano_fabricacao/ano_modelo separados`.

## 3. Decisões de arquitetura e segurança

- **Camada de autorização = RLS.** A anon key é pública por design; a
  segurança do sistema inteiro está nas políticas do Postgres, não no frontend.
- **`movimentacoes` sem policy de INSERT/UPDATE.** A única porta de escrita é
  a RPC `registrar_movimentacao` / `decidir_movimentacao` (`SECURITY DEFINER`),
  porque só assim a trava anti-duplicidade roda em transação. Inserção direta
  pela API furaria a regra de negócio.
- **Trava anti-duplicidade em três camadas:**
  1. `SELECT ... FOR UPDATE` na linha do veículo → serializa transações concorrentes;
  2. checagem explícita de `PENDENTE` → mensagem legível com nome e hora;
  3. `CREATE UNIQUE INDEX ... WHERE status = 'PENDENTE'` → garantia física do
     banco; a segunda transação simultânea estoura `unique_violation`.
- **Vistoria obrigatória** verificada dentro da própria RPC de aprovação
  (`decidir_movimentacao`), não no frontend — checa se existe ao menos uma
  linha em `fotos_vistoria` vinculada à vistoria da movimentação.
- **Idempotência da fila offline:** cada operação carrega um `client_op_id`
  (uuid gerado no cliente); reenvio após timeout devolve o registro original
  em vez de duplicar.
- **Rate limit em transação própria.** Descoberta durante a implementação: se
  o contador fosse incrementado dentro da RPC de negócio, o `ROLLBACK` de uma
  tentativa recusada (ex.: `PD001`) desfaria também o incremento — tentativa
  recusada não contaria para o limite. Por isso as Edge Functions chamam
  `checar_limite(...)` **antes**, numa chamada RPC separada, cujo commit
  independe do resultado da operação seguinte.
- **Escalação de privilégio bloqueada em duas frentes:** trigger em
  `perfis_usuario` que rejeita mudança de `papel`/`ativo`/`colaborador_id` por
  quem não é MASTER, e o papel "de verdade" mora em `app_metadata` do Auth
  (só a `service_role` escreve), nunca em `user_metadata` (o usuário escreve).
- **Fotos de vistoria:** bucket privado, políticas de Storage por dono do
  registro, e a Edge Function confere os **magic bytes** do arquivo (JPEG/PNG/
  WebP) antes de registrar a foto — o `Content-Type` enviado pelo cliente não
  vale nada.
- **CORS com allowlist explícita** (`ORIGENS_PERMITIDAS`), nunca `*`.

## 4. Estrutura entregue

```
supabase/migrations/     01 schema · 02 RLS + Storage · 03 RPC de negócio · 04 perfil no signup
supabase/migrations/down/ script reversível (apaga dados — só dev, com confirmação)
supabase/functions/      movimentacoes · vistorias · importar-veiculos · usuarios · _shared/
supabase/seed.sql        portarias, destinos e o veículo do critério de aceite
frontend/                PWA vanilla JS, dark/light nativo, service worker, fila IndexedDB
scripts/                 criar-master.mjs · importar-planilha.mjs · servir-frontend.mjs
tests/run.mjs             18 testes de integração (anti-duplicidade, RLS, vistoria, rate limit)
docs/CONVERSA.md          este arquivo
```

## 5. O que EU NÃO fiz (e por quê) — ação necessária do usuário

Por limitação do ambiente onde rodo, não tenho como:

1. **Conectar ao projeto Supabase real** (`jjjvieragarzplulikbv.supabase.co`)
   para rodar as migrations — meu acesso de rede é restrito a um conjunto
   fixo de domínios (npm, pypi, github etc.) e `supabase.co` não está nele, e
   eu não tenho a senha do banco nem a `service_role key` do projeto.
2. **Escrever direto no disco do seu computador** — não tenho acesso ao
   sistema de arquivos da sua máquina, só ao ambiente isolado onde trabalho.
   Por isso entrego os arquivos como download; você (ou eu, na próxima
   mensagem, se preferir orientação passo a passo) precisa movê-los para
   `Área de Trabalho/PROJETOS/ParisDakarControle`.
3. **Validar as migrations executando-as** — tentei instalar um Postgres local
   neste ambiente para rodar `supabase db reset` antes de entregar, mas não
   consegui concluir a validação end-to-end nesta sessão. O SQL segue as
   convenções documentadas em `references/postgresql.md` e `supabase.md` da
   skill, mas **rode `npm run test` antes de confiar em produção**.

### Passos para colocar no ar

```bash
# 1) Preencha o .env (copie de .env.example) com:
#    SUPABASE_URL=https://jjjvieragarzplulikbv.supabase.co
#    SUPABASE_ANON_KEY=<Project Settings → API → anon public>
#    SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role — NUNCA no frontend>

# 2) Aplique as migrations (CLI do Supabase, ligado ao projeto)
supabase link --project-ref jjjvieragarzplulikbv
supabase db push

# 3) Rode o seed (portarias, destinos, veículo de exemplo)
supabase db execute -f supabase/seed.sql   # ou cole no SQL Editor do painel

# 4) Publique as Edge Functions
npm run deploy:functions

# 5) Crie o usuário master
npm run criar-master   # usa SEED_MASTER_EMAIL do .env (admin@empresa.com por padrão)

# 6) Rode os testes de integração contra o projeto real
npm run test

# 7) Suba o frontend localmente para testar
npm run dev             # http://localhost:5173
```

## 6. Pendências conhecidas para revisão humana antes de produção

- `ORIGENS_PERMITIDAS` está com `http://localhost:5173` por padrão — trocar
  para o domínio real de produção antes do deploy.
- `auth.enable_signup = false` em `supabase/config.toml`: cadastro só por
  convite do MASTER (via função `usuarios`). Confirme se é o comportamento
  desejado no projeto real (pode já estar diferente lá).
- Testes de integração (`tests/run.mjs`) criam e apagam usuários reais via
  Admin API — rode contra ambiente de homologação antes de produção.
- Revisar `references/seguranca.md` (checklist OWASP) uma última vez após o
  primeiro deploy real, com o painel do projeto em mãos.
