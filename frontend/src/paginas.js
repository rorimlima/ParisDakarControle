// =====================================================================
// Telas. Todo dado do banco passa por esc() antes de virar HTML.
// Toda tela de dado tem os quatro estados: carregando, vazio, erro, sucesso.
// =====================================================================
import { sb } from "/src/supabase.js";
import * as api from "/src/api.js";
import * as fila from "/src/fila.js";
import {
  $, $$, esc, avisar, esqueleto, vazio, falha, dataHora,
  ROTULO_STATUS, ROTULO_TIPO, TIPOS_FOTO, NIVEIS, comBotao,
} from "/src/ui.js";

const recarregar = (recarregarBase = false) =>
  document.dispatchEvent(new CustomEvent("pd:recarregar", { detail: { recarregarBase } }));

const paramRota = () => (location.hash || "").split("/")[2] ?? null;

const etiqueta = (s) =>
  `<span class="etiqueta" data-s="${esc(s)}">${esc(ROTULO_STATUS[s] ?? s)}</span>`;

// =====================================================================
// LOGIN
// =====================================================================
// =====================================================================
// LOGIN
// =====================================================================
export function telaLogin(alvo) {
  alvo.innerHTML = `
    <div class="login-container">
      <section class="login-card">
        <div class="login-header">
          <div class="login-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 1 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
          </div>
          <h1>Paris Dakar Controle</h1>
          <p>Acesse com suas credenciais corporativas</p>
        </div>
        <div class="campo">
          <label for="email">E-mail corporativo</label>
          <input id="email" type="email" autocomplete="username" inputmode="email" placeholder="seu.email@empresa.com" required>
        </div>
        <div class="campo">
          <label for="senha">Senha de acesso</label>
          <input id="senha" type="password" autocomplete="current-password" placeholder="••••••••" required>
        </div>
        <p id="erro-login" class="erro-campo" hidden></p>
        <button class="primario" id="btn-entrar" style="width:100%">Entrar no sistema</button>
        <button class="secundario" id="btn-esqueci" style="width:100%; margin-top:10px">Esqueci minha senha</button>
      </section>
    </div>`;

  const mostrarErro = (msg) => {
    const p = $("#erro-login");
    p.textContent = msg;
    p.hidden = !msg;
  };

  const entrar = (e) => comBotao(e?.currentTarget ?? null, async () => {
    mostrarErro("");
    const email = $("#email").value.trim();
    const password = $("#senha").value;
    if (!email || !password) return mostrarErro("Informe e-mail e senha.");

    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return mostrarErro("E-mail ou senha inválidos.");
  });

  $("#btn-entrar").addEventListener("click", entrar);
  $("#senha").addEventListener("keydown", (e) => { if (e.key === "Enter") entrar(); });

  $("#btn-esqueci").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const email = $("#email").value.trim();
    if (!email) return mostrarErro("Informe o e-mail para receber o link.");
    await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    avisar("Se este e-mail existir, você receberá o link em instantes.", "ok", 8000);
  }));
}

