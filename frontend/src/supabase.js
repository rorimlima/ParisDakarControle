import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { CONFIG } from "/config.js";

// A anon key é pública por design: a segurança vem da RLS, não do sigilo dela.
// Nenhum segredo de servidor pode aparecer neste arquivo — tudo aqui vai para
// o navegador do usuário.
export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
  realtime: { params: { eventsPerSecond: 5 } },
});

export const URL_FUNCOES = `${CONFIG.SUPABASE_URL}/functions/v1`;
