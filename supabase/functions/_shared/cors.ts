// CORS com allowlist explícita. `*` junto de credencial é falha grave, então
// a origem só é ecoada se estiver em ORIGENS_PERMITIDAS.
const ORIGENS = (Deno.env.get("ORIGENS_PERMITIDAS") ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function cabecalhosCors(origem: string | null): Record<string, string> {
  const permitida = origem && ORIGENS.includes(origem) ? origem : ORIGENS[0];
  return {
    "Access-Control-Allow-Origin": permitida,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: cabecalhosCors(req.headers.get("origin")) });
}
