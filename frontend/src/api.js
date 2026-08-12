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

export const importarPlanilha = (arquivo_base64, nome_arquivo) =>
  chamarFuncao("importar-veiculos", { arquivo_base64, nome_arquivo });

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
