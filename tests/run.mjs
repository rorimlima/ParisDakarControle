#!/usr/bin/env node
// =====================================================================
// Testes de integração contra um Supabase real (local: `supabase start`).
// Zero dependência: só fetch.
//
//   npm run test
//
// Cobre o que quebra caro: trava anti-duplicidade sob concorrência, RLS entre
// dois usuários de manutenção, upsert da importação e vistoria obrigatória.
// =====================================================================
import { readFileSync, existsSync } from "node:fs";

function carregarEnv() {
  try {
    for (const linha of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* opcional */ }
}
carregarEnv();

const URL_SB = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON || !SERVICE) {
  console.error("Defina SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY (.env).");
  process.exit(1);
}

// ------------------------------------------------------------ helpers
const SUFIXO = Date.now().toString(36);
let passou = 0, falhou = 0;

async function teste(nome, fn) {
  try {
    await fn();
    console.log(`  ok   ${nome}`);
    passou++;
  } catch (e) {
    console.log(`  FALHA ${nome}\n        ${e.message}`);
    falhou++;
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
const igual = (a, b, msg) => ok(a === b, `${msg} (recebido: ${JSON.stringify(a)})`);

const admin = async (caminho, init = {}) => {
  const res = await fetch(`${URL_SB}${caminho}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json", ...(init.headers ?? {}),
    },
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return {
    ok: res.ok, status: res.status, raw,
    json: async () => data, text: async () => raw,
  };
};

async function criarUsuario(email, papel) {
  const senha = `Teste!${SUFIXO}aZ9`;
  const r = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email, password: senha, email_confirm: true,
      app_metadata: { papel }, user_metadata: { nome: email.split("@")[0] },
    }),
  });
  if (!r.ok) throw new Error(`criar usuário: ${await r.text()}`);
  const user = await r.json();

  // garante o perfil com o papel certo (o trigger já cria; aqui reforçamos)
  await admin(`/rest/v1/perfis_usuario?id=eq.${user.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ papel, ativo: true }),
  });

  const login = await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: senha }),
  });
  if (!login.ok) throw new Error(`login: ${await login.text()}`);
  const { access_token } = await login.json();
  return { id: user.id, email, token: access_token };
}

const comoUsuario = (u) => async (caminho, init = {}) => {
  const res = await fetch(`${URL_SB}${caminho}`, {
    ...init,
    headers: {
      apikey: ANON, Authorization: `Bearer ${u.token}`,
      "Content-Type": "application/json", ...(init.headers ?? {}),
    },
  });
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return {
    ok: res.ok, status: res.status, raw,
    json: async () => data, text: async () => raw,
  };
};

const rpc = (cli, nome, corpo) =>
  cli(`/rest/v1/rpc/${nome}`, { method: "POST", body: JSON.stringify(corpo) });

// ------------------------------------------------------------- fixture
console.log("\nPreparando ambiente de teste…");

const master = await criarUsuario(`master.${SUFIXO}@teste.local`, "MASTER");
const manutA = await criarUsuario(`manut.a.${SUFIXO}@teste.local`, "MANUTENCAO");
const manutB = await criarUsuario(`manut.b.${SUFIXO}@teste.local`, "MANUTENCAO");
const M = comoUsuario(master), A = comoUsuario(manutA), B = comoUsuario(manutB);

