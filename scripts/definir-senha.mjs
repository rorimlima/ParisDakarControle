import { readFileSync } from "node:fs";

for (const linha of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const URL_SB = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.argv[2] || process.env.SEED_MASTER_EMAIL || "onaeror@gmail.com";
const SENHA = process.argv[3] || "1987";

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

async function main() {
  const busca = await admin(`/auth/v1/admin/users?page=1&per_page=200`);
  const { users = [] } = await busca.json();
  const user = users.find((u) => (u.email || "").toLowerCase() === EMAIL.toLowerCase());
  if (!user) {
    console.error("Usuário não encontrado:", EMAIL);
    process.exit(1);
  }

  const r = await admin(`/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    body: JSON.stringify({ password: SENHA, email_confirm: true }),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error("Erro ao definir senha:", err);
    process.exit(1);
  }

  console.log(`Senha atualizada com sucesso para ${EMAIL}!`);
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
