#!/usr/bin/env node
// =====================================================================
// Cria (ou promove) o usuário MASTER e imprime o link de definição de senha.
// Sem dependência externa: só fetch da Admin API.
//
//   node scripts/criar-master.mjs [email]
//
// A senha NUNCA é definida aqui. O usuário define no primeiro acesso pelo link.
// =====================================================================
import { readFileSync } from "node:fs";

function carregarEnv() {
  try {
    for (const linha of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* .env opcional: variáveis podem vir do ambiente */ }
}
carregarEnv();

const URL_SB = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.argv[2] || process.env.SEED_MASTER_EMAIL || "admin@empresa.com";
const APP = process.env.URL_APP || "http://localhost:5173";

if (!URL_SB || !SERVICE) {
  console.error("Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (veja .env.example).");
  process.exit(1);
}

const admin = (caminho, init = {}) =>
  fetch(`${URL_SB}${caminho}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

const senhaTemporaria = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

async function main() {
  const busca = await admin(`/auth/v1/admin/users?page=1&per_page=200`);
  const { users = [] } = await busca.json();
  let user = users.find((u) => (u.email || "").toLowerCase() === EMAIL.toLowerCase());

  if (!user) {
    const r = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: EMAIL,
        password: senhaTemporaria(),   // descartada: o acesso é pelo link abaixo
        email_confirm: true,
        app_metadata: { papel: "MASTER" },
        user_metadata: { nome: "Administrador" },
      }),
    });
    if (!r.ok) { console.error("Falha ao criar usuário:", await r.text()); process.exit(1); }
    user = await r.json();
    console.log(`Usuário master criado: ${EMAIL}`);
  } else {
    const r = await admin(`/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ app_metadata: { papel: "MASTER" } }),
    });
    if (!r.ok) { console.error("Falha ao promover:", await r.text()); process.exit(1); }
    console.log(`Usuário existente promovido a MASTER: ${EMAIL}`);
  }

  // Garante o perfil como MASTER mesmo se o trigger tiver rodado antes.
  await fetch(`${URL_SB}/rest/v1/perfis_usuario?id=eq.${user.id}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify({ papel: "MASTER", ativo: true, nome: "Administrador" }),
  });

  const link = await admin("/auth/v1/admin/generate_link", {
    method: "POST",
    body: JSON.stringify({ type: "recovery", email: EMAIL, redirect_to: APP }),
  });
  if (link.ok) {
    const { action_link } = await link.json();
    console.log("\nDefina a senha no primeiro acesso por este link:\n" + action_link + "\n");
  } else {
    console.log("\nUsuário pronto. Use 'Esqueci minha senha' na tela de login para definir a senha.\n");
  }
}

main().catch((e) => { console.error("Erro:", e.message); process.exit(1); });
