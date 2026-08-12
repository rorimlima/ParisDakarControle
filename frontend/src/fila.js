// =====================================================================
// Fila offline (IndexedDB) + cache de leitura.
//
// Cada operação carrega um client_op_id gerado no cliente. A RPC usa esse id
// como chave de idempotência: reenvio depois de timeout não duplica registro.
// Operações são reenviadas em ORDEM de criação — fora de ordem, uma saída
// chegaria antes da entrada.
// =====================================================================

const BANCO = "pd-controle";
const VERSAO = 1;
export const FILA = "fila";
export const CACHE = "cache";

let dbPromise = null;

function abrir() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(BANCO, VERSAO);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILA)) {
        const s = db.createObjectStore(FILA, { keyPath: "id" });
        s.createIndex("criado_em", "criado_em");
      }
      if (!db.objectStoreNames.contains(CACHE)) {
        db.createObjectStore(CACHE, { keyPath: "chave" });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
}

async function tx(store, modo, fn) {
  const db = await abrir();
  return new Promise((res, rej) => {
    const t = db.transaction(store, modo);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result ?? r);
    t.onerror = () => rej(t.error);
  });
}

export const uuid = () =>
  (crypto.randomUUID?.() ??
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    }));

// ---------------------------------------------------------------- fila
export async function enfileirar(tipo, payload) {
  const item = {
    id: payload.client_op_id ?? uuid(),
    tipo,
    payload,
    criado_em: new Date().toISOString(),
    tentativas: 0,
    erro: null,
  };
  await tx(FILA, "readwrite", (s) => s.put(item));
  return item;
}

export async function listarFila() {
  const itens = await tx(FILA, "readonly", (s) => s.getAll());
  return (itens ?? []).sort((a, b) => a.criado_em.localeCompare(b.criado_em));
}

export const removerDaFila = (id) => tx(FILA, "readwrite", (s) => s.delete(id));

export async function marcarErro(id, mensagem) {
  const itens = await listarFila();
  const item = itens.find((i) => i.id === id);
  if (!item) return;
  item.erro = mensagem;
  item.tentativas += 1;
  await tx(FILA, "readwrite", (s) => s.put(item));
}

export async function limparErro(id) {
  const itens = await listarFila();
  const item = itens.find((i) => i.id === id);
  if (!item) return;
  item.erro = null;
  await tx(FILA, "readwrite", (s) => s.put(item));
}

// --------------------------------------------------------------- cache
export const salvarCache = (chave, valor) =>
  tx(CACHE, "readwrite", (s) => s.put({ chave, valor, em: Date.now() }));

export async function lerCache(chave) {
  const r = await tx(CACHE, "readonly", (s) => s.get(chave));
  return r?.valor ?? null;
}

export const limparTudo = async () => {
  await tx(FILA, "readwrite", (s) => s.clear());
  await tx(CACHE, "readwrite", (s) => s.clear());
};
