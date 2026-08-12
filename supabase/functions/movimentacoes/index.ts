// =====================================================================
// POST /functions/v1/movimentacoes
//   { acao: "registrar", veiculo_id, tipo, portaria_id?, destino_id?, ... }
//   { acao: "decidir",   movimentacao_id, decisao, observacoes? }
//
// A função é uma casca fina: valida a entrada e delega para a RPC, que roda
// a trava anti-duplicidade em transação. A regra não pode viver aqui — duas
// instâncias da Edge Function não compartilham estado; o banco sim.
// =====================================================================
import { preflight } from "../_shared/cors.ts";
import { ok, erro, erroDoBanco, corpoJson } from "../_shared/http.ts";
import { clienteDoUsuario, usuarioAutenticado } from "../_shared/auth.ts";
import { schemaMovimentacoes, validar } from "../_shared/schemas.ts";
import { limitar } from "../_shared/ratelimit.ts";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return erro(req, "METODO_INVALIDO", "Use POST.", 405);

  let corpo: unknown;
  try {
    corpo = await corpoJson(req, 64 * 1024);
  } catch {
    return erro(req, "ENTRADA_INVALIDA", "Corpo inválido.", 400);
  }

  const v = validar(schemaMovimentacoes, corpo);
  if (!v.ok) return erro(req, "ENTRADA_INVALIDA", v.mensagem, 400);

  const sb = clienteDoUsuario(req);
  const usuario = await usuarioAutenticado(sb);
  if (!usuario) return erro(req, "NAO_AUTENTICADO", "Faça login novamente.", 401);

  const limite = await limitar(sb, "movimentacoes", 60, 60);
  if (limite) return erro(req, limite.code, limite.message, 429);

  if (v.valor.acao === "registrar") {
    const p = v.valor;
    const { data, error } = await sb.rpc("registrar_movimentacao", {
      p_veiculo_id: p.veiculo_id,
      p_tipo: p.tipo,
      p_portaria_id: p.portaria_id ?? null,
      p_destino_id: p.destino_id ?? null,
      p_data_hora: p.data_hora ?? null,
      p_observacoes: p.observacoes ?? null,
      p_client_op_id: p.client_op_id ?? null,
    });
    if (error) return erroDoBanco(req, error);
    return ok(req, data, 201);
  }

  const p = v.valor;
  const { data, error } = await sb.rpc("decidir_movimentacao", {
    p_movimentacao_id: p.movimentacao_id,
    p_decisao: p.decisao,
    p_observacoes: p.observacoes ?? null,
  });
  if (error) return erroDoBanco(req, error);
  return ok(req, data);
});
