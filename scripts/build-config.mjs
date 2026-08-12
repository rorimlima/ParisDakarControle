#!/usr/bin/env node
// =====================================================================
// Script de Build para Vercel / Hosts Estáticos.
// Gera /frontend/config.js lendo SUPABASE_URL e SUPABASE_ANON_KEY
// das variáveis de ambiente do processo.
// =====================================================================
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function carregarEnvLocal() {
  try {
    const envPath = fileURLToPath(new URL("../.env", import.meta.url));
    if (existsSync(envPath)) {
      const conteudo = readFileSync(envPath, "utf8");
      for (const linha of conteudo.split("\n")) {
        const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    // se não houver .env, usa apenas as variáveis já presentes no process.env
  }
}

carregarEnvLocal();

const url = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const key = process.env.SUPABASE_ANON_KEY || "";

const conteudoConfig = `// Gerado automaticamente durante o build — apenas chaves públicas (RLS garante segurança)
export const CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url)},
  SUPABASE_ANON_KEY: ${JSON.stringify(key)}
};
`;

const caminhoDestino = fileURLToPath(new URL("../frontend/config.js", import.meta.url));
writeFileSync(caminhoDestino, conteudoConfig, "utf8");

console.log("✓ [BUILD] frontend/config.js gerado com sucesso.");
