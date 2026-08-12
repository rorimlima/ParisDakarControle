// =====================================================================
// POST /functions/v1/usuarios  — criação/desativação de usuário (só MASTER)
//   { acao: "criar",   email, nome, papel, colaborador_id? }
//   { acao: "definir_papel", usuario_id, papel }
//   { acao: "ativar" | "desativar", usuario_id }
//
// Esta é a ÚNICA função que usa service_role, porque a Admin API do Auth
// exige. O papel do chamador é conferido antes, com o JWT dele.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { z } from "https://esm.sh/zod@3.23.8";
import { preflight } from "../_shared/cors.ts";
import { ok, erro, erroDoBanco, corpoJson } from "../_shared/http.ts";
import { clienteDoUsuario, usuarioAutenticado } from "../_shared/auth.ts";
import { validar } from "../_shared/schemas.ts";
import { limitar } from "../_shared/ratelimit.ts";

const schema = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("criar"),
    email: z.string().email().max(200),
    nome: z.string().min(2).max(120),
    papel: z.enum(["MASTER", "MANUTENCAO"]),
    colaborador_id: z.string().uuid().nullish(),
  }),
  z.object({
    acao: z.literal("definir_papel"),
    usuario_id: z.string().uuid(),
    papel: z.enum(["MASTER", "MANUTENCAO"]),
  }),
  z.object({
    acao: z.enum(["ativar", "desativar"]),
    usuario_id: z.string().uuid(),
  }),
]);

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return erro(req, "METODO_INVALIDO", "Use POST.", 405);

  let corpo: unknown;
  try {
    corpo = await corpoJson(req, 32 * 1024);
  } catch {
    return erro(req, "ENTRADA_INVALIDA", "Corpo inválido.", 400);
  }
  const v = validar(schema, corpo);
  if (!v.ok) return erro(req, "ENTRADA_INVALIDA", v.mensagem, 400);

  const sb = clienteDoUsuario(req);
  const usuario = await usuarioAutenticado(sb);
  if (!usuario) return erro(req, "NAO_AUTENTICADO", "Faça login novamente.", 401);

  // Autorização com o JWT do chamador, ANTES de tocar na service_role.
  const { data: perfil } = await sb
    .from("perfis_usuario").select("papel, ativo").eq("id", usuario.id).maybeSingle();
  if (!perfil || perfil.papel !== "MASTER" || !perfil.ativo) {
    return erro(req, "PERMISSAO_NEGADA", "Ação restrita ao usuário master.", 403);
  }

  const limite = await limitar(sb, "usuarios", 20, 60);
  if (limite) return erro(req, limite.code, limite.message, 429);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const p = v.valor;

  if (p.acao === "criar") {
    // Convite por e-mail: a senha é definida pelo próprio usuário no primeiro
    // acesso. Servidor nunca gera nem transporta senha em texto.
    const { data, error } = await admin.auth.admin.inviteUserByEmail(p.email, {
      data: { nome: p.nome },
      redirectTo: Deno.env.get("URL_APP") ?? undefined,
    });
    if (error) {
      console.error("falha_convite", error.message);
      return erro(req, "FALHA_CONVITE", "Não foi possível convidar este e-mail.", 409);
    }
    const novoId = data.user!.id;
    await admin.auth.admin.updateUserById(novoId, { app_metadata: { papel: p.papel } });
    const { error: e2 } = await admin.from("perfis_usuario")
      .update({ nome: p.nome, papel: p.papel, colaborador_id: p.colaborador_id ?? null })
      .eq("id", novoId);
    if (e2) return erroDoBanco(req, e2);
    return ok(req, { id: novoId, email: p.email, papel: p.papel }, 201);
  }

  if (p.acao === "definir_papel") {
    if (p.usuario_id === usuario.id) {
      return erro(req, "OPERACAO_INVALIDA", "Você não pode alterar o próprio papel.", 409);
    }
    await admin.auth.admin.updateUserById(p.usuario_id, { app_metadata: { papel: p.papel } });
    const { error } = await admin.from("perfis_usuario")
      .update({ papel: p.papel }).eq("id", p.usuario_id);
    if (error) return erroDoBanco(req, error);
    return ok(req, { usuario_id: p.usuario_id, papel: p.papel });
  }

  if (p.usuario_id === usuario.id) {
    return erro(req, "OPERACAO_INVALIDA", "Você não pode desativar a si mesmo.", 409);
  }
  const ativo = p.acao === "ativar";
  const { error } = await admin.from("perfis_usuario").update({ ativo }).eq("id", p.usuario_id);
  if (error) return erroDoBanco(req, error);
  return ok(req, { usuario_id: p.usuario_id, ativo });
});
