// 谁能调接口：
//   · 运维令牌 COMPANION_API_TOKEN（命令行、curl）
//   · 手机：挂念设置里本来就存着的个人云 Secret key。后端拿它去个人云读一行确认是这个项目的有效密钥，
//     只缓存它的 SHA-256，不落盘、不打日志。手机不用再多存一把钥匙。

import { createHash, timingSafeEqual } from "node:crypto";

/** true = 是这个项目的有效密钥；false = 个人云明确说不是；抛错 = 个人云没给出答案（超时、5xx、限流） */
export type KeyCheck = (key: string) => Promise<boolean>;
export type Verdict = "ok" | "denied" | "unavailable";

const OK_TTL = 30 * 60_000;
const BAD_TTL = 60_000;
/** 核对过的密钥：个人云抖动时最多再认这么久 */
const STALE_OK_TTL = 24 * 3600_000;
const MAX_CHECKS_PER_MIN = 20;

export function supabaseKeyCheck(personalUrl: string, fetchImpl: typeof fetch = fetch): KeyCheck {
  return async key => {
    const headers: Record<string, string> = { apikey: key };
    if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
    // push_server_config 只有 service 级密钥读得到（RLS），anon / publishable key 读不到
    const res = await fetchImpl(`${personalUrl}/rest/v1/push_server_config?select=id&limit=1`, { headers, signal: AbortSignal.timeout(10_000) });
    // 只有个人云明确拒绝才算「密钥不对」；超时、5xx、限流是「没问出来」，不能记成密钥无效
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Error(`个人云 HTTP ${res.status}`);
    if (!res.ok) return false;
    const rows = await res.json().catch(() => { throw new Error("个人云回的不是 JSON"); });
    return Array.isArray(rows) && rows.length > 0;
  };
}

export class Auth {
  #adminToken: string;
  #check: KeyCheck;
  #cache = new Map<string, { ok: boolean; until: number; okAt: number }>();
  #recent: number[] = [];
  #now: () => number;

  constructor(adminToken: string, check: KeyCheck, now: () => number = Date.now) {
    this.#adminToken = adminToken;
    this.#check = check;
    this.#now = now;
  }

  /** 是不是运维令牌（不是手机上那把个人云密钥）：覆盖迁入这类不可撤销的操作只认它 */
  isAdmin(header: string | undefined): boolean {
    const given = String(header || "").replace(/^Bearer\s+/i, "").trim();
    if (!given || given.length > 4096 || !this.#adminToken) return false;
    const a = Buffer.from(given), b = Buffer.from(this.#adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async allow(header: string | undefined): Promise<boolean> {
    return await this.verify(header) === "ok";
  }

  /** unavailable：个人云一时问不到，既不放行也不记成密钥无效，调用方回 503 让手机稍后再试 */
  async verify(header: string | undefined): Promise<Verdict> {
    const given = String(header || "").replace(/^Bearer\s+/i, "").trim();
    if (!given || given.length > 4096) return "denied";
    if (this.isAdmin(header)) return "ok";
    const hash = createHash("sha256").update(given).digest("hex");
    const now = this.#now();
    const hit = this.#cache.get(hash);
    if (hit && hit.until > now) return hit.ok ? "ok" : "denied";
    // 限速：不让接口变成猜密钥的外援
    this.#recent = this.#recent.filter(t => now - t < 60_000);
    if (this.#recent.length >= MAX_CHECKS_PER_MIN) return "denied";
    this.#recent.push(now);
    let ok: boolean;
    try { ok = await this.#check(given); }
    catch {
      // 之前核对通过的密钥，个人云抖动期间照认；没核对过的不放行，也不缓存
      return hit?.ok && now - hit.okAt < STALE_OK_TTL ? "ok" : "unavailable";
    }
    if (this.#cache.size > 200) this.#cache.clear();
    this.#cache.set(hash, { ok, until: now + (ok ? OK_TTL : BAD_TTL), okAt: ok ? now : 0 });
    return ok ? "ok" : "denied";
  }
}
