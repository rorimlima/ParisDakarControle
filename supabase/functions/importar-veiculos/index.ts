// =====================================================================
// POST /functions/v1/importar-veiculos   { arquivo_base64, nome_arquivo? }
//
// Aceita .xls (BIFF, que é o formato real do Rel_MalaDireta.xls) e .xlsx.
// O mapeamento é por NOME DA COLUNA (normalizado) e encontra dinamicamente
// a linha do cabeçalho mesmo se houver linhas de título do ERP acima.
// =====================================================================
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { preflight } from "../_shared/cors.ts";
import { ok, erro, erroDoBanco, corpoJson } from "../_shared/http.ts";
import { clienteDoUsuario, usuarioAutenticado } from "../_shared/auth.ts";
import { schemaImportacao, validar } from "../_shared/schemas.ts";
import { limitar } from "../_shared/ratelimit.ts";

const ALIASES: Record<string, string> = {
  // Código do Veículo / NroVeiculo
  "nroveiculo": "cod_veiculo",
  "numveiculo": "cod_veiculo",
  "numeroveiculo": "cod_veiculo",
  "veiculo": "cod_veiculo",
  "codveiculo": "cod_veiculo",
  "codigo": "cod_veiculo",
  "cod": "cod_veiculo",
  "codigoveiculo": "cod_veiculo",
  "codigodoveiculo": "cod_veiculo",
  "frota": "cod_veiculo",
  "codfrota": "cod_veiculo",
  "codigofrota": "cod_veiculo",
  "idveiculo": "cod_veiculo",
  "cdveiculo": "cod_veiculo",
  "patrimonio": "cod_veiculo",
  "prefixo": "cod_veiculo",
  "codigoempresa": "cod_veiculo",
  "codveic": "cod_veiculo",
  "nro": "cod_veiculo",

  // Placa
  "placa": "placa",
  "placaveiculo": "placa",
  "nroplaca": "placa",
  "numplaca": "placa",
  "placaatual": "placa",

  // Chassi
  "chassi": "chassi",
  "chassis": "chassi",
  "numchassi": "chassi",
  "numerochassi": "chassi",
  "chassiveiculo": "chassi",
  "nrochassi": "chassi",

  // Marca / Família
  "marca": "marca",
  "familia": "marca",
  "fabricante": "marca",
  "montadora": "marca",
  "marcamodelo": "marca",
  "marcaveiculo": "marca",
  "descmarca": "marca",

  // Modelo
  "modelo": "modelo",
  "descmodelo": "modelo",
  "descricaomodelo": "modelo",
  "descricao": "modelo",
  "descricaoveiculo": "modelo",
  "veiculomodelo": "modelo",
  "modeloversao": "modelo",
  "versao": "modelo",
  "descmodeloveic": "modelo",
  "nomemodelo": "modelo",

  // Cor
  "cor": "cor",
  "corpredominante": "cor",
  "corveiculo": "cor",
  "desccor": "cor",

  // Ano / Fabricação / Modelo
  "ano": "ano",
  "anomodelo": "ano_mod",
  "anofabricacao": "ano_fab",
  "anofabmod": "ano",
  "anomodelofabricacao": "ano",
  "anofab": "ano_fab",
  "anomod": "ano_mod"
};

const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "").trim();

function ehPlanilha(b: Uint8Array): boolean {
  const xlsx = [0x50, 0x4b, 0x03, 0x04];                              // zip
  const xls = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];       // OLE2
  return xlsx.every((v, i) => b[i] === v) || xls.every((v, i) => b[i] === v);
}

