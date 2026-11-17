/* Service Worker PhysioPulse Telemetry — Network-First App Shell (zéro cache API externe) */
const CACHE_NAME = "physiopulse-v202611172005";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./vault.js",
  "./intervals_client.js",
  "./physio_engine.js",
  "./gemini_client.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png', './icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        await Promise.allSettled(
          ASSETS.map(async (assetUrl) => {
            const response = await fetch(assetUrl, { cache: "no-cache" });
            if (response.ok) {
              await cache.put(assetUrl, response);
            }
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Ne jamais intercepter ni mettre en cache les appels API externes
  if (url.hostname.includes("intervals.icu") || url.hostname.includes("googleapis.com")) {
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Stratégie Network-First pour les requêtes GET de même origine
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});






