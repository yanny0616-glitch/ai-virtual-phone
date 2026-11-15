// 出站请求设防（SSRF）：模型地址和 MCP 地址是手机寄来的，谁拿着密钥谁就能填。
// 不设防的话可以让后端去请求本机或内网的服务，再从回复里把内容读回去。
// 这里在每次请求前把主机名解析一遍，指向本机 / 内网 / 链路本地的一律不请求，也不跟随跳转。
// 没做的：解析和真正建连是两次解析，DNS 重绑定理论上还能钻这个空子（要钉住解析结果得换 HTTP 客户端）。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;
export type GuardedFetch = (url: string, init: RequestInit) => Promise<Response>;

const systemResolve: Resolver = async host => (await lookup(host, { all: true })).map(a => a.address);

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** 本机、内网、链路本地、组播、保留段都算 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true; // 不是 IP：按不可信处理
  const s = ip.toLowerCase().split("%")[0];
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Private(mapped[1]);
  // ::ffff:7f00:1 这种十六进制写法的 v4 映射地址：一律不放
  if (s.startsWith("::ffff:") || s.startsWith("64:ff9b:")) return true;
  if (s === "::" || s === "::1") return true;
  const head = parseInt(s.split(":")[0] || "0", 16);
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xff00) === 0xff00;
}

export function parseAllowHosts(raw: string | undefined): Set<string> {
  return new Set(String(raw || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** 地址指向本机或内网就抛错；allowHosts 里的主机名放行（自己在本机起的模型网关） */
export async function assertPublicUrl(raw: string, allowHosts: Set<string> = new Set(), resolve: Resolver = systemResolve): Promise<void> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("请求地址无效"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("请求地址只能是 http / https");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowHosts.has(host)) return;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = await resolve(host); }
    catch { throw new Error(`${host} 解析不出地址`); }
  }
  if (!addrs.length) throw new Error(`${host} 解析不出地址`);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Error(`${host} 指向本机或内网地址（${bad}），后端不请求这类地址；确实要用，在后端环境变量 COMPANION_ALLOW_HOSTS 里加上这个主机名`);
}

export function guardedFetch(allowHosts: Set<string> = new Set(), fetchImpl: GuardedFetch = (url, init) => fetch(url, init), resolve: Resolver = systemResolve): GuardedFetch {
  return async (url, init) => {
    await assertPublicUrl(url, allowHosts, resolve);
    // 跳转不跟：公网地址跳到内网地址就绕过上面的检查了
    const response = await fetchImpl(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error(`请求地址返回了跳转（HTTP ${response.status}），后端不跟随跳转，请直接填最终地址`);
    return response;
  };
}
