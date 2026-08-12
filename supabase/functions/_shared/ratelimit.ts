import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

/**
 * Consome uma unidade do limite ANTES da operação, em requisição separada —
 * logo, em transação própria. Se o limite fosse consumido dentro da RPC de
 * negócio, o rollback da exceção apagaria o contador e tentativa recusada
 * não contaria (é assim que brute force passa despercebido).
 *
 * Retorna a Response de erro (429) quando estourou, ou null quando liberou.
 */
export async function limitar(
  sb: SupabaseClient,
  recurso: string,
  limite: number,
  janelaSegundos: number,
): Promise<{ code: string; message: string } | null> {
  const { error } = await sb.rpc("checar_limite", {
    p_recurso: recurso,
    p_limite: limite,
    p_janela_segundos: janelaSegundos,
  });
  if (!error) return null;
  if (error.code === "PD006") {
    return { code: "PD006", message: "Muitas requisições. Aguarde um instante." };
  }
  // Falha do próprio limitador não deve derrubar a operação: registra e segue.
  console.error("falha_rate_limit", error.code, error.message);
  return null;
}
