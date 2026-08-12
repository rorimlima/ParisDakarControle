// =====================================================================
// Utilitários de UI.
// REGRA: todo dado vindo do banco passa por esc() antes de ir para o HTML.
// A tag `html` faz isso automaticamente na interpolação — usar innerHTML
// com string crua é como o XSS entra.
// =====================================================================

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Template tag que escapa toda interpolação. Use `bruto()` para trechos já seguros. */
export function html(partes, ...valores) {
  return partes.reduce((acc, parte, i) => {
    const v = valores[i - 1];
    const seguro = v && v.__bruto ? v.valor : esc(v);
    return acc + seguro + parte;
  });
}
export const bruto = (valor) => ({ __bruto: true, valor });

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

export function avisar(mensagem, tipo = "info", ms = 5000) {
  const caixa = document.getElementById("avisos");
  const el = document.createElement("div");
  el.className = "aviso";
  el.dataset.t = tipo;
  el.textContent = mensagem;             // textContent: nunca interpreta HTML
  caixa.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const esqueleto = (n = 4) =>
  Array.from({ length: n }, () => '<div class="esqueleto"></div>').join("");

export const vazio = (texto, acaoHtml = "") =>
  `<div class="vazio"><p>${esc(texto)}</p>${acaoHtml}</div>`;

export const falha = (texto) =>
  `<div class="falha"><p>${esc(texto)}</p>
   <button class="secundario auto" data-recarregar>Tentar de novo</button></div>`;

const FUSO = "America/Fortaleza";
export function dataHora(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export const ROTULO_STATUS = {
  DISPONIVEL: "Disponível", EM_TRANSITO: "Em trânsito",
  NA_PORTARIA: "Na portaria", NO_DESTINO: "No destino",
  PENDENTE: "Pendente", APROVADO: "Aprovado", REJEITADO: "Rejeitado",
};

export const ROTULO_TIPO = {
  ENTRADA_PORTARIA: "Entrada na portaria",
  SAIDA_PORTARIA: "Saída da portaria",
  CHEGADA_DESTINO: "Chegada ao destino",
  SAIDA_DESTINO: "Saída do destino",
};

export const TIPOS_FOTO = [
  "DIANTEIRA", "TRASEIRA", "LATERAL_ESQUERDA", "LATERAL_DIREITA",
  "INTERIOR", "PAINEL", "KM", "AVARIA",
];

export const NIVEIS = [
  ["", "—"], ["VAZIO", "Vazio"], ["UM_QUARTO", "1/4"], ["METADE", "1/2"],
  ["TRES_QUARTOS", "3/4"], ["CHEIO", "Cheio"],
];

/** Evita duplo clique: desabilita o botão enquanto a promessa não resolve. */
export async function comBotao(botao, fn) {
  if (!botao) return fn();
  const antes = botao.textContent;
  botao.disabled = true;
  botao.textContent = "Aguarde…";
  try { return await fn(); }
  finally { botao.disabled = false; botao.textContent = antes; }
}
