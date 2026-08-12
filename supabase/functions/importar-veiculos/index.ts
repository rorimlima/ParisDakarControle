// =====================================================================
// POST /functions/v1/importar-veiculos   { arquivo_base64, nome_arquivo? }
//
// Aceita .xls (BIFF, que é o formato real do Rel_MalaDireta.xls) e .xlsx.
// O mapeamento é por NOME DA COLUNA, normalizado sem acento e sem caixa —
// posição de coluna muda a cada exportação do ERP, nome não.
// A persistência inteira acontece numa única RPC transacional.
// =====================================================================
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { preflight } from "../_shared/cors.ts";
import { ok, erro, erroDoBanco, corpoJson } from "../_shared/http.ts";
import { clienteDoUsuario, usuarioAutenticado } from "../_shared/auth.ts";
import { schemaImportacao, validar } from "../_shared/schemas.ts";
import { limitar } from "../_shared/ratelimit.ts";

const MAPA_COLUNAS: Record<string, string> = {
  familia: "marca",
  modelo: "modelo",
  chassi: "chassi",
  placa: "placa",
  veiculo: "cod_veiculo",
  ano: "ano",
  cor: "cor",
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
  // A autorização MASTER é decidida na RPC (app.eh_master()), não aqui.

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

    // header:1 -> matriz crua; a primeira linha é o cabeçalho.
    const matriz = XLSX.utils.sheet_to_json<string[]>(aba, {
      header: 1, raw: false, defval: "", blankrows: false,
    });
    if (matriz.length < 2) return erro(req, "ARQUIVO_VAZIO", "A planilha não tem linhas de dados.", 422);

    const cabecalho = (matriz[0] as string[]).map((c) => normalizar(String(c ?? "")));
    const indices: Record<string, number> = {};
    cabecalho.forEach((nome, i) => {
      const campo = MAPA_COLUNAS[nome];
      if (campo && indices[campo] === undefined) indices[campo] = i;
    });

    if (indices["cod_veiculo"] === undefined) {
      return erro(req, "CABECALHO_INVALIDO",
        'Coluna "Veículo" não encontrada no cabeçalho da planilha.', 422);
    }

    linhas = matriz.slice(1).map((l) => {
      const obj: Record<string, string> = {};
      for (const [campo, i] of Object.entries(indices)) {
        obj[campo] = String((l as string[])[i] ?? "").trim();
      }
      return obj;
    }).filter((o) => Object.values(o).some((x) => x !== ""));
  } catch (e) {
    console.error("falha_parse_planilha", String(e));
    return erro(req, "ARQUIVO_INVALIDO", "Não foi possível interpretar a planilha.", 422);
  }

  if (linhas.length === 0) return erro(req, "ARQUIVO_VAZIO", "Nenhuma linha de dados.", 422);
  if (linhas.length > 20000) return erro(req, "ARQUIVO_GRANDE", "Máximo de 20000 linhas.", 413);

  const { data, error } = await sb.rpc("importar_veiculos", { p_linhas: linhas });
  if (error) return erroDoBanco(req, error);
  return ok(req, data);
});