// =====================================================================
// PAINEL
// =====================================================================
async function painel(alvo, estado) {
  alvo.innerHTML = `<div class="cabecalho-pagina"><h1>Painel Executivo</h1></div>${esqueleto(3)}`;

  const { dados: pendentes } = await api.listarMovimentacoes({ status: "PENDENTE" });
  const veiculos = estado.veiculos ?? [];
  const nomeLocal = mapaLocais(estado);

  const conta = (s) => veiculos.filter((v) => v.status === s).length;
  const naFila = (await fila.listarFila()).length;

  alvo.innerHTML = `
    <div class="cabecalho-pagina">
      <h1>Painel Executivo</h1>
      <p>Bem-vindo(a), <strong>${esc(estado.perfil?.nome ?? "")}</strong> (${esc(estado.perfil?.papel ?? "")}). Acompanhe a situação da frota em tempo real.</p>
    </div>

    <div class="kpi-grade">
      <div class="kpi-card">
        <span class="kpi-label">Total da Frota</span>
        <span class="kpi-valor">${esc(veiculos.length)}</span>
      </div>
      <div class="kpi-card" data-tipo="portaria">
        <span class="kpi-label">Na Portaria</span>
        <span class="kpi-valor">${esc(conta("NA_PORTARIA"))}</span>
      </div>
      <div class="kpi-card" data-tipo="transito">
        <span class="kpi-label">Em Trânsito</span>
        <span class="kpi-valor">${esc(conta("EM_TRANSITO"))}</span>
      </div>
      <div class="kpi-card" data-tipo="destino">
        <span class="kpi-label">No Destino</span>
        <span class="kpi-valor">${esc(conta("NO_DESTINO"))}</span>
      </div>
      <div class="kpi-card" data-tipo="pendente">
        <span class="kpi-label">Pendências</span>
        <span class="kpi-valor">${esc(pendentes.length)}</span>
      </div>
      ${naFila > 0 ? `
      <div class="kpi-card" data-tipo="pendente">
        <span class="kpi-label">Fila Offline</span>
        <span class="kpi-valor">${esc(naFila)}</span>
      </div>` : ""}
    </div>

    <h2>Pendências Aguardando Aprovação</h2>
    ${pendentes.length === 0
      ? vazio("Nenhuma movimentação pendente no momento.",
              '<a class="etiqueta" href="#/movimentacoes">Registrar Movimentação</a>')
      : tabelaMovimentacoes(pendentes, estado, nomeLocal)}

    <h2>Localização da Frota</h2>
    ${veiculos.length === 0
      ? vazio("Nenhum veículo cadastrado no sistema.",
              '<a class="etiqueta" href="#/importar">Importar Planilha</a>')
      : `<div class="tabela-rolagem"><table>
          <thead><tr><th>Código</th><th>Placa</th><th>Modelo</th><th>Status</th><th>Local Atual</th></tr></thead>
          <tbody>${veiculos.slice(0, 200).map((v) => `
            <tr><td><strong>${esc(v.cod_veiculo)}</strong></td><td>${esc(v.placa ?? "—")}</td>
                <td>${esc(v.modelo ?? "—")}</td><td>${etiqueta(v.status)}</td>
                <td>${esc(nomeLocal(v.localizacao_atual) ?? "—")}</td></tr>`).join("")}
          </tbody></table></div>`}`;

  ligarAcoesMovimentacao(alvo);
}

function mapaLocais(estado) {
  const mapa = new Map();
  (estado.portarias ?? []).forEach((p) => mapa.set(p.id, `Portaria ${p.nome}`));
  (estado.destinos ?? []).forEach((d) => mapa.set(d.id, d.nome));
  return (id) => (id ? mapa.get(id) ?? null : null);
}

function tabelaMovimentacoes(lista, estado, nomeLocal) {
  const veiculo = new Map((estado.veiculos ?? []).map((v) => [v.id, v]));
  const podeDecidir = (m) => m.usuario_id === estado.perfil?.id || estado.perfil?.papel === "MASTER";
  return `<div class="tabela-rolagem"><table>
    <thead><tr><th>Veículo</th><th>Tipo</th><th>Local</th><th>Data/hora</th><th>Status</th><th>Ações</th></tr></thead>
    <tbody>${lista.map((m) => {
      const v = veiculo.get(m.veiculo_id);
      return `<tr>
        <td>${esc(v ? `${v.cod_veiculo} · ${v.placa ?? v.modelo ?? ""}` : m.veiculo_id.slice(0, 8))}</td>
        <td>${esc(ROTULO_TIPO[m.tipo] ?? m.tipo)}</td>
        <td>${esc(nomeLocal(m.portaria_id ?? m.destino_id) ?? "—")}</td>
        <td>${esc(dataHora(m.data_hora))}</td>
        <td>${etiqueta(m.status)}</td>
        <td>${m.status === "PENDENTE" && podeDecidir(m) ? `
          <button class="secundario auto" data-vistoria="${esc(m.id)}">Vistoria</button>
          <button class="primario auto" data-decidir="${esc(m.id)}" data-decisao="APROVADO">Aprovar</button>
          <button class="perigo auto" data-decidir="${esc(m.id)}" data-decisao="REJEITADO">Rejeitar</button>`
          : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function ligarAcoesMovimentacao(alvo) {
  $$("[data-decidir]", alvo).forEach((b) =>
    b.addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
      const { decidir, decisao } = e.currentTarget.dataset;
      try {
        const r = await api.decidirMovimentacao(decidir, decisao);
        avisar(r?.enfileirado ? "Sem conexão: decisão salva na fila." : `Movimentação ${decisao.toLowerCase()}.`,
               r?.enfileirado ? "alerta" : "ok");
        recarregar(true);
      } catch (err) {
        avisar(err.message, "erro", 9000);
        if (err.code === "PD002") location.hash = `#/vistoria/${decidir}`;
      }
    })));

  $$("[data-vistoria]", alvo).forEach((b) =>
    b.addEventListener("click", (e) => { location.hash = `#/vistoria/${e.currentTarget.dataset.vistoria}`; }));
}

