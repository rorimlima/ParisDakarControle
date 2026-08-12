// =====================================================================
// Service Worker — casca do app em cache para funcionar offline.
// Nada de API entra em cache: resposta de dado sensível guardada no
// CacheStorage sobreviveria ao logout.
// =====================================================================
const VERSAO = "pd-v1";
const CASCA = [
  "/", "/index.html", "/styles.css", "/manifest.webmanifest",
  "/icons/icone.svg", "/config.js",
  "/src/tema.js", "/src/app.js", "/src/ui.js", "/src/api.js",
  "/src/fila.js", "/src/supabase.js", "/src/paginas.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSAO)
      .then((c) => Promise.allSettled(CASCA.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const ehApi = url.pathname.startsWith("/rest/v1")
    || url.pathname.startsWith("/functions/v1")
    || url.pathname.startsWith("/auth/v1")
    || url.pathname.startsWith("/storage/v1");
  if (ehApi) return; // sempre rede; sem cache de dado

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/index.html")));
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return resp;
      }).catch(() => hit)
    ),
  );
});

// A fila offline é reprocessada pelo app; o SW só avisa que voltou a rede.
self.addEventListener("sync", (e) => {
  if (e.tag === "sincronizar-fila") {
    e.waitUntil(
      self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ tipo: "SINCRONIZAR" }))),
    );
  }
});
