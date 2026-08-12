#!/usr/bin/env node
// =====================================================================
// Importa uma planilha pela linha de comando, autenticando como MASTER.
//   node scripts/importar-planilha.mjs ./docs/Rel_MalaDireta.xls admin@empresa.com 'senha'
//
// O parse acontece na Edge Function (servidor). Aqui só se envia o arquivo.
// =====================================================================
import { readFileSync } from "node:fs";

function carregarEnv() {
  try {
    for (const linha of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* opcional */ }
}
carregarEnv();

const [, , caminho, email, senha] = process.argv;
const URL_SB = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

if (!caminho || !email || !senha || !URL_SB || !ANON) {
  console.error("uso: node scripts/importar-planilha.mjs <arquivo.xls> <email> <senha>");
  process.exit(1);
}

const login = await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: senha }),
});
if (!login.ok) { console.error("Login falhou."); process.exit(1); }
const { access_token } = await login.json();

const base64 = readFileSync(caminho).toString("base64");
const r = await fetch(`${URL_SB}/functions/v1/importar-veiculos`, {
  method: "POST",
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ arquivo_base64: base64, nome_arquivo: caminho.split("/").pop() }),
});

const corpo = await r.json();
if (!r.ok) { console.error("Falha:", corpo.error?.message ?? r.status); process.exit(1); }

const d = corpo.data;
console.log(`total: ${d.total} | importadas: ${d.importadas} | atualizadas: ${d.atualizadas}`);
console.log(`avisos: ${d.avisos.length} | erros: ${d.erros.length}`);
for (const e of d.erros.slice(0, 20)) console.log(`  erro linha ${e.linha} (${e.cod_veiculo}): ${e.motivo}`);
for (const a of d.avisos.slice(0, 20)) console.log(`  aviso linha ${a.linha} (${a.cod_veiculo}): ${a.aviso}`);
