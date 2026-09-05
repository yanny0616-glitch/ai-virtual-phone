const CACHE_VERSION = "ai-phone-pwa-v14";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
// 角色头像缓存：页面启动时写入（lib/notification-avatar-cache.ts），
// 推送通知的 icon 从这里取，跨 SW 版本保留。
const AVATAR_CACHE = "notif-avatar-v1";
const AVATAR_PATH_PREFIX = "/notif-avatar/";

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION) && key !== AVATAR_CACHE)
          .map((key) => caches.delete(key))
      ))
      // 刷新预缓存的 "/" 快照：它是离线导航的最终兜底，若停留在旧部署版本，
      // 引用的旧 hash CSS/JS 已 404，会渲染出无样式页面（文字堆在左上角）。
      .then(() => caches.open(STATIC_CACHE))
      .then((cache) => cache.add(new Request("/", { cache: "reload" })).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    throw error;
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，升 CACHE_VERSION 即可让旧缓存在 activate 时清空。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// 离线推送：App 被杀后由系统唤起 SW 弹通知。payload 由服务端 JSON 编码。
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object"
    ? data.notification
    : null;
  const notificationData = declarative && declarative.data && typeof declarative.data === "object"
    ? declarative.data
    : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (notificationData.type === "chat_outbox") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    // 来电推送：页面可见时直接进页面振铃（来电横幅），不弹系统通知
    if (notificationData.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({
          type: "incoming_call_push",
          sessionId: notificationData.sessionId || "",
          callTs: notificationData.callTs || 0,
        }));
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    // 聊天推送带 characterId 时优先用角色头像。页面启动时把缩过尺寸的头像写进
    // AVATAR_CACHE；这里转成小 data URL 传给通知——icon 的取图不保证走 SW fetch，
    // 内联最稳。
    let icon = (declarative && declarative.icon) || data.icon || "/icon-192.png";
    const characterId = notificationData.characterId || "";
    if (characterId) {
      try {
        const cache = await caches.open(AVATAR_CACHE);
        const hit = await cache.match(AVATAR_PATH_PREFIX + encodeURIComponent(characterId));
        if (hit) {
          const bytes = new Uint8Array(await hit.arrayBuffer());
          if (bytes.length > 0 && bytes.length < 200 * 1024) {
            let raw = "";
            for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
            icon = "data:" + (hit.headers.get("content-type") || "image/png") + ";base64," + btoa(raw);
          }
        }
      } catch (error) { /* 头像缓存不可用就用默认图标 */ }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: icon,
      badge: (declarative && declarative.badge) || "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || notificationData.url || "/",
        type: notificationData.type || "",
        commandId: notificationData.commandId || "",
        sessionId: notificationData.sessionId || "",
        callTs: notificationData.callTs || 0,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || "/";
  // 点开一条聊天通知 = 人要进 App 了，把托盘里其余聊天通知一起收掉，
  // 不要进去以后旁边还挂着一串没读的弹窗。
  if (!notificationData.type || notificationData.type === "chat_outbox") {
    event.waitUntil(self.registration.getNotifications().then((list) => {
      list.forEach((item) => {
        const t = (item.data && item.data.type) || "";
        if (!t || t === "chat_outbox") item.close();
      });
    }).catch(() => {}));
  }
  if (notificationData.type === "shortcut_command") {
    // iOS silently ignores custom URL schemes passed to clients.openWindow().
    event.waitUntil((async () => {
      const absoluteUrl = new URL(targetUrl, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // 有活窗口：不导航（navigate 会杀掉 SPA，回来一片空白、进行中的生成全断）。
      // 交给页面自己 location 到 /shortcut-run——302 到 shortcuts:// 属于外部 App
      // 启动，WebKit 不会卸载当前页面，聊天界面与本地生成原地保留。
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "run_shortcut", url: absoluteUrl });
          return client.focus();
        }
      }
      // App 已被杀：没有页面可保，开新窗口走 /shortcut-run 跳转
      return self.clients.openWindow(absoluteUrl);
    })());
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if (notificationData.type === "chat_outbox") {
            client.postMessage({ type: "push_outbox_ready" });
          }
          if (notificationData.type === "incoming_call") {
            // 有活窗口：不导航（会杀掉 SPA），交给页面弹来电横幅 + 合并 outbox
            client.postMessage({
              type: "incoming_call_push",
              sessionId: notificationData.sessionId || "",
              callTs: notificationData.callTs || 0,
            });
            client.postMessage({ type: "push_outbox_ready" });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method === "GET" && new URL(request.url).pathname.startsWith(AVATAR_PATH_PREFIX)) {
    // 通知 icon 的取图请求：只存在于头像缓存里，不回源
    event.respondWith(
      caches.open(AVATAR_CACHE)
        .then((cache) => cache.match(request))
        .then((hit) => hit || new Response("", { status: 404 }))
    );
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