// portaria que exige vistoria + destino, via service_role (setup, não teste)
const criarSetup = async (tabela, corpo) => {
  const r = await admin(`/rest/v1/${tabela}`, {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) throw new Error(`${tabela}: ${await r.text()}`);
  return (await r.json())[0];
};

const portaria = await criarSetup("portarias",
  { nome: `Paris Dakar ${SUFIXO}`, codigo: `PD_${SUFIXO.toUpperCase()}`, exige_vistoria: true });
const destino = await criarSetup("destinos",
  { nome: `Patio ${SUFIXO}`, codigo: `PT_${SUFIXO.toUpperCase()}` });

// Linhas equivalentes às da planilha real, incluindo os casos sujos:
// placa vazia e chassi inválido repetido.
const PLACA_TESTE = `T${SUFIXO.toUpperCase().replace(/[^A-Z0-9]/g, '9').padEnd(6, 'X').slice(0, 6)}`;
const CHASSI_TESTE = `9BD358A${SUFIXO.toUpperCase().replace(/[^A-Z0-9]/g, '9').replace(/[IOQ]/g, 'X').padEnd(10, '8').slice(0, 10)}`;
const LINHAS = [
  { cod_veiculo: `T${SUFIXO}A`, placa: PLACA_TESTE, chassi: CHASSI_TESTE,
    marca: "FIAT - SEMINOVOS", modelo: "ARGO DRIVE 1.0", ano: "2025/2026", cor: "CINZA" },
  { cod_veiculo: `T${SUFIXO}B`, placa: "", chassi: "11",
    marca: "TOYOTA - SEMINOVOS", modelo: "COROLLA XEI 2.0", ano: "2019/2020", cor: "PRATA" },
  { cod_veiculo: `T${SUFIXO}C`, placa: "", chassi: "11",
    marca: "GWM - SEMINOVOS", modelo: "HAVAL H9", ano: "2026/2027", cor: "BRANCA" },
  { cod_veiculo: "", placa: "XXX0000", chassi: "", marca: "", modelo: "SEM CODIGO", ano: "2020" },
];

// =====================================================================
console.log("\n[1] Importação de planilha");

let idVeiculo = null;

await teste("MASTER importa e grava ano_fabricacao/ano_modelo separados", async () => {
  const r = await rpc(M, "importar_veiculos", { p_linhas: LINHAS });
  ok(r.ok, `rpc falhou: ${await r.text()}`);
  const rel = await r.json();
  igual(rel.total, 4, "total de linhas lidas");
  igual(rel.importadas, 3, "linhas importadas");
  igual(rel.erros.length, 1, "linha sem cod_veiculo deve virar erro");

  const q = await M(`/rest/v1/veiculos?cod_veiculo=eq.T${SUFIXO}A&select=*`);
  const [v] = await q.json();
  ok(v, "veículo do critério de aceite não foi gravado");
  igual(v.ano_fabricacao, 2025, "ano_fabricacao");
  igual(v.ano_modelo, 2026, "ano_modelo");
  igual(v.placa, PLACA_TESTE, "placa normalizada");
  igual(v.chassi, CHASSI_TESTE, "chassi válido preservado");
  igual(v.status, "DISPONIVEL", "status inicial");
  idVeiculo = v.id;
});

await teste("chassi inválido vira NULL com aviso, sem colidir no UNIQUE", async () => {
  const q = await M(`/rest/v1/veiculos?cod_veiculo=in.(T${SUFIXO}B,T${SUFIXO}C)&select=cod_veiculo,chassi,placa`);
  const lista = await q.json();
  igual(lista.length, 2, "as duas linhas com chassi '11' deveriam existir");
  ok(lista.every((v) => v.chassi === null), "chassi lixo deveria ter virado NULL");
  ok(lista.every((v) => v.placa === null), "placa vazia deveria ter virado NULL");
});

await teste("importar a mesma planilha duas vezes não duplica", async () => {
  const r = await rpc(M, "importar_veiculos", { p_linhas: LINHAS });
  const rel = await r.json();
  igual(rel.importadas, 0, "nada deveria ser inserido na segunda vez");
  igual(rel.atualizadas, 3, "as três linhas válidas deveriam ser atualizadas");

  const q = await M(`/rest/v1/veiculos?cod_veiculo=eq.T${SUFIXO}A&select=id`);
  igual((await q.json()).length, 1, "não pode haver duplicata de cod_veiculo");
});

await teste("MANUTENCAO não pode importar (PD003)", async () => {
  const r = await rpc(A, "importar_veiculos", { p_linhas: LINHAS });
  ok(!r.ok, "a importação deveria ser recusada");
  const e = await r.json();
  igual(e.code, "PD003", "SQLSTATE esperado PD003");
});

// =====================================================================
console.log("\n[2] Regra anti-duplicidade");

await teste("dois usuários no mesmo instante: só um consegue", async () => {
  const corpo = {
    p_veiculo_id: idVeiculo, p_tipo: "CHEGADA_DESTINO",
    p_destino_id: destino.id, p_data_hora: new Date().toISOString(),
  };
  const [ra, rb] = await Promise.all([
    rpc(A, "registrar_movimentacao", { ...corpo }),
    rpc(B, "registrar_movimentacao", { ...corpo }),
  ]);
  const sucessos = [ra, rb].filter((r) => r.ok);
  const recusas = [ra, rb].filter((r) => !r.ok);
  igual(sucessos.length, 1, "exatamente um registro deveria passar");
  igual(recusas.length, 1, "exatamente um registro deveria ser recusado");

  const erro = await recusas[0].json();
  igual(erro.code, "PD001", "SQLSTATE esperado PD001");
  ok(/pendente/i.test(erro.message), `mensagem deveria explicar a pendência: ${erro.message}`);
  ok(/Aguarde a aprova/i.test(erro.message), "mensagem deveria orientar a aguardar");
});

await teste("veículo bloqueado enquanto há pendência (inclusive para o MASTER)", async () => {
  const r = await rpc(M, "registrar_movimentacao", {
    p_veiculo_id: idVeiculo, p_tipo: "SAIDA_DESTINO", p_destino_id: destino.id,
  });
  ok(!r.ok, "master não deveria furar a trava");
  igual((await r.json()).code, "PD001", "SQLSTATE esperado PD001");
});

let movPendente = null;
await teste("após decidir, o veículo volta a aceitar movimentação", async () => {
  const q = await M(`/rest/v1/movimentacoes?veiculo_id=eq.${idVeiculo}&status=eq.PENDENTE&select=id,usuario_id`);
  const [mov] = await q.json();
  ok(mov, "deveria haver uma pendência");

  const dec = await rpc(M, "decidir_movimentacao",
    { p_movimentacao_id: mov.id, p_decisao: "APROVADO" });
  ok(dec.ok, `aprovação falhou: ${await dec.text()}`);

  const qv = await M(`/rest/v1/veiculos?id=eq.${idVeiculo}&select=status,localizacao_atual,localizacao_tipo`);
  const [v] = await qv.json();
  igual(v.status, "NO_DESTINO", "status do veículo após CHEGADA_DESTINO");
  igual(v.localizacao_atual, destino.id, "localização atual");
  igual(v.localizacao_tipo, "DESTINO", "tipo da localização");

  const nova = await rpc(A, "registrar_movimentacao", {
    p_veiculo_id: idVeiculo, p_tipo: "ENTRADA_PORTARIA", p_portaria_id: portaria.id,
  });
  ok(nova.ok, `nova movimentação deveria ser aceita: ${await nova.text()}`);
  movPendente = await nova.json();
});

await teste("idempotência: mesmo client_op_id não cria duas movimentações", async () => {
  const opId = crypto.randomUUID();
  const dec = await rpc(M, "decidir_movimentacao",
    { p_movimentacao_id: movPendente.id, p_decisao: "REJEITADO" });
  ok(dec.ok, "rejeição deveria funcionar");

  const corpo = {
    p_veiculo_id: idVeiculo, p_tipo: "SAIDA_DESTINO",
    p_destino_id: destino.id, p_client_op_id: opId,
  };
  const r1 = await rpc(A, "registrar_movimentacao", corpo);
  const r2 = await rpc(A, "registrar_movimentacao", corpo);
  ok(r1.ok && r2.ok, "os dois envios deveriam responder com sucesso");
  const [m1, m2] = [await r1.json(), await r2.json()];
  igual(m1.id, m2.id, "o segundo envio deveria devolver a mesma movimentação");
  igual(m2.idempotente, true, "o segundo envio deveria ser marcado como idempotente");

  await rpc(M, "decidir_movimentacao", { p_movimentacao_id: m1.id, p_decisao: "REJEITADO" });
});

// =====================================================================
console.log("\n[3] Vistoria obrigatória na portaria Paris Dakar");

await teste("ENTRADA_PORTARIA sem vistoria não pode ser aprovada (PD002)", async () => {
  const r = await rpc(A, "registrar_movimentacao", {
    p_veiculo_id: idVeiculo, p_tipo: "ENTRADA_PORTARIA", p_portaria_id: portaria.id,
  });
  ok(r.ok, `registro deveria passar: ${await r.text()}`);
  const mov = await r.json();

  const dec = await rpc(A, "decidir_movimentacao",
    { p_movimentacao_id: mov.id, p_decisao: "APROVADO" });
  ok(!dec.ok, "aprovação sem vistoria deveria falhar");
  igual((await dec.json()).code, "PD002", "SQLSTATE esperado PD002");

  // vistoria sem foto ainda não libera
  const vis = await rpc(A, "registrar_vistoria",
    { p_movimentacao_id: mov.id, p_km: 42000, p_nivel_combustivel: "METADE" });
  ok(vis.ok, `vistoria deveria ser criada: ${await vis.text()}`);
  const vistoria = await vis.json();

  const dec2 = await rpc(A, "decidir_movimentacao",
    { p_movimentacao_id: mov.id, p_decisao: "APROVADO" });
  ok(!dec2.ok, "vistoria sem foto não deveria liberar a aprovação");
  igual((await dec2.json()).code, "PD002", "SQLSTATE esperado PD002");

  // com foto registrada, libera
  const caminho = `${vistoria.id}/DIANTEIRA_${Date.now()}.jpg`;
  const foto = await rpc(A, "registrar_foto_vistoria",
    { p_vistoria_id: vistoria.id, p_tipo: "DIANTEIRA", p_url: caminho });
  ok(foto.ok, `registro da foto deveria funcionar: ${await foto.text()}`);

  const dec3 = await rpc(A, "decidir_movimentacao",
    { p_movimentacao_id: mov.id, p_decisao: "APROVADO" });
  ok(dec3.ok, `com foto, a aprovação deveria passar: ${await dec3.text()}`);
});

await teste("foto fora da pasta da própria vistoria é recusada (PD007)", async () => {
  const q = await A(`/rest/v1/vistorias?select=id&limit=1`);
  const [v] = await q.json();
  const r = await rpc(A, "registrar_foto_vistoria",
    { p_vistoria_id: v.id, p_tipo: "AVARIA", p_url: `${crypto.randomUUID()}/AVARIA_1.jpg` });
  ok(!r.ok, "caminho de outra vistoria deveria ser recusado");
  igual((await r.json()).code, "PD007", "SQLSTATE esperado PD007");
});

// =====================================================================
console.log("\n[4] Permissões (RLS)");

await teste("MANUTENCAO B não vê as movimentações de A", async () => {
  const qa = await A("/rest/v1/movimentacoes?select=id");
  const qb = await B("/rest/v1/movimentacoes?select=id");
  const [la, lb] = [await qa.json(), await qb.json()];
  ok(la.length > 0, "A deveria ver as próprias movimentações");
  const idsA = new Set(la.map((m) => m.id));
  ok(lb.every((m) => !idsA.has(m.id)), "B enxergou registro de A — RLS furada");
});

await teste("MANUTENCAO não decide movimentação de outro usuário (PD003)", async () => {
  const r = await rpc(A, "registrar_movimentacao", {
    p_veiculo_id: idVeiculo, p_tipo: "SAIDA_PORTARIA", p_portaria_id: portaria.id,
  });
  ok(r.ok, "registro deveria passar");
  const mov = await r.json();

  const dec = await rpc(B, "decidir_movimentacao",
    { p_movimentacao_id: mov.id, p_decisao: "APROVADO" });
  ok(!dec.ok, "B não deveria decidir movimentação de A");
  igual((await dec.json()).code, "PD003", "SQLSTATE esperado PD003");

  await rpc(M, "decidir_movimentacao", { p_movimentacao_id: mov.id, p_decisao: "REJEITADO" });
});

await teste("MASTER vê tudo", async () => {
  const q = await M("/rest/v1/movimentacoes?select=id");
  ok((await q.json()).length >= 3, "master deveria ver as movimentações de todos");
});

await teste("MANUTENCAO não cadastra veículo direto na tabela", async () => {
  const r = await A("/rest/v1/veiculos", {
    method: "POST", body: JSON.stringify({ cod_veiculo: `HACK${SUFIXO}` }),
  });
  ok(!r.ok, "insert de veículo por MANUTENCAO deveria ser bloqueado pela RLS");
});

await teste("cliente não insere movimentação direto na tabela (só via RPC)", async () => {
  const r = await A("/rest/v1/movimentacoes", {
    method: "POST",
    body: JSON.stringify({
      veiculo_id: idVeiculo, tipo: "ENTRADA_PORTARIA", portaria_id: portaria.id,
      usuario_id: manutA.id, data_hora: new Date().toISOString(),
    }),
  });
  ok(!r.ok, "insert direto furaria a trava anti-duplicidade e deve ser bloqueado");
});

await teste("MANUTENCAO não se promove a MASTER", async () => {
  const r = await A(`/rest/v1/perfis_usuario?id=eq.${manutA.id}`, {
    method: "PATCH", body: JSON.stringify({ papel: "MASTER" }),
  });
  const corpo = r.ok ? await r.json().catch(() => null) : null;
  const q = await A(`/rest/v1/perfis_usuario?id=eq.${manutA.id}&select=papel`);
  const [p] = await q.json();
  igual(p.papel, "MANUTENCAO", `escalação de privilégio ocorreu ${JSON.stringify(corpo)}`);
});

await teste("anon não lê nada", async () => {
  const r = await fetch(`${URL_SB}/rest/v1/veiculos?select=id`, { headers: { apikey: ANON } });
  const lista = r.ok ? await r.json() : [];
  igual(Array.isArray(lista) ? lista.length : 0, 0, "anon não deveria ler veículos");
});

// =====================================================================
console.log("\n[5] Rate limit");

await teste("rajada de importações é barrada (PD006, limite 5/min)", async () => {
  // Importação commita a cada chamada, então o contador persiste.
  let bloqueou = false;
  for (let i = 0; i < 8 && !bloqueou; i++) {
    const r = await rpc(M, "importar_veiculos", { p_linhas: [LINHAS[0]] });
    if (!r.ok && (await r.json()).code === "PD006") bloqueou = true;
  }
  ok(bloqueou, "o limite de 5 importações/min deveria disparar PD006");
});

await teste("checar_limite barra rajada em transação própria", async () => {
  let bloqueou = false;
  for (let i = 0; i < 12 && !bloqueou; i++) {
    const r = await rpc(B, "checar_limite",
      { p_recurso: "teste", p_limite: 5, p_janela_segundos: 60 });
    if (!r.ok && (await r.json()).code === "PD006") bloqueou = true;
  }
  ok(bloqueou, "checar_limite deveria estourar em PD006");
});

// =====================================================================
// Limpeza: remove os usuários de teste (dados ficam para inspeção manual).
for (const u of [master, manutA, manutB]) {
  await admin(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" }).catch(() => {});
}

const arquivoPlanilha = new URL("../docs/Rel_MalaDireta.xls", import.meta.url);
if (existsSync(arquivoPlanilha)) {
  console.log("\nObs.: o mapeamento por nome de coluna do arquivo .xls é testado pela");
  console.log("Edge Function: `supabase functions serve` + `npm run importar`.");
}

console.log(`\n=== ${passou} passaram, ${falhou} falharam ===\n`);
process.exit(falhou ? 1 : 0);
