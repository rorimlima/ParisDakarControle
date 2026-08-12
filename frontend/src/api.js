// =====================================================================
// Camada de acesso a dados. Regra da casa:
//  - leitura: PostgREST direto (a RLS filtra; não existe filtro "de fachada"
//    no cliente que valha alguma coisa);
//  - escrita: sempre Edge Function -> RPC transacional;
//  - sem rede: entra na fila local e sai na ordem quando a conexão volta.
// =====================================================================
import { sb, URL_FUNCOES } from "/src/supabase.js";
import * as fila from "/src/fila.js";

export class ErroApi extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const semRede = (e) =>
  e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e?.message ?? "");

export async function chamarFuncao(nome, corpo) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new ErroApi("NAO_AUTENTICADO", "Sessão expirada. Faça login novamente.", 401);

  const resp = await fetch(`${URL_FUNCOES}/${nome}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: sb.supabaseKey,
    },
    body: JSON.stringify(corpo),
  });

  let json = {};
  try { json = await resp.json(); } catch { /* corpo vazio */ }

  if (!resp.ok) {
    throw new ErroApi(json?.error?.code ?? "ERRO", json?.error?.message ?? "Falha na operação.", resp.status);
  }
  return json.data;
}

// ------------------------------------------------------------ leituras
export async function perfilAtual() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb
    .from("perfis_usuario").select("id, nome, papel, ativo").eq("id", user.id).maybeSingle();
  if (error) throw new ErroApi("PERFIL", "Não foi possível carregar seu perfil.", 500);
  if (data) await fila.salvarCache("perfil", data);
  return data ?? await fila.lerCache("perfil");
}

async function comCache(chave, consulta) {
  try {
    const { data, error } = await consulta();
    if (error) throw error;
    await fila.salvarCache(chave, data);
    return { dados: data, doCache: false };
  } catch (e) {
    const cache = await fila.lerCache(chave);
    if (cache) return { dados: cache, doCache: true };
    throw new ErroApi("SEM_DADOS", "Sem conexão e sem dados salvos neste aparelho.", 503);
  }
}

export const listarVeiculos = () => comCache("veiculos", () =>
  sb.from("veiculos")
    .select("id, cod_veiculo, placa, modelo, marca, cor, ano_fabricacao, ano_modelo, status, localizacao_atual, localizacao_tipo")
    .eq("ativo", true).order("cod_veiculo").limit(1000));

export const listarPortarias = () => comCache("portarias", () =>
  sb.from("portarias").select("id, nome, codigo, exige_vistoria, ativo").eq("ativo", true).order("nome"));

export const listarDestinos = () => comCache("destinos", () =>
  sb.from("destinos").select("id, nome, codigo, portaria_id, ativo").eq("ativo", true).order("nome"));

export const listarMovimentacoes = (filtro = {}) => {
  let q = sb.from("movimentacoes")
    .select("id, veiculo_id, tipo, portaria_id, destino_id, usuario_id, status, data_hora, observacoes, criado_em")
    .order("data_hora", { ascending: false }).limit(200);
  if (filtro.status) q = q.eq("status", filtro.status);
  if (filtro.veiculo_id) q = q.eq("veiculo_id", filtro.veiculo_id);
  return comCache(`movimentacoes:${filtro.status ?? "todas"}:${filtro.veiculo_id ?? ""}`, () => q);
};

export const listarUsuarios = () =>
  sb.from("perfis_usuario").select("id, nome, papel, ativo, criado_em").order("nome");

export const listarVistoria = (movimentacao_id) =>
  sb.from("vistorias")
    .select("id, km, nivel_combustivel, observacoes, data_hora, fotos_vistoria(id, tipo, url)")
    .eq("movimentacao_id", movimentacao_id).maybeSingle();

export async function urlAssinada(caminho, segundos = 300) {
  const { data } = await sb.storage.from("vistorias").createSignedUrl(caminho, segundos);
  return data?.signedUrl ?? null;
}

// ------------------------------------------------------------ escritas
export async function registrarMovimentacao(dados) {
  const payload = { acao: "registrar", client_op_id: fila.uuid(), ...dados };
  if (!navigator.onLine) {
    await fila.enfileirar("movimentacao", payload);
    return { enfileirado: true };
  }
  try {
    return await chamarFuncao("movimentacoes", payload);
  } catch (e) {
    if (semRede(e)) {
      await fila.enfileirar("movimentacao", payload);
      return { enfileirado: true };
    }
    throw e;
  }
}

export async function decidirMovimentacao(movimentacao_id, decisao, observacoes = null) {
  const payload = { acao: "decidir", movimentacao_id, decisao, observacoes };
  if (!navigator.onLine) {
    await fila.enfileirar("decisao", payload);
    return { enfileirado: true };
  }
  try {
    return await chamarFuncao("movimentacoes", payload);
  } catch (e) {
    if (semRede(e)) {
      await fila.enfileirar("decisao", payload);
      return { enfileirado: true };
    }
    throw e;
  }
}

export async function registrarVistoria(dados) {
  const payload = { acao: "registrar", client_op_id: fila.uuid(), ...dados };
  if (!navigator.onLine) {
    await fila.enfileirar("vistoria", payload);
    return { enfileirado: true };
  }
  try {
    return await chamarFuncao("vistorias", payload);
  } catch (e) {
    if (semRede(e)) {
      await fila.enfileirar("vistoria", payload);
      return { enfileirado: true };
    }
    throw e;
  }
}

/** Sobe a imagem para o Storage e registra a foto (magic bytes conferidos no servidor). */
export async function enviarFoto(vistoria_id, tipo, arquivo) {
  const ext = (arquivo.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const caminho = `${vistoria_id}/${tipo}_${Date.now()}.${ext}`;

  if (!navigator.onLine) {
    await fila.enfileirar("foto", { vistoria_id, tipo, caminho, arquivo });
    return { enfileirado: true, caminho };
  }
  try {
    const { error } = await sb.storage.from("vistorias")
      .upload(caminho, arquivo, { contentType: arquivo.type, upsert: false });
    if (error) throw new ErroApi("UPLOAD", "Falha ao enviar a foto.", 500);
    return await chamarFuncao("vistorias", { acao: "registrar_foto", vistoria_id, tipo, url: caminho });
  } catch (e) {
    if (semRede(e)) {
      await fila.enfileirar("foto", { vistoria_id, tipo, caminho, arquivo });
      return { enfileirado: true, caminho };
    }
    throw e;
  }
}

const ALIASES = {
  nroveiculo: "cod_veiculo", numveiculo: "cod_veiculo", numeroveiculo: "cod_veiculo",
  veiculo: "cod_veiculo", codveiculo: "cod_veiculo", codigo: "cod_veiculo", cod: "cod_veiculo",
  codigoveiculo: "cod_veiculo", codigodoveiculo: "cod_veiculo", frota: "cod_veiculo",
  codfrota: "cod_veiculo", codigofrota: "cod_veiculo", idveiculo: "cod_veiculo", cdveiculo: "cod_veiculo",
  patrimonio: "cod_veiculo", prefixo: "cod_veiculo", codigoempresa: "cod_veiculo", codveic: "cod_veiculo",
  nro: "cod_veiculo",

  placa: "placa", placaveiculo: "placa", nroplaca: "placa", numplaca: "placa", placaatual: "placa",

  chassi: "chassi", chassis: "chassi", numchassi: "chassi", numerochassi: "chassi", chassiveiculo: "chassi", nrochassi: "chassi",

  marca: "marca", familia: "marca", fabricante: "marca", montadora: "marca", marcamodelo: "marca",
  marcaveiculo: "marca", descmarca: "marca",

  modelo: "modelo", descmodelo: "modelo", descricaomodelo: "modelo", descricao: "modelo",
  descricaoveiculo: "modelo", veiculomodelo: "modelo", modeloversao: "modelo", versao: "modelo",
  descmodeloveic: "modelo", nomemodelo: "modelo",

  cor: "cor", corpredominante: "cor", corveiculo: "cor", desccor: "cor",

  ano: "ano", anomodelo: "ano_mod", anofabricacao: "ano_fab", anofabmod: "ano",
  anomodelofabricacao: "ano", anofab: "ano_fab", anomod: "ano_mod"
};

const normalizarStr = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "").trim();

async function carregarXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new ErroApi("XLSX_ERRO", "Não foi possível carregar o leitor de planilhas.", 500));
    document.head.appendChild(script);
  });
}

export async function processarPlanilhaNoNavegador(arrayBuffer) {
  if (!arrayBuffer) throw new ErroApi("ARQUIVO_INVALIDO", "Arquivo não fornecido.", 400);
  const XLSX = await carregarXLSX();
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: "array", cellDates: false, cellText: true });
  const aba = wb.Sheets[wb.SheetNames[0]];
  if (!aba) throw new ErroApi("ARQUIVO_INVALIDO", "Planilha sem abas.", 422);

  const matriz = XLSX.utils.sheet_to_json(aba, {
    header: 1, raw: false, defval: "", blankrows: false,
  });
  if (matriz.length < 2) throw new ErroApi("ARQUIVO_VAZIO", "A planilha não tem linhas de dados.", 422);

  let linhaCabecalhoIdx = -1;
  let indices = {};

  for (let r = 0; r < Math.min(20, matriz.length); r++) {
    const row = (matriz[r] || []).map((c) => normalizarStr(c));
    const tempIndices = {};

    row.forEach((colNome, colIdx) => {
      const campo = ALIASES[colNome];
      if (campo && tempIndices[campo] === undefined) {
        tempIndices[campo] = colIdx;
      }
    });

    if (tempIndices["cod_veiculo"] !== undefined || tempIndices["placa"] !== undefined ||
        tempIndices["chassi"] !== undefined || tempIndices["modelo"] !== undefined) {
      linhaCabecalhoIdx = r;
      indices = tempIndices;
      break;
    }
  }

  if (linhaCabecalhoIdx === -1) {
    throw new ErroApi("CABECALHO_INVALIDO",
      'Cabeçalho não encontrado. A planilha deve conter colunas como "NroVeiculo", "Veículo", "Placa", "Chassi" ou "Modelo".', 422);
  }

  const linhas = matriz.slice(linhaCabecalhoIdx + 1).map((l) => {
    const obj = {};
    for (const [campo, i] of Object.entries(indices)) {
      obj[campo] = String(l[i] ?? "").trim();
    }

    if (!obj["ano"] && (obj["ano_fab"] || obj["ano_mod"])) {
      const fab = obj["ano_fab"] || "";
      const mod = obj["ano_mod"] || fab;
      obj["ano"] = fab ? `${fab}/${mod}` : mod;
    }

    if (!obj["cod_veiculo"]) {
      if (obj["placa"]) obj["cod_veiculo"] = obj["placa"];
      else if (obj["chassi"]) obj["cod_veiculo"] = obj["chassi"];
    }

    return obj;
  }).filter((o) => o["cod_veiculo"] || o["placa"] || o["chassi"] || o["modelo"]);

  if (linhas.length === 0) throw new ErroApi("ARQUIVO_VAZIO", "Nenhuma linha válida de veículos encontrada.", 422);
  if (linhas.length > 20000) throw new ErroApi("ARQUIVO_GRANDE", "Máximo de 20000 linhas por lote.", 413);

  const { data, error } = await sb.rpc("importar_veiculos", { p_linhas: linhas });
  if (error) throw new ErroApi(error.code ?? "PD000", error.message ?? "Não foi possível gravar a planilha.", 500);
  return data;
}

export async function importarPlanilha(arquivo_base64, nome_arquivo, arrayBuffer) {
  try {
    return await chamarFuncao("importar-veiculos", { arquivo_base64, nome_arquivo });
  } catch (e) {
    if (semRede(e) || e.message?.includes("Failed to fetch") || e.status === 404 || e.status === 502) {
      return await processarPlanilhaNoNavegador(arrayBuffer);
    }
    throw e;
  }
}

// ------------------------------------------------------- sincronização
/**
 * Processa a fila em ordem. Erro de REGRA (409/422/403) fica marcado no item
 * para o usuário decidir — cancelar ou tentar de novo — em vez de sumir.
 * Erro de REDE interrompe o ciclo e mantém a ordem intacta.
 */
export async function sincronizar(aoProgresso = () => {}) {
  const itens = (await fila.listarFila()).filter((i) => !i.erro);
  let enviados = 0, conflitos = 0;

  for (const item of itens) {
    try {
      if (item.tipo === "movimentacao" || item.tipo === "decisao") {
        await chamarFuncao("movimentacoes", item.payload);
      } else if (item.tipo === "vistoria") {
        await chamarFuncao("vistorias", item.payload);
      } else if (item.tipo === "foto") {
        const { vistoria_id, tipo, caminho, arquivo } = item.payload;
        const { error } = await sb.storage.from("vistorias")
          .upload(caminho, arquivo, { contentType: arquivo.type, upsert: true });
        if (error) throw new ErroApi("UPLOAD", "Falha ao enviar a foto.", 500);
        await chamarFuncao("vistorias", { acao: "registrar_foto", vistoria_id, tipo, url: caminho });
      }
      await fila.removerDaFila(item.id);
      enviados += 1;
    } catch (e) {
      if (semRede(e)) break;                       // rede caiu de novo: preserva ordem
      await fila.marcarErro(item.id, e.message);   // conflito de regra: usuário resolve
      conflitos += 1;
    }
    aoProgresso({ enviados, conflitos });
  }
  return { enviados, conflitos, restantes: (await fila.listarFila()).length };
}