// =====================================================================
// MOVIMENTAÇÕES
// =====================================================================
async function movimentacoes(alvo, estado) {
  alvo.innerHTML = `<h1>Movimentações</h1>${esqueleto(4)}`;

  const { dados: lista } = await api.listarMovimentacoes({});
  const naFila = await fila.listarFila();
  const nomeLocal = mapaLocais(estado);

  const opcoesVeiculo = (estado.veiculos ?? []).map((v) =>
    `<option value="${esc(v.id)}">${esc(v.cod_veiculo)} · ${esc(v.placa ?? "sem placa")} · ${esc(v.modelo ?? "")}</option>`).join("");
  const opcoesPortaria = (estado.portarias ?? []).map((p) =>
    `<option value="${esc(p.id)}"${p.exige_vistoria ? ' data-vistoria="1"' : ""}>${esc(p.nome)}${p.exige_vistoria ? " (exige vistoria)" : ""}</option>`).join("");
  const opcoesDestino = (estado.destinos ?? []).map((d) =>
    `<option value="${esc(d.id)}">${esc(d.nome)}</option>`).join("");

  alvo.innerHTML = `
    <h1>Movimentações</h1>

    <section class="cartao">
      <h2 style="margin-top:0">Registrar movimentação</h2>
      <div class="linha">
        <div class="campo">
          <label for="mv-veiculo">Veículo</label>
          <select id="mv-veiculo">${opcoesVeiculo}</select>
        </div>
        <div class="campo">
          <label for="mv-tipo">Tipo</label>
          <select id="mv-tipo">
            ${Object.entries(ROTULO_TIPO).map(([k, r]) =>
              `<option value="${esc(k)}">${esc(r)}</option>`).join("")}
          </select>
        </div>
        <div class="campo" id="campo-portaria">
          <label for="mv-portaria">Portaria</label>
          <select id="mv-portaria">${opcoesPortaria}</select>
        </div>
        <div class="campo" id="campo-destino" hidden>
          <label for="mv-destino">Destino</label>
          <select id="mv-destino">${opcoesDestino}</select>
        </div>
      </div>
      <div class="campo">
        <label for="mv-obs">Observações (opcional)</label>
        <input id="mv-obs" maxlength="1000" autocomplete="off">
      </div>
      <button class="primario auto" id="btn-registrar">Registrar</button>
    </section>

    ${naFila.length ? `
      <h2>Fila offline (${naFila.length})</h2>
      <div class="tabela-rolagem"><table>
        <thead><tr><th>Operação</th><th>Criada em</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>${naFila.map((i) => `
          <tr><td>${esc(i.tipo)}</td><td>${esc(dataHora(i.criado_em))}</td>
              <td>${i.erro ? `<span class="etiqueta" data-s="REJEITADO">${esc(i.erro)}</span>`
                            : `<span class="etiqueta" data-s="FILA">aguardando envio</span>`}</td>
              <td>${i.erro ? `<button class="secundario auto" data-retentar="${esc(i.id)}">Tentar de novo</button>
                              <button class="perigo auto" data-cancelar="${esc(i.id)}">Cancelar</button>` : "—"}</td>
          </tr>`).join("")}</tbody></table></div>` : ""}

    <h2>Histórico</h2>
    ${lista.length === 0 ? vazio("Nenhuma movimentação registrada ainda.")
                         : tabelaMovimentacoes(lista, estado, nomeLocal)}`;

  const trocarCampos = () => {
    const ehPortaria = ["ENTRADA_PORTARIA", "SAIDA_PORTARIA"].includes($("#mv-tipo").value);
    $("#campo-portaria").hidden = !ehPortaria;
    $("#campo-destino").hidden = ehPortaria;
  };
  $("#mv-tipo").addEventListener("change", trocarCampos);
  trocarCampos();

  $("#btn-registrar").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const tipo = $("#mv-tipo").value;
    const ehPortaria = ["ENTRADA_PORTARIA", "SAIDA_PORTARIA"].includes(tipo);
    const corpo = {
      veiculo_id: $("#mv-veiculo").value,
      tipo,
      portaria_id: ehPortaria ? $("#mv-portaria").value : null,
      destino_id: ehPortaria ? null : $("#mv-destino").value,
      data_hora: new Date().toISOString(),
      observacoes: $("#mv-obs").value.trim() || null,
    };
    if (!corpo.veiculo_id) return avisar("Selecione um veículo.", "erro");

    try {
      const r = await api.registrarMovimentacao(corpo);
      if (r?.enfileirado) {
        avisar("Sem conexão: movimentação salva na fila e será enviada ao reconectar.", "alerta", 8000);
      } else {
        const exigeVistoria = tipo === "ENTRADA_PORTARIA"
          && $("#mv-portaria").selectedOptions[0]?.dataset.vistoria === "1";
        avisar("Movimentação registrada como PENDENTE.", "ok");
        if (exigeVistoria && r?.id) {
          avisar("Esta portaria exige vistoria com foto antes da aprovação.", "alerta", 9000);
          location.hash = `#/vistoria/${r.id}`;
          return;
        }
      }
      recarregar(true);
    } catch (err) {
      avisar(err.message, "erro", 10000);
    }
  }));

  $$("[data-cancelar]", alvo).forEach((b) => b.addEventListener("click", async (e) => {
    await fila.removerDaFila(e.currentTarget.dataset.cancelar);
    avisar("Operação removida da fila.", "ok");
    recarregar();
  }));

  $$("[data-retentar]", alvo).forEach((b) => b.addEventListener("click", (e) =>
    comBotao(e.currentTarget, async () => {
      await fila.limparErro(e.currentTarget.dataset.retentar);
      const r = await api.sincronizar();
      avisar(r.conflitos ? "A operação continua sendo recusada pela regra do sistema."
                         : "Operação enviada.", r.conflitos ? "erro" : "ok");
      recarregar(true);
    })));

  ligarAcoesMovimentacao(alvo);
}

