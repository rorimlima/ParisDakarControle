import { cabecalhosCors } from "./cors.ts";

// SQLSTATE customizado -> HTTP. Definidos em 20260812120200_rpc.sql.
const MAPA_SQLSTATE: Record<string, number> = {
  PD001: 409, // movimentação pendente
  PD002: 422, // vistoria obrigatória
  PD003: 403,
  PD004: 404,
  PD005: 409,
  PD006: 429,
  PD007: 400,
  "23505": 409, // unique_violation
  "23503": 409, // foreign_key_violation
  "42501": 403, // insufficient_privilege
};

export function ok(req: Request, dados: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: dados }), {
    status,
    headers: { ...cabecalhosCors(req.headers.get("origin")), "Content-Type": "application/json" },
  });
}

export function erro(req: Request, code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...cabecalhosCors(req.headers.get("origin")), "Content-Type": "application/json" },
  });
}

/**
 * Traduz erro do Postgres para o envelope público.
 * A mensagem das exceções PDxxx é escrita para o usuário final; qualquer outro
 * erro vira mensagem genérica — stack trace, SQL e nome de tabela não saem daqui.
 */
export function erroDoBanco(req: Request, e: { code?: string; message?: string }): Response {
  const code = e?.code ?? "";
  const status = MAPA_SQLSTATE[code];
  if (status) {
    const bruta = e.message ?? "";
    const msg = bruta.includes(":") ? bruta.slice(bruta.indexOf(":") + 1).trim() : bruta;
    return erro(req, code, msg || "Operação não permitida.", status);
  }
  console.error("erro_interno", { code, message: e?.message }); // log completo no servidor
  return erro(req, "ERRO_INTERNO", "Não foi possível concluir a operação. Tente novamente.", 500);
}

export async function corpoJson(req: Request, limiteBytes = 8 * 1024 * 1024): Promise<unknown> {
  const tamanho = Number(req.headers.get("content-length") ?? "0");
  if (tamanho > limiteBytes) throw new Error("PAYLOAD_GRANDE");
  const texto = await req.text();
  if (texto.length > limiteBytes) throw new Error("PAYLOAD_GRANDE");
  return texto ? JSON.parse(texto) : {};
}
