import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

/**
 * Cliente que repassa o JWT do usuário. Resultado: RLS e auth.uid() continuam
 * valendo dentro da Edge Function. Nunca use service_role aqui — ela ignora RLS
 * por completo e transforma qualquer bug de autorização em vazamento total.
 */
export function clienteDoUsuario(req: Request): SupabaseClient {
  const authorization = req.headers.get("Authorization") ?? "";
  return createClient(URL_SUPABASE, ANON, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function usuarioAutenticado(sb: SupabaseClient) {
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}
