// =====================================================================
// POST /functions/v1/vistorias
//   { acao: "registrar",      movimentacao_id, km?, nivel_combustivel?, ... }
//   { acao: "registrar_foto", vistoria_id, tipo, url }
//
// O upload do binário vai direto do cliente para o Storage (bucket privado,
// policies por dono, limite de tamanho e mime no servidor do Storage).
// Aqui validamos os MAGIC BYTES do objeto antes de registrar a foto: extensão
// e Content-Type são declarados pelo cliente e não valem nada.
// =====================================================================
import { preflight } from "../_shared/cors.ts";
import { ok, erro, erroDoBanco, corpoJson } from "../_shared/http.ts";
import { clienteDoUsuario, usuarioAutenticado } from "../_shared/auth.ts";
import { schemaVistoria, validar } from "../_shared/schemas.ts";
import { limitar } from "../_shared/ratelimit.ts";

const ASSINATURAS: Array<{ nome: string; bytes: number[] }> = [
  { nome: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { nome: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { nome: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP
];

function assinaturaValida(buf: Uint8Array): boolean {
  const casa = (bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  if (casa(ASSINATURAS[0].bytes) || casa(ASSINATURAS[1].bytes)) return true;
  if (casa(ASSINATURAS[2].bytes)) {
    return buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return false;
}

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

  const v = validar(schemaVistoria, corpo);
  if (!v.ok) return erro(req, "ENTRADA_INVALIDA", v.mensagem, 400);

  const sb = clienteDoUsuario(req);
  const usuario = await usuarioAutenticado(sb);
  if (!usuario) return erro(req, "NAO_AUTENTICADO", "Faça login novamente.", 401);

  const limite = await limitar(sb, "vistorias", 120, 60);
  if (limite) return erro(req, limite.code, limite.message, 429);

  if (v.valor.acao === "registrar") {
    const p = v.valor;
    const { data, error } = await sb.rpc("registrar_vistoria", {
      p_movimentacao_id: p.movimentacao_id,
      p_km: p.km ?? null,
      p_nivel_combustivel: p.nivel_combustivel ?? null,
      p_observacoes: p.observacoes ?? null,
      p_client_op_id: p.client_op_id ?? null,
    });
    if (error) return erroDoBanco(req, error);
    return ok(req, data, 201);
  }

  const p = v.valor;

  // O caminho tem que estar na pasta da própria vistoria (a RPC recusa também).
  if (!p.url.startsWith(`${p.vistoria_id}/`)) {
    return erro(req, "ENTRADA_INVALIDA", "Caminho fora da pasta da vistoria.", 400);
  }

  // Lê só o cabeçalho do arquivo. A URL assinada é gerada com o JWT do usuário,
  // então a policy do Storage já barra objeto de terceiro.
  const { data: assinada, error: erroUrl } = await sb.storage
    .from("vistorias")
    .createSignedUrl(p.url, 60);
  if (erroUrl || !assinada?.signedUrl) {
    return erro(req, "NAO_ENCONTRADO", "Arquivo não encontrado no Storage.", 404);
  }

  const resp = await fetch(assinada.signedUrl, { headers: { Range: "bytes=0-15" } });
  if (!resp.ok && resp.status !== 206) {
    return erro(req, "NAO_ENCONTRADO", "Arquivo não encontrado no Storage.", 404);
  }
  const cabecalho = new Uint8Array(await resp.arrayBuffer());

  if (!assinaturaValida(cabecalho)) {
    await sb.storage.from("vistorias").remove([p.url]); // não deixa lixo/payload no bucket
    return erro(req, "ARQUIVO_INVALIDO", "Envie uma imagem JPEG, PNG ou WebP.", 422);
  }

  const { data, error } = await sb.rpc("registrar_foto_vistoria", {
    p_vistoria_id: p.vistoria_id,
    p_tipo: p.tipo,
    p_url: p.url,
  });
  if (error) return erroDoBanco(req, error);
  return ok(req, data, 201);
});