// =====================================================================
// VISTORIA  (#/vistoria/<movimentacao_id>)
// =====================================================================
async function vistoria(alvo, estado) {
  const movId = paramRota();
  if (!movId) { alvo.innerHTML = falha("Movimentação não informada."); return; }

  alvo.innerHTML = `<h1>Vistoria</h1>${esqueleto(3)}`;

  const { data: mov, error } = await sb.from("movimentacoes")
    .select("id, veiculo_id, tipo, portaria_id, status, data_hora").eq("id", movId).maybeSingle();
  if (error || !mov) { alvo.innerHTML = falha("Movimentação não encontrada ou sem permissão."); return; }

  const veiculo = (estado.veiculos ?? []).find((v) => v.id === mov.veiculo_id);
  const { data: vist } = await api.listarVistoria(movId);

  alvo.innerHTML = `
    <h1>Vistoria</h1>
    <p class="sub">
      ${esc(veiculo ? `${veiculo.cod_veiculo} · ${veiculo.placa ?? veiculo.modelo ?? ""}` : "")} —
      ${esc(ROTULO_TIPO[mov.tipo] ?? mov.tipo)} em ${esc(dataHora(mov.data_hora))} — ${esc(ROTULO_STATUS[mov.status])}
    </p>

    <section class="cartao">
      <div class="linha">
        <div class="campo">
          <label for="vs-km">KM</label>
          <input id="vs-km" type="number" inputmode="numeric" min="0" max="3000000"
                 value="${esc(vist?.km ?? "")}">
        </div>
        <div class="campo">
          <label for="vs-nivel">Combustível</label>
          <select id="vs-nivel">
            ${NIVEIS.map(([v, r]) => `<option value="${esc(v)}"${vist?.nivel_combustivel === v ? " selected" : ""}>${esc(r)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="campo">
        <label for="vs-obs">Observações</label>
        <input id="vs-obs" maxlength="1000" value="${esc(vist?.observacoes ?? "")}">
      </div>
      <button class="primario auto" id="btn-salvar-vistoria">
        ${vist ? "Atualizar vistoria" : "Iniciar vistoria"}
      </button>
    </section>

    <section class="cartao" id="secao-fotos" ${vist ? "" : "hidden"}>
      <h2 style="margin-top:0">Fotos</h2>
      <div class="linha">
        <div class="campo">
          <label for="ft-tipo">Tipo da foto</label>
          <select id="ft-tipo">${TIPOS_FOTO.map((t) =>
            `<option value="${esc(t)}">${esc(t.replaceAll("_", " ").toLowerCase())}</option>`).join("")}</select>
        </div>
        <div class="campo">
          <label for="ft-arquivo">Arquivo ou câmera</label>
          <input id="ft-arquivo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
        </div>
      </div>
      <button class="primario auto" id="btn-enviar-foto" ${vist ? "" : "disabled"}>Enviar foto</button>
      <div class="fotos" id="lista-fotos" style="margin-top:16px"></div>
    </section>

    <button class="secundario auto" id="btn-voltar">Voltar às movimentações</button>`;

  $("#btn-voltar").addEventListener("click", () => { location.hash = "#/movimentacoes"; });

  let vistoriaId = vist?.id ?? null;

  const desenharFotos = async () => {
    const caixa = $("#lista-fotos");
    if (!vistoriaId) return;
    const { data } = await api.listarVistoria(movId);
    const fotos = data?.fotos_vistoria ?? [];
    if (fotos.length === 0) { caixa.innerHTML = vazio("Nenhuma foto enviada."); return; }
    caixa.innerHTML = "";
    for (const f of fotos) {
      const url = await api.urlAssinada(f.url);   // bucket privado: URL curta e assinada
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = url ?? "";
      img.alt = `Foto ${f.tipo.replaceAll("_", " ").toLowerCase()} do veículo`;
      img.width = 160; img.height = 90; img.loading = "lazy";
      const cap = document.createElement("figcaption");
      cap.textContent = f.tipo.replaceAll("_", " ").toLowerCase();
      fig.append(img, cap);
      caixa.appendChild(fig);
    }
  };
  desenharFotos();

  $("#btn-salvar-vistoria").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const km = $("#vs-km").value === "" ? null : Number($("#vs-km").value);
    try {
      const r = await api.registrarVistoria({
        movimentacao_id: movId,
        km,
        nivel_combustivel: $("#vs-nivel").value || null,
        observacoes: $("#vs-obs").value.trim() || null,
      });
      if (r?.enfileirado) return avisar("Sem conexão: vistoria salva na fila.", "alerta");
      vistoriaId = r.id;
      $("#secao-fotos").hidden = false;
      $("#btn-enviar-foto").disabled = false;
      avisar("Vistoria salva. Agora envie as fotos.", "ok");
      desenharFotos();
    } catch (err) { avisar(err.message, "erro", 9000); }
  }));

  $("#btn-enviar-foto").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const arquivo = $("#ft-arquivo").files?.[0];
    if (!arquivo) return avisar("Escolha uma imagem.", "erro");
    if (arquivo.size > 8 * 1024 * 1024) return avisar("Imagem acima de 8 MB.", "erro");
    if (!vistoriaId) return avisar("Salve a vistoria antes de enviar fotos.", "erro");
    try {
      const r = await api.enviarFoto(vistoriaId, $("#ft-tipo").value, arquivo);
      avisar(r?.enfileirado ? "Sem conexão: foto salva na fila." : "Foto enviada.",
             r?.enfileirado ? "alerta" : "ok");
      $("#ft-arquivo").value = "";
      desenharFotos();
    } catch (err) { avisar(err.message, "erro", 9000); }
  }));
}

// =====================================================================
// VEÍCULOS
// =====================================================================
async function veiculos(alvo, estado) {
  const ehMaster = estado.perfil?.papel === "MASTER";
  const nomeLocal = mapaLocais(estado);

  alvo.innerHTML = `
    <h1>Veículos</h1>
    <div class="linha">
      <div class="campo">
        <label for="busca">Buscar por código, placa ou modelo</label>
        <input id="busca" type="search" autocomplete="off" placeholder="ex.: 12959 ou TEX7D54">
      </div>
    </div>

    ${ehMaster ? `
    <details class="cartao">
      <summary>Cadastrar veículo manualmente</summary>
      <div class="linha" style="margin-top:12px">
        ${[["cod_veiculo", "Código *", "text"], ["placa", "Placa", "text"], ["chassi", "Chassi", "text"],
           ["marca", "Marca/Família", "text"], ["modelo", "Modelo", "text"], ["cor", "Cor", "text"],
           ["ano_fabricacao", "Ano fabricação", "number"], ["ano_modelo", "Ano modelo", "number"]]
          .map(([id, r, t]) => `<div class="campo">
              <label for="v-${id}">${esc(r)}</label>
              <input id="v-${id}" type="${t}" autocomplete="off"></div>`).join("")}
      </div>
      <button class="primario auto" id="btn-salvar-veiculo">Salvar veículo</button>
    </details>` : ""}

    <div id="lista-veiculos">${esqueleto(5)}</div>
    <div id="historico"></div>`;

  const desenhar = (termo = "") => {
    const t = termo.trim().toLowerCase();
    const lista = (estado.veiculos ?? []).filter((v) =>
      !t || [v.cod_veiculo, v.placa, v.modelo, v.marca].some((c) => (c ?? "").toLowerCase().includes(t)));

    $("#lista-veiculos").innerHTML = lista.length === 0
      ? vazio(t ? "Nenhum veículo encontrado para esta busca." : "Nenhum veículo cadastrado.")
      : `<div class="tabela-rolagem"><table>
          <thead><tr><th>Código</th><th>Placa</th><th>Marca</th><th>Modelo</th><th>Cor</th>
                     <th class="num">Ano</th><th>Status</th><th>Local</th><th></th></tr></thead>
          <tbody>${lista.slice(0, 300).map((v) => `
            <tr><td>${esc(v.cod_veiculo)}</td><td>${esc(v.placa ?? "—")}</td>
                <td>${esc(v.marca ?? "—")}</td><td>${esc(v.modelo ?? "—")}</td>
                <td>${esc(v.cor ?? "—")}</td>
                <td class="num">${esc(v.ano_fabricacao ?? "—")}/${esc(v.ano_modelo ?? "—")}</td>
                <td>${etiqueta(v.status)}</td>
                <td>${esc(nomeLocal(v.localizacao_atual) ?? "—")}</td>
                <td><button class="secundario auto" data-historico="${esc(v.id)}">Histórico</button></td>
            </tr>`).join("")}</tbody></table></div>`;

    $$("[data-historico]").forEach((b) => b.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.historico;
      const caixa = $("#historico");
      caixa.innerHTML = `<h2>Histórico do veículo</h2>${esqueleto(3)}`;
      const { dados } = await api.listarMovimentacoes({ veiculo_id: id });
      caixa.innerHTML = `<h2>Histórico do veículo</h2>` +
        (dados.length === 0 ? vazio("Nenhuma movimentação para este veículo.")
                            : tabelaMovimentacoes(dados, estado, nomeLocal));
      ligarAcoesMovimentacao(caixa);
      caixa.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  };

  desenhar();

  let debounce;
  $("#busca").addEventListener("input", (e) => {
    clearTimeout(debounce);
    const v = e.target.value;
    debounce = setTimeout(() => desenhar(v), 200);
  });

  if (ehMaster) {
    $("#btn-salvar-veiculo").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
      const val = (id) => $(`#v-${id}`).value.trim();
      const cod = val("cod_veiculo");
      if (!cod) return avisar("O código do veículo é obrigatório.", "erro");

      const registro = {
        cod_veiculo: cod,
        placa: val("placa").toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        chassi: val("chassi").toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        marca: val("marca") || null,
        modelo: val("modelo") || null,
        cor: val("cor") || null,
        ano_fabricacao: val("ano_fabricacao") ? Number(val("ano_fabricacao")) : null,
        ano_modelo: val("ano_modelo") ? Number(val("ano_modelo")) : null,
      };
      // Allowlist de campos: nunca enviamos o objeto do formulário inteiro,
      // senão o usuário injeta status/localizacao_atual junto.
      const { error } = await sb.from("veiculos").insert(registro);
      if (error) {
        return avisar(error.code === "23505"
          ? "Já existe veículo com este código, placa ou chassi."
          : "Não foi possível salvar. Verifique os dados (placa com 7 caracteres, chassi com 17).", "erro", 9000);
      }
      avisar("Veículo cadastrado.", "ok");
      recarregar(true);
    }));
  }
}

