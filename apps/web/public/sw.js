// 让浏览器认可"安装到主屏幕"，断网时也能打开。
// 只处理本站的 GET 请求；发给 AI 服务商的请求（跨域）不经过这里，也不缓存。
// 换版本号时，激活后删掉旧版本的缓存。
const CACHE = 'ai-mobile-v3';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // 一个文件取不到不要让整个安装失败（失败的 Service Worker 会让浏览器一直认为"不能安装"）
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => undefined)))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Web Push wakes this worker even with every App window closed. Generation happens in Cloudflare.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* still show a visible notification */ }
  const route = typeof data.route === 'string' && /^\/(chat|call|me)(\/|$)/.test(data.route) ? data.route : '/';
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'AI 陪伴', {
      body: data.body || '你有一条新消息', tag: data.tag || 'ai-mobile',
      icon: new URL('icons/icon-192.png', self.registration.scope).href,
      data: { route },
    }),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'hub-inbox' });
    }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(self.registration.scope);
  const route = event.notification.data?.route;
  target.hash = typeof route === 'string' && /^\/(chat|call|me)(\/|$)/.test(route) ? route : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((c) => c.url.startsWith(self.registration.scope));
    if (existing) {
      const navigated = await existing.navigate(target.href);
      if (navigated) { await navigated.focus(); return; }
    }
    await self.clients.openWindow(target.href);
  })());
});

// 页面上的"清理安装数据"：删掉全部缓存
self.addEventListener('message', (event) => {
  if (event.data === 'clear-caches') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // 页面先走网络（拿到新版本），断网时用缓存
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./').then((hit) => hit || Response.error())),
    );
    return;
  }
  // manifest 和 sw.js 本身总是先走网络：改了安装信息（名字、图标、id）浏览器能马上看到
  if (/\/(?:manifest\.webmanifest|sw\.js)$/.test(url.pathname)) {
    event.respondWith(fetch(req).catch(() => caches.match(req).then((hit) => hit || Response.error())));
    return;
  }
  // 文件名带哈希的静态资源：有缓存用缓存，没有再取
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
