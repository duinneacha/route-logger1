const CACHE = "route-notes-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/db.js",
  "./js/geo.js",
  "./js/speech.js",
  "./js/record.js",
  "./js/transcribe.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable.png",
  "./fonts/AtkinsonHyperlegible-Regular.ttf",
  "./fonts/AtkinsonHyperlegible-Bold.ttf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(windows.map((client) => (
        client.navigate ? client.navigate(client.url).catch(() => null) : null
      )));
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const saved = cache.match(event.request).then((hit) => (
        hit || (event.request.mode === "navigate" ? cache.match("./index.html") : null)
      ));
      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response.ok ? response : null;
        })
        .catch(() => null);
      const quick = await Promise.race([
        fresh,
        saved.then(() => new Promise((resolve) => setTimeout(() => resolve("slow"), 3000))),
      ]);
      if (quick && quick !== "slow") return quick;
      const cached = await saved;
      if (cached) return cached;
      const response = await fresh;
      if (response) return response;
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })()
  );
});