// =====================================================================
// CADASTROS (portarias e destinos) — só MASTER
// =====================================================================
async function cadastros(alvo, estado) {
  const linhasPortarias = (estado.portarias ?? []).map((p) => `
    <tr><td>${esc(p.nome)}</td><td>${esc(p.codigo)}</td>
        <td>${p.exige_vistoria ? "sim" : "não"}</td>
        <td><button class="perigo auto" data-desativar-portaria="${esc(p.id)}">Desativar</button></td></tr>`).join("");

  const linhasDestinos = (estado.destinos ?? []).map((d) => `
    <tr><td>${esc(d.nome)}</td><td>${esc(d.codigo)}</td>
        <td>${esc((estado.portarias ?? []).find((p) => p.id === d.portaria_id)?.nome ?? "—")}</td>
        <td><button class="perigo auto" data-desativar-destino="${esc(d.id)}">Desativar</button></td></tr>`).join("");

  alvo.innerHTML = `
    <h1>Portarias e destinos</h1>

    <section class="cartao">
      <h2 style="margin-top:0">Nova portaria</h2>
      <div class="linha">
        <div class="campo"><label for="p-nome">Nome</label><input id="p-nome" autocomplete="off"></div>
        <div class="campo"><label for="p-codigo">Código (A-Z, 0-9, _)</label><input id="p-codigo" autocomplete="off"></div>
        <div class="campo">
          <label for="p-vistoria">Exige vistoria?</label>
          <select id="p-vistoria"><option value="false">não</option><option value="true">sim</option></select>
        </div>
      </div>
      <button class="primario auto" id="btn-portaria">Salvar portaria</button>
    </section>

    <div class="tabela-rolagem"><table>
      <thead><tr><th>Portaria</th><th>Código</th><th>Vistoria</th><th></th></tr></thead>
      <tbody>${linhasPortarias || '<tr><td colspan="4">Nenhuma portaria ativa.</td></tr>'}</tbody></table></div>

    <section class="cartao" style="margin-top:24px">
      <h2 style="margin-top:0">Novo destino</h2>
      <div class="linha">
        <div class="campo"><label for="d-nome">Nome</label><input id="d-nome" autocomplete="off"></div>
        <div class="campo"><label for="d-codigo">Código</label><input id="d-codigo" autocomplete="off"></div>
        <div class="campo">
          <label for="d-portaria">Portaria vinculada (opcional)</label>
          <select id="d-portaria"><option value="">—</option>
            ${(estado.portarias ?? []).map((p) => `<option value="${esc(p.id)}">${esc(p.nome)}</option>`).join("")}
          </select>
        </div>
      </div>
      <button class="primario auto" id="btn-destino">Salvar destino</button>
    </section>

    <div class="tabela-rolagem"><table>
      <thead><tr><th>Destino</th><th>Código</th><th>Portaria</th><th></th></tr></thead>
      <tbody>${linhasDestinos || '<tr><td colspan="4">Nenhum destino ativo.</td></tr>'}</tbody></table></div>`;

  const normalizarCodigo = (s) => s.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 30);

  $("#btn-portaria").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const nome = $("#p-nome").value.trim();
    const codigo = normalizarCodigo($("#p-codigo").value || nome);
    if (nome.length < 2 || codigo.length < 2) return avisar("Informe nome e código.", "erro");
    const { error } = await sb.from("portarias")
      .insert({ nome, codigo, exige_vistoria: $("#p-vistoria").value === "true" });
    if (error) return avisar(error.code === "23505" ? "Código já usado." : "Não foi possível salvar.", "erro");
    avisar("Portaria criada.", "ok");
    location.reload();
  }));

  $("#btn-destino").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const nome = $("#d-nome").value.trim();
    const codigo = normalizarCodigo($("#d-codigo").value || nome);
    if (nome.length < 2 || codigo.length < 2) return avisar("Informe nome e código.", "erro");
    const { error } = await sb.from("destinos")
      .insert({ nome, codigo, portaria_id: $("#d-portaria").value || null });
    if (error) return avisar(error.code === "23505" ? "Código já usado." : "Não foi possível salvar.", "erro");
    avisar("Destino criado.", "ok");
    location.reload();
  }));

  const desativar = (tabela, id) => comBotao(null, async () => {
    if (!confirm("Desativar este registro? Ele deixa de aparecer nas movimentações.")) return;
    const { error } = await sb.from(tabela).update({ ativo: false }).eq("id", id);
    avisar(error ? "Não foi possível desativar." : "Registro desativado.", error ? "erro" : "ok");
    if (!error) location.reload();
  });

  $$("[data-desativar-portaria]").forEach((b) =>
    b.addEventListener("click", (e) => desativar("portarias", e.currentTarget.dataset.desativarPortaria)));
  $$("[data-desativar-destino]").forEach((b) =>
    b.addEventListener("click", (e) => desativar("destinos", e.currentTarget.dataset.desativarDestino)));
}

