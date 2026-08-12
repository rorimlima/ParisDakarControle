#!/usr/bin/env node
// =====================================================================
// Servidor estático de desenvolvimento para o PWA (zero dependência).
// Gera /config.js a partir do .env com APENAS as chaves públicas
// (URL + anon key). Nada de service_role chega ao bundle.
//   node scripts/servir-frontend.mjs   ->  http://localhost:5173
// =====================================================================
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

function carregarEnv() {
  try {
    for (const linha of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* opcional */ }
}
carregarEnv();

const RAIZ = fileURLToPath(new URL("../frontend/", import.meta.url));
const PORTA = Number(process.env.PORTA ?? 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh",
  "connect-src 'self' https://*.supabase.co http://127.0.0.1:54321 http://localhost:54321 https://esm.sh wss://*.supabase.co ws://127.0.0.1:54321",
  "img-src 'self' data: blob: https://*.supabase.co http://127.0.0.1:54321",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SEGURANCA = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), geolocation=(), microphone=()",
};

const configJs = () => `// gerado em tempo de execução — só chaves públicas
export const CONFIG = {
  SUPABASE_URL: ${JSON.stringify(process.env.SUPABASE_URL ?? "http://127.0.0.1:54321")},
  SUPABASE_ANON_KEY: ${JSON.stringify(process.env.SUPABASE_ANON_KEY ?? "")}
};
`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);

  if (url.pathname === "/config.js") {
    res.writeHead(200, { ...SEGURANCA, "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(configJs());
  }

  let caminho = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  if (caminho === "/" || caminho === "\\") caminho = "/index.html";
  const arquivo = join(RAIZ, caminho);
  if (!arquivo.startsWith(RAIZ)) { res.writeHead(403); return res.end("proibido"); }

  try {
    const info = await stat(arquivo);
    if (info.isDirectory()) throw new Error("dir");
    const conteudo = await readFile(arquivo);
    res.writeHead(200, {
      ...SEGURANCA,
      "Content-Type": MIME[extname(arquivo)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(conteudo);
  } catch {
    // SPA: qualquer rota desconhecida cai no index
    const html = await readFile(join(RAIZ, "index.html"));
    res.writeHead(200, { ...SEGURANCA, "Content-Type": MIME[".html"] });
    res.end(html);
  }
}).listen(PORTA, () => console.log(`PWA em http://localhost:${PORTA}`));
