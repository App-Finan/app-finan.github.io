const CACHE_NAME = "financegold-shell-v77";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/config.js",
  "./js/tenants.js",
  "./js/seguranca.js",
  "./js/inicio.js",
  "./js/segmentos.js",
  "./js/senha.js",
  "./js/login-senha.js",
  "./js/completar-cadastro.js",
  "./js/push.js",
  "./js/esquema.js",
  "./js/abas.js",
  "./js/auth.js",
  "./js/sheets.js",
  "./js/lancamentos.js",
  "./js/lookups.js",
  "./js/roles.js",
  "./js/usuarios.js",
  "./js/usuarios-admin.js",
  "./js/listas-admin.js",
  "./js/modelo.js",
  "./js/conectar.js",
  "./js/sistema.js",
  "./js/solicitar-acesso.js",
  "./js/art.js",
  "./js/dashboard-data.js",
  "./js/charts.js",
  "./js/dashboard.js",
  "./js/lancamento-lista.js",
  "./js/offline.js",
  "./js/form.js",
  "./js/sw-register.js",
  "./js/estoque.js",
  "./js/estoque-ui.js",
  "./js/fornecedores.js",
  "./js/fornecedores-ui.js",
  "./js/contas.js",
  "./js/contas-ui.js",
  "./js/relatorio.js",
  "./js/relatorio-pdf.js",
  "./js/export.js",
  "./js/command-palette.js",
  "./js/nav.js",
  "./js/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Only ever intercepts same-origin requests (the app's own files). API calls
// to googleapis.com / accounts.google.com pass straight through to the
// network untouched — they need to be live and authenticated, never cached.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  // Network-first, cache as the offline fallback. This used to be
  // cache-first, which meant a phone that had visited the site once kept
  // showing the old HTML/CSS/JS after a deploy (the new version only landed
  // on the *next* load). `cache: "no-cache"` also bypasses GitHub Pages'
  // 10-minute HTTP cache so a fresh deploy shows up immediately when online.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      // Offline (or the fetch failed): serve the cached copy. If there is
      // none either (e.g. the browser's automatic /favicon.ico probe),
      // resolve to a real Response — respondWith() can't turn `undefined`
      // into one and would crash with "Failed to convert value to 'Response'".
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || new Response("", { status: 504, statusText: "Offline" }))
      )
  );
});

// Push notifications (2026-10-10, see js/push.js and CLAUDE.md "Notificações
// push"): shows a system notification when a push arrives while the app
// isn't the focused tab (the foreground case is handled on the page itself,
// in js/push.js's onMessage). A service worker can't import js/config.js as
// module state, only via importScripts — these six values are public,
// non-secret Firebase web config (same ones as js/config.js's FIREBASE_CONFIG;
// keep both in sync if the Firebase project ever changes).
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyAn7U2v2Pc47vwRLbUumOC1OkjSSQvfkPw",
  authDomain: "finan-push.firebaseapp.com",
  projectId: "finan-push",
  storageBucket: "finan-push.firebasestorage.app",
  messagingSenderId: "564828633413",
  appId: "1:564828633413:web:620496958eab957b1da62c",
});
firebase.messaging().onBackgroundMessage((payload) => {
  const notificacao = (payload && payload.notification) || {};
  const link = (payload.fcmOptions && payload.fcmOptions.link) || (payload.data && payload.data.link) || "./";
  self.registration.showNotification(notificacao.title || "Finan.", {
    body: notificacao.body || "",
    icon: "./icons/icon-192.png",
    data: { link: link },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "./";
  event.waitUntil(clients.openWindow(link));
});