// =====================================================================
// IMPORTAÇÃO — só MASTER
// =====================================================================
async function importar(alvo) {
  alvo.innerHTML = `
    <h1>Importar planilha</h1>
    <p class="sub">Aceita .xls e .xlsx. As colunas são lidas por nome:
       Família, Modelo, Chassi, Placa, Veículo, Ano, Cor.</p>
    <section class="cartao">
      <div class="campo">
        <label for="arquivo">Arquivo da planilha (até 8 MB)</label>
        <input id="arquivo" type="file"
               accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      </div>
      <button class="primario auto" id="btn-importar">Importar</button>
    </section>
    <div id="relatorio"></div>`;

  $("#btn-importar").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const arquivo = $("#arquivo").files?.[0];
    if (!arquivo) return avisar("Escolha a planilha.", "erro");
    if (arquivo.size > 8 * 1024 * 1024) return avisar("Arquivo acima de 8 MB.", "erro");
    if (!navigator.onLine) return avisar("A importação exige conexão.", "erro");

    $("#relatorio").innerHTML = esqueleto(3);
    const base64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1]);
      fr.onerror = () => rej(new Error("Falha ao ler o arquivo."));
      fr.readAsDataURL(arquivo);
    });

    try {
      const r = await api.importarPlanilha(base64, arquivo.name);
      $("#relatorio").innerHTML = `
        <h2>Relatório da importação</h2>
        <div class="grade">
          ${[["Linhas lidas", r.total], ["Importadas", r.importadas],
             ["Atualizadas", r.atualizadas], ["Avisos", r.avisos.length], ["Erros", r.erros.length]]
            .map(([rot, n]) => `<div class="cartao"><label>${esc(rot)}</label>
                 <div style="font-size:24px">${esc(n)}</div></div>`).join("")}
        </div>
        ${r.erros.length ? `<h2>Erros</h2><div class="tabela-rolagem"><table>
          <thead><tr><th>Linha</th><th>Código</th><th>Motivo</th></tr></thead>
          <tbody>${r.erros.map((x) => `<tr><td>${esc(x.linha)}</td>
            <td>${esc(x.cod_veiculo)}</td><td>${esc(x.motivo)}</td></tr>`).join("")}
          </tbody></table></div>` : ""}
        ${r.avisos.length ? `<h2>Avisos</h2><div class="tabela-rolagem"><table>
          <thead><tr><th>Linha</th><th>Código</th><th>Aviso</th></tr></thead>
          <tbody>${r.avisos.map((x) => `<tr><td>${esc(x.linha)}</td>
            <td>${esc(x.cod_veiculo)}</td><td>${esc(x.aviso)}</td></tr>`).join("")}
          </tbody></table></div>` : ""}`;
      avisar(`Importação concluída: ${r.importadas} novas, ${r.atualizadas} atualizadas.`, "ok", 8000);
      recarregar(true);
    } catch (err) {
      $("#relatorio").innerHTML = falha(err.message);
    }
  }));
}

