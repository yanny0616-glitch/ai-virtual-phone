// 服务端出网请求的代理感知 fetch(通用版,tripo 路由的同款方案)。
// 本地 dev 时开发机常靠系统代理才能出网,而 Node 的 fetch 不读代理环境变量
// (curl 读,所以「curl 通、route 超时/500」)。这里检测到 HTTPS_PROXY/HTTP_PROXY
// 就挂 undici ProxyAgent;线上(Netlify)无代理环境变量,行为与原生 fetch 完全一致。

import { ProxyAgent, type Dispatcher } from "undici";

let dispatcher: Dispatcher | null | undefined;

function getProxyDispatcher(): Dispatcher | null {
  if (dispatcher !== undefined) return dispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  try {
    dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  } catch {
    dispatcher = null;
  }
  return dispatcher;
}

export function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy = getProxyDispatcher();
  if (!proxy) return fetch(url, init);
  return fetch(url, { ...init, dispatcher: proxy } as RequestInit);
}

/**
 * 目标地址来自用户输入时用这个（例如用户自填的 baseUrl）：
 * 拦住本机/内网/云元数据地址，重定向逐跳校验，跨域跳转时去掉 Authorization。
 * FormData 先序列化成字节，避免 npm undici 与 Node 内置 FormData 类不互认。
 */
export async function safeProxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { safeOutboundFetch } = await import("./server/safe-outbound-fetch");
  let nextInit = init;
  if (typeof FormData !== "undefined" && init.body instanceof FormData) {
    const encoded = new Request("https://local.invalid/", { method: "POST", body: init.body });
    const headers = new Headers(init.headers);
    const contentType = encoded.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    nextInit = { ...init, headers, body: new Uint8Array(await encoded.arrayBuffer()) };
  }
  return safeOutboundFetch(url, nextInit, getProxyDispatcher() ?? undefined);
}