function base64ParaBytes(b64: string): Uint8Array {
  const limpo = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(limpo);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return erro(req, "METODO_INVALIDO", "Use POST.", 405);

  let corpo: unknown;
  try {
    corpo = await corpoJson(req, 12 * 1024 * 1024);
  } catch {
    return erro(req, "ARQUIVO_GRANDE", "Arquivo acima do limite de 8 MB.", 413);
  }

  const v = validar(schemaImportacao, corpo);
  if (!v.ok) return erro(req, "ENTRADA_INVALIDA", v.mensagem, 400);

  const sb = clienteDoUsuario(req);
  const usuario = await usuarioAutenticado(sb);
  if (!usuario) return erro(req, "NAO_AUTENTICADO", "Faça login novamente.", 401);

  const limite = await limitar(sb, "importacao", 5, 60);
  if (limite) return erro(req, limite.code, limite.message, 429);

  let bytes: Uint8Array;
  try {
    bytes = base64ParaBytes(v.valor.arquivo_base64);
  } catch {
    return erro(req, "ARQUIVO_INVALIDO", "Não foi possível ler o arquivo enviado.", 400);
  }
  if (bytes.length > 8 * 1024 * 1024) {
    return erro(req, "ARQUIVO_GRANDE", "Arquivo acima do limite de 8 MB.", 413);
  }
  if (!ehPlanilha(bytes)) {
    return erro(req, "ARQUIVO_INVALIDO", "Envie uma planilha .xls ou .xlsx.", 422);
  }

  let linhas: Record<string, string>[];
  try {
    const wb = XLSX.read(bytes, { type: "array", cellDates: false, cellText: true });
    const aba = wb.Sheets[wb.SheetNames[0]];
    if (!aba) return erro(req, "ARQUIVO_INVALIDO", "Planilha sem abas.", 422);

    const matriz = XLSX.utils.sheet_to_json<string[]>(aba, {
      header: 1, raw: false, defval: "", blankrows: false,
    });
    if (matriz.length < 2) return erro(req, "ARQUIVO_VAZIO", "A planilha não tem linhas de dados.", 422);

    // Busca a linha do cabeçalho escaneando as primeiras 20 linhas
    let linhaCabecalhoIdx = -1;
    let indices: Record<string, number> = {};

    for (let r = 0; r < Math.min(20, matriz.length); r++) {
      const row = (matriz[r] as string[]).map((c) => normalizar(String(c ?? "")));
      const tempIndices: Record<string, number> = {};

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
      return erro(req, "CABECALHO_INVALIDO",
        'Cabeçalho não encontrado. A planilha deve conter colunas como "NroVeiculo", "Veículo", "Placa", "Chassi" ou "Modelo".', 422);
    }

    linhas = matriz.slice(linhaCabecalhoIdx + 1).map((l) => {
      const obj: Record<string, string> = {};
      for (const [campo, i] of Object.entries(indices)) {
        obj[campo] = String((l as string[])[i] ?? "").trim();
      }

      // Se ano_fab e ano_mod vierem em colunas separadas (ex: NroVeiculo, AnoFab, AnoMod)
      if (!obj["ano"] && (obj["ano_fab"] || obj["ano_mod"])) {
        const fab = obj["ano_fab"] || "";
        const mod = obj["ano_mod"] || fab;
        obj["ano"] = fab ? `${fab}/${mod}` : mod;
      }

      // Se cod_veiculo não veio preenchido, usa a Placa ou Chassi como fallback
      if (!obj["cod_veiculo"]) {
        if (obj["placa"]) obj["cod_veiculo"] = obj["placa"];
        else if (obj["chassi"]) obj["cod_veiculo"] = obj["chassi"];
      }

      return obj;
    }).filter((o) => o["cod_veiculo"] || o["placa"] || o["chassi"] || o["modelo"]);
  } catch (e) {
    console.error("falha_parse_planilha", String(e));
    return erro(req, "ARQUIVO_INVALIDO", "Não foi possível interpretar a planilha.", 422);
  }

  if (linhas.length === 0) return erro(req, "ARQUIVO_VAZIO", "Nenhuma linha válida de veículos encontrada.", 422);
  if (linhas.length > 20000) return erro(req, "ARQUIVO_GRANDE", "Máximo de 20000 linhas por lote.", 413);

  const { data, error } = await sb.rpc("importar_veiculos", { p_linhas: linhas });
  if (error) return erroDoBanco(req, error);
  return ok(req, data);
});
