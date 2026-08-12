# Guia de Deploy na Vercel — Paris Dakar Controle

Este documento descreve como realizar o deploy da aplicação PWA **Paris Dakar Controle** na [Vercel](https://vercel.com).

---

## 1. O que foi configurado no projeto

- **`vercel.json`**: Define o diretório de saída (`frontend`), o comando de build (`npm run build`), rewrites de rotas para Single Page Application (SPA), cabeçalhos de segurança (CSP, Frame-Options, etc.) e regras de cache para `sw.js` e `config.js`.
- **`scripts/build-config.mjs`**: Script executado durante o build na Vercel para injetar dinamicamente a `SUPABASE_URL` e `SUPABASE_ANON_KEY` no arquivo `frontend/config.js` sem expor segredos.
- **`package.json`**: Adicionada a instrução `"build": "node scripts/build-config.mjs"`.
- **`.gitignore`**: `frontend/config.js` e `.vercel/` foram incluídos para garantir que arquivos de configuração gerados não sejam versionados no Git.

---

## 2. Passo a Passo do Deploy na Vercel

### Opção A: Pelo Painel Web da Vercel (Recomendado)

1. **Suba as alterações para o seu repositório Git** (GitHub, GitLab ou Bitbucket):
   ```bash
   git add .
   git commit -m "feat: configuracao para deploy na Vercel"
   git push origin main
   ```

2. **Importe o projeto na Vercel**:
   - Acesse [vercel.com/new](https://vercel.com/new).
   - Conecte sua conta do GitHub/GitLab.
   - Selecione o repositório **ParisDakarControle**.

3. **Configurações do Projeto**:
   - **Framework Preset**: Deixe como `Other`.
   - **Build Command**: `npm run build` (detectado automaticamente do `package.json`).
   - **Output Directory**: `frontend` (detectado do `vercel.json`).

4. **Variáveis de Ambiente (Environment Variables)**:
   Adicione as seguintes variáveis na seção **Environment Variables**:

   | Chave | Valor Exemplo / Descrição |
   |---|---|
   | `SUPABASE_URL` | `https://jjjvieragarzplulikbv.supabase.co` |
   | `SUPABASE_ANON_KEY` | *(copie do arquivo `.env` local ou do painel Supabase)* |

5. Clique em **Deploy**.

---

### Opção B: Pela CLI da Vercel (`vercel cli`)

Se preferir fazer deploy direto do terminal:

```bash
# 1. Instale a CLI globalmente (se necessário)
npm i -g vercel

# 2. Faça login
vercel login

# 3. Execute o deploy de preview
vercel

# 4. Para o deploy final de produção
vercel --prod
```

Ao rodar a CLI, adicione as variáveis quando solicitado ou configure no painel do projeto (`vercel env add SUPABASE_URL`).

---

## 3. Configurações Finais no Supabase (Obrigatório)

Após o deploy concluir e você obter a URL final da Vercel (ex: `https://paris-dakar-controle.vercel.app`):

### 1. Configurar URL do App e CORS nas Edge Functions
No terminal local, atualize as secrets do Supabase ou adicione no painel Supabase:

```bash
supabase secrets set ORIGENS_PERMITIDAS=http://localhost:5173,https://seu-projeto.vercel.app
supabase secrets set URL_APP=https://seu-projeto.vercel.app
```

### 2. Configurar Redirecionamento de Auth
No painel do Supabase:
- Vá em **Authentication** -> **URL Configuration**.
- **Site URL**: `https://seu-projeto.vercel.app`
- **Redirect URLs**: Adicione `https://seu-projeto.vercel.app/**`

---

## 4. Teste de Verificação

1. Acesse a URL da Vercel (`https://seu-projeto.vercel.app`).
2. Abra o DevTools (F12) -> Network -> Verifique se `/config.js` carrega com status `200`.
3. Verifique no console se a conexão com o Supabase foi estabelecida sem erros de CORS.
4. Teste a instalação do PWA e o funcionamento offline.
