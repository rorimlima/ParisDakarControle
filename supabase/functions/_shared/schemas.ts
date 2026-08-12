import { z } from "https://esm.sh/zod@3.23.8";

// Validação por schema na borda, antes de qualquer regra de negócio.
export const TIPOS_MOVIMENTACAO = [
  "ENTRADA_PORTARIA",
  "SAIDA_PORTARIA",
  "CHEGADA_DESTINO",
  "SAIDA_DESTINO",
] as const;

export const TIPOS_FOTO = [
  "DIANTEIRA", "TRASEIRA", "LATERAL_ESQUERDA", "LATERAL_DIREITA",
  "INTERIOR", "PAINEL", "KM", "AVARIA",
] as const;

export const NIVEIS_COMBUSTIVEL = [
  "VAZIO", "UM_QUARTO", "METADE", "TRES_QUARTOS", "CHEIO",
] as const;

export const schemaRegistrarMovimentacao = z.object({
  acao: z.literal("registrar"),
  veiculo_id: z.string().uuid(),
  tipo: z.enum(TIPOS_MOVIMENTACAO),
  portaria_id: z.string().uuid().nullish(),
  destino_id: z.string().uuid().nullish(),
  data_hora: z.string().datetime({ offset: true }).nullish(),
  observacoes: z.string().max(1000).nullish(),
  client_op_id: z.string().uuid().nullish(),
});

export const schemaDecidirMovimentacao = z.object({
  acao: z.literal("decidir"),
  movimentacao_id: z.string().uuid(),
  decisao: z.enum(["APROVADO", "REJEITADO"]),
  observacoes: z.string().max(1000).nullish(),
});

export const schemaMovimentacoes = z.discriminatedUnion("acao", [
  schemaRegistrarMovimentacao,
  schemaDecidirMovimentacao,
]);

export const schemaVistoria = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("registrar"),
    movimentacao_id: z.string().uuid(),
    km: z.number().int().min(0).max(3_000_000).nullish(),
    nivel_combustivel: z.enum(NIVEIS_COMBUSTIVEL).nullish(),
    observacoes: z.string().max(1000).nullish(),
    client_op_id: z.string().uuid().nullish(),
  }),
  z.object({
    acao: z.literal("registrar_foto"),
    vistoria_id: z.string().uuid(),
    tipo: z.enum(TIPOS_FOTO),
    // caminho dentro do bucket, sempre começando pela pasta da vistoria
    url: z.string().min(3).max(500).regex(
      /^[0-9a-f-]{36}\/[A-Za-z0-9_.-]{1,120}$/,
      "caminho invalido",
    ),
  }),
]);

export const schemaImportacao = z.object({
  // base64 do arquivo .xls/.xlsx (limite aplicado antes do parse)
  arquivo_base64: z.string().min(16).max(12_000_000),
  nome_arquivo: z.string().max(200).optional(),
});

export function validar<T>(schema: z.ZodType<T>, dados: unknown):
  { ok: true; valor: T } | { ok: false; mensagem: string } {
  const r = schema.safeParse(dados);
  if (r.success) return { ok: true, valor: r.data };
  const primeiro = r.error.issues[0];
  return { ok: false, mensagem: `${primeiro.path.join(".") || "corpo"}: ${primeiro.message}` };
}