// =====================================================================
// USUÁRIOS — só MASTER
// =====================================================================
async function usuarios(alvo, estado) {
  alvo.innerHTML = `<h1>Usuários</h1>${esqueleto(4)}`;
  const { data: lista, error } = await api.listarUsuarios();
  if (error) { alvo.innerHTML = falha("Não foi possível carregar os usuários."); return; }

  alvo.innerHTML = `
    <h1>Usuários</h1>
    <section class="cartao">
      <h2 style="margin-top:0">Convidar usuário</h2>
      <p class="sub">O convidado define a própria senha pelo link do e-mail.</p>
      <div class="linha">
        <div class="campo"><label for="u-nome">Nome</label><input id="u-nome" autocomplete="off"></div>
        <div class="campo"><label for="u-email">E-mail</label>
          <input id="u-email" type="email" inputmode="email" autocomplete="off"></div>
        <div class="campo"><label for="u-papel">Papel</label>
          <select id="u-papel"><option value="MANUTENCAO">Manutenção</option><option value="MASTER">Master</option></select>
        </div>
      </div>
      <button class="primario auto" id="btn-convidar">Convidar</button>
    </section>

    <div class="tabela-rolagem"><table>
      <thead><tr><th>Nome</th><th>Papel</th><th>Ativo</th><th>Criado em</th><th></th></tr></thead>
      <tbody>${(lista ?? []).map((u) => `
        <tr><td>${esc(u.nome)}</td><td>${esc(u.papel)}</td><td>${u.ativo ? "sim" : "não"}</td>
            <td>${esc(dataHora(u.criado_em))}</td>
            <td>${u.id === estado.perfil.id ? "—" : `
              <button class="secundario auto" data-alternar="${esc(u.id)}" data-ativo="${u.ativo}">
                ${u.ativo ? "Desativar" : "Ativar"}</button>`}</td></tr>`).join("")}
      </tbody></table></div>`;

  $("#btn-convidar").addEventListener("click", (e) => comBotao(e.currentTarget, async () => {
    const nome = $("#u-nome").value.trim();
    const email = $("#u-email").value.trim();
    if (nome.length < 2 || !email.includes("@")) return avisar("Informe nome e e-mail válidos.", "erro");
    try {
      await api.chamarFuncao("usuarios", { acao: "criar", nome, email, papel: $("#u-papel").value });
      avisar("Convite enviado.", "ok");
      recarregar();
    } catch (err) { avisar(err.message, "erro", 9000); }
  }));

  $$("[data-alternar]").forEach((b) => b.addEventListener("click", (e) =>
    comBotao(e.currentTarget, async () => {
      const { alternar, ativo } = e.currentTarget.dataset;
      try {
        await api.chamarFuncao("usuarios",
          { acao: ativo === "true" ? "desativar" : "ativar", usuario_id: alternar });
        avisar("Usuário atualizado.", "ok");
        recarregar();
      } catch (err) { avisar(err.message, "erro", 9000); }
    })));
}

// =====================================================================
export const PAGINAS = {
  painel: { render: painel },
  movimentacoes: { render: movimentacoes },
  vistoria: { render: vistoria },
  veiculos: { render: veiculos },
  cadastros: { render: cadastros, somenteMaster: true },
  importar: { render: importar, somenteMaster: true },
  usuarios: { render: usuarios, somenteMaster: true },
};
