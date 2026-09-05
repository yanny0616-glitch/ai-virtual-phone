import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

// DOM 与 npm Undici 各自声明 Web API 类型；运行时 fetch 和 dispatcher 必须来自同一版本。
const fetchWithDispatcher = undiciFetch as unknown as (
  input: URL, init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;

const MAX_REDIRECTS = 5;

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function expandIpv6(address: string): number[] | null {
  const clean = address.toLowerCase().split("%")[0];
  const ipv4Match = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let normalized = clean;
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[2]);
    if (!ipv4) return null;
    normalized = `${ipv4Match[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const raw = [...left, ...Array(missing).fill("0"), ...right];
  const parts = raw.map(part => Number.parseInt(part || "0", 16));
  return parts.length === 8 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? parts
    : null;
}

function isNonPublicIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts) return true;
  const [a, b, c, d, e, f, g, h] = parts;
  const isMappedIpv4 = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (isMappedIpv4) {
    return isNonPublicIpv4(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  }
  const isUnspecifiedOrLoopback = parts.slice(0, 7).every(part => part === 0);
  return isUnspecifiedOrLoopback
    || (a & 0xfe00) === 0xfc00
    || (a & 0xffc0) === 0xfe80
    || (a & 0xff00) === 0xff00
    || (a === 0x2001 && (b === 0 || b === 2 || b === 0x0db8))
    || a === 0x2002;
}

function isNonPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isNonPublicIpv4(address);
  if (family === 6) return isNonPublicIpv6(address);
  return true;
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  if (isIP(hostname)) {
    if (isNonPublicIp(hostname)) throw new UnsafeOutboundUrlError("不允许访问本机、内网或保留地址");
    return [{ address: hostname, family: isIP(hostname) }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeOutboundUrlError("目标域名没有可用地址");
  if (addresses.some(item => isNonPublicIp(item.address))) {
    throw new UnsafeOutboundUrlError("目标域名解析到了本机、内网或保留地址");
  }
  return addresses;
}

export async function assertSafeOutboundUrl(rawUrl: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError("URL 格式不合法");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeOutboundUrlError("只允许 http/https URL");
  }
  if (url.username || url.password) throw new UnsafeOutboundUrlError("URL 不允许包含用户名或密码");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new UnsafeOutboundUrlError("不允许访问本机或内网域名");
  }
  await resolvePublicAddresses(hostname);
  return url;
}

const secureLookup: LookupFunction = (hostname, options, callback) => {
  resolvePublicAddresses(hostname)
    .then(addresses => {
      const requestedFamily = options?.family === "IPv4" ? 4 : options?.family === "IPv6" ? 6 : options?.family;
      const selected = addresses.filter(item => !requestedFamily || item.family === requestedFamily);
      if (selected.length === 0) throw new UnsafeOutboundUrlError("目标域名没有指定地址族的可用地址");
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    })
    .catch(error => callback(error instanceof Error ? error : new Error(String(error)), []));
};

const directDispatcher = new Agent({ connect: { lookup: secureLookup } });

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function safeOutboundFetch(
  rawUrl: string | URL,
  init: RequestInit = {},
  dispatcher?: Dispatcher,
): Promise<Response> {
  let current = await assertSafeOutboundUrl(rawUrl);
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithDispatcher(current, {
      ...init,
      method,
      headers,
      body,
      redirect: "manual",
      dispatcher: dispatcher ?? directDispatcher,
    });

    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new UnsafeOutboundUrlError(`重定向超过 ${MAX_REDIRECTS} 次`);
    }

    const previousOrigin = current.origin;
    const next = await assertSafeOutboundUrl(new URL(location, current));
    await response.body?.cancel().catch(() => undefined);
    if (next.origin !== previousOrigin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-length");
      headers.delete("content-type");
    }
    current = next;
  }

  throw new UnsafeOutboundUrlError("重定向处理失败");
}
