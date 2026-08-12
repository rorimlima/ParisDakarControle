// =====================================================================
// Bootstrap do PWA: sessão, rotas, realtime, conexão e fila.
// A UI esconde o que o usuário não pode usar por conveniência — a
// autorização de verdade está na RLS e nas RPC. Esconder botão não protege.
// =====================================================================
import { sb } from "/src/supabase.js";
import * as api from "/src/api.js";
import * as fila from "/src/fila.js";
import { $, $$, avisar, html, esc } from "/src/ui.js";
import { PAGINAS, telaLogin } from "/src/paginas.js";

export const estado = {
  perfil: null,
  veiculos: [],
  portarias: [],
  destinos: [],
  rota: "painel",
  sincronizando: false,
};

// ------------------------------------------------------------ conexão
function pintarConexao(texto) {
  const el = $("#indicador-conexao");
  if (!el) return;
  const estadoConexao = texto ?? (navigator.onLine ? "online" : "offline");
  el.dataset.estado = estadoConexao;
  el.textContent = estadoConexao;
}

async function sincronizarAgora() {
  if (estado.sincronizando || !navigator.onLine || !estado.perfil) return;
  const pendentes = await fila.listarFila();
  if (pendentes.length === 0) return;

  estado.sincronizando = true;
  pintarConexao("sincronizando");
  try {
    const r = await api.sincronizar();
    if (r.enviados) avisar(`${r.enviados} operação(ões) sincronizada(s).`, "ok");
    if (r.conflitos) {
      avisar(`${r.conflitos} operação(ões) recusada(s) pela regra do sistema. Veja "Movimentações".`, "alerta", 9000);
    }
    if (estado.rota === "movimentacoes" || estado.rota === "painel") await renderizar();
  } finally {
    estado.sincronizando = false;
    pintarConexao();
  }
}

window.addEventListener("online", () => { pintarConexao(); sincronizarAgora(); });
window.addEventListener("offline", () => pintarConexao());
navigator.serviceWorker?.addEventListener?.("message", (e) => {
  if (e.data?.tipo === "SINCRONIZAR") sincronizarAgora();
});

// -------------------------------------------------------------- rotas
function rotaAtual() {
  const bruta = (location.hash || "#/painel").replace(/^#\//, "").split("/")[0];
  return PAGINAS[bruta] ? bruta : "painel";
}

export async function renderizar() {
  const alvo = $("#conteudo");
  if (!estado.perfil) {
    return mostrarLogin();
  }

  estado.rota = rotaAtual();

  const pagina = PAGINAS[estado.rota];
  if (pagina.somenteMaster && estado.perfil?.papel !== "MASTER") {
    alvo.innerHTML = '<div class="falha"><p>Área restrita ao usuário master.</p></div>';
    return;
  }

  $$(".lateral a").forEach((a) =>
    a.setAttribute("aria-current", a.dataset.rota === estado.rota ? "page" : "false"));

  try {
    await pagina.render(alvo, estado);
  } catch (e) {
    console.error(e);
    alvo.innerHTML = `<div class="falha"><p>${esc(e.message || "Falha ao carregar a tela.")}</p>
      <button class="secundario auto" data-recarregar>Tentar de novo</button></div>`;
  }
}

window.addEventListener("hashchange", () => {
  if (window.innerWidth <= 800) {
    $("#nav").hidden = true;
    const backdrop = $("#menu-backdrop");
    if (backdrop) backdrop.hidden = true;
  }
  if (!estado.perfil) {
    mostrarLogin();
  } else {
    renderizar();
  }
});

document.addEventListener("click", (e) => {
  if (e.target.matches("[data-recarregar]")) renderizar();
});

// As páginas pedem recarga por evento (e não importando app.js) para não
// criar dependência circular entre os módulos.
document.addEventListener("pd:recarregar", async (e) => {
  if (e.detail?.recarregarBase) {
    const { dados } = await api.listarVeiculos();
    estado.veiculos = dados;
  }
  renderizar();
});

// ----------------------------------------------------------- realtime
let canal = null;
function ligarRealtime() {
  if (canal) return;
  canal = sb.channel("frota")
    .on("postgres_changes", { event: "*", schema: "public", table: "movimentacoes" }, async () => {
      if (["painel", "movimentacoes"].includes(estado.rota)) await renderizar();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "veiculos" }, async () => {
      const { dados } = await api.listarVeiculos();
      estado.veiculos = dados;
      if (["painel", "veiculos"].includes(estado.rota)) await renderizar();
    })
    .subscribe();
}

// --------------------------------------------------------------- boot
async function carregarBase() {
  const [v, p, d] = await Promise.all([
    api.listarVeiculos(), api.listarPortarias(), api.listarDestinos(),
  ]);
  estado.veiculos = v.dados; estado.portarias = p.dados; estado.destinos = d.dados;
  if (v.doCache || p.doCache) avisar("Exibindo dados salvos neste aparelho.", "alerta");
}

async function entrarNoApp() {
  estado.perfil = await api.perfilAtual();
  if (!estado.perfil) {
    document.body.dataset.autenticado = "false";
    avisar("Seu usuário não tem perfil ativo. Procure o administrador.", "erro", 9000);
    await sb.auth.signOut();
    return mostrarLogin();
  }

  document.body.dataset.autenticado = "true";
  $("#topo").hidden = false;
  $("#nav").hidden = window.innerWidth <= 800;
  $$("[data-master]").forEach((el) => { el.hidden = estado.perfil.papel !== "MASTER"; });

  await carregarBase();
  ligarRealtime();
  pintarConexao();
  await renderizar();
  sincronizarAgora();
}

function mostrarLogin() {
  document.body.dataset.autenticado = "false";
  $("#topo").hidden = true;
  $("#nav").hidden = true;
  telaLogin($("#conteudo"));
}

// --------------------------------------------------------- interações
$("#btn-tema").addEventListener("click", () => {
  const escuro = document.documentElement.getAttribute("data-theme") === "dark";
  const novo = escuro ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", novo);
  try { localStorage.setItem("tema", novo); } catch { /* modo privado */ }
});

function alternarMenu(forcarEsconder = null) {
  const nav = $("#nav");
  const backdrop = $("#menu-backdrop");
  const esconder = forcarEsconder !== null ? forcarEsconder : !nav.hidden;
  nav.hidden = esconder;
  if (backdrop) backdrop.hidden = esconder;
  const btn = $("#btn-menu");
  if (btn) btn.setAttribute("aria-expanded", String(!esconder));
}

$("#btn-menu").addEventListener("click", () => alternarMenu());
$("#menu-backdrop")?.addEventListener("click", () => alternarMenu(true));

$("#btn-sair").addEventListener("click", async () => {
  const restantes = (await fila.listarFila()).length;
  if (restantes && !confirm(`Há ${restantes} operação(ões) na fila offline. Sair mesmo assim?`)) return;
  await sb.auth.signOut();
  await fila.limparTudo();   // dado de outro usuário não pode sobrar no aparelho
  location.hash = "#/painel";
  location.reload();
});


sb.auth.onAuthStateChange((evento, sessao) => {
  if (evento === "SIGNED_OUT" || !sessao) return mostrarLogin();
  if (["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(evento) && !estado.perfil) {
    entrarNoApp().catch((e) => avisar(e.message, "erro"));
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {/* offline degrada, não quebra */});
}

setInterval(sincronizarAgora, 30_000);

(async function iniciar() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await entrarNoApp(); else mostrarLogin();
})();

export { sincronizarAgora, html };
