// 谁能调接口：
//   · 运维令牌 COMPANION_API_TOKEN（命令行、curl）
//   · 手机：挂念设置里本来就存着的个人云 Secret key。后端拿它去个人云读一行确认是这个项目的有效密钥，
//     只缓存它的 SHA-256，不落盘、不打日志。手机不用再多存一把钥匙。

import { createHash, timingSafeEqual } from "node:crypto";

export type KeyCheck = (key: string) => Promise<boolean>;

const OK_TTL = 30 * 60_000;
const BAD_TTL = 60_000;
const MAX_CHECKS_PER_MIN = 20;

export function supabaseKeyCheck(personalUrl: string, fetchImpl: typeof fetch = fetch): KeyCheck {
  return async key => {
    const headers: Record<string, string> = { apikey: key };
    if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
    // push_server_config 只有 service 级密钥读得到（RLS），anon / publishable key 读不到
    const res = await fetchImpl(`${personalUrl}/rest/v1/push_server_config?select=id&limit=1`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) && rows.length > 0;
  };
}

export class Auth {
  #adminToken: string;
  #check: KeyCheck;
  #cache = new Map<string, { ok: boolean; until: number }>();
  #recent: number[] = [];
  #now: () => number;

  constructor(adminToken: string, check: KeyCheck, now: () => number = Date.now) {
    this.#adminToken = adminToken;
    this.#check = check;
    this.#now = now;
  }

  async allow(header: string | undefined): Promise<boolean> {
    const given = String(header || "").replace(/^Bearer\s+/i, "").trim();
    if (!given || given.length > 4096) return false;
    if (this.#adminToken) {
      const a = Buffer.from(given), b = Buffer.from(this.#adminToken);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    const hash = createHash("sha256").update(given).digest("hex");
    const now = this.#now();
    const hit = this.#cache.get(hash);
    if (hit && hit.until > now) return hit.ok;
    // 限速：不让接口变成猜密钥的外援
    this.#recent = this.#recent.filter(t => now - t < 60_000);
    if (this.#recent.length >= MAX_CHECKS_PER_MIN) return false;
    this.#recent.push(now);
    let ok = false;
    try { ok = await this.#check(given); } catch { ok = false; }
    if (this.#cache.size > 200) this.#cache.clear();
    this.#cache.set(hash, { ok, until: now + (ok ? OK_TTL : BAD_TTL) });
    return ok;
  }
}
