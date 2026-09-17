// 微信助手后端版：「离线执行：后端」时由这里代替个人云的 weixin-assistant 云函数轮询微信、自动回复。
// 核心逻辑和云函数是同一份（tools/weixin-local-assistant/assistant-core.mjs）：
// 优先用小手机同步到桶里的最新核心（和云函数一致），读不到或协议版本不对就用 vendor 里的副本。
// 云端和后端共用桶里的自动回复锁，切换时短暂两边都开着也不会重复回复。

import * as bundled from "./vendor/weixin-assistant-core.mjs";
import type { Store } from "./store.ts";

type Core = {
  WEIXIN_CORE_PROTOCOL_VERSION: number;
  pollOnce: (env: Record<string, string>, bot?: string, options?: { debug?: boolean; deadlineAt?: number }) => Promise<{ results?: any[] }>;
  setMediaReplyEnabled: (on: boolean) => void;
};
export type WeixinHeartbeat = {
  lastRunAt?: string; lastError?: string; polled?: number; received?: number; sent?: number; elapsedMs?: number; codeSource?: "bucket" | "bundled";
};

const PROTOCOL = 3;
const LOOP_MS = 12_000;
// 单轮预算和云函数一样卡在自动回复锁 3 分钟 TTL 之内，免得锁过期后另一边接着回
const POLL_BUDGET_MS = 140_000;
const BUCKET = "ai-phone-backup";
const CORE_PATH = "weixin-cloud/function-core.mjs";
const CORE_TTL_MS = 5 * 60_000;
const ENABLED_KEY = "weixin:enabled";
const HEARTBEAT_KEY = "weixin:heartbeat";
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type WeixinDeps = {
  store: Store; url: string; key: string; log: (line: string) => void;
  fetch?: typeof fetch; importCore?: (code: string) => Promise<Core>; bundledCore?: Core; now?: () => number;
};

export class WeixinService {
  #deps: WeixinDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<WeixinHeartbeat> | null = null;
  #core: { mod: Core; at: number; etag: string } | null = null;

  constructor(deps: WeixinDeps) { this.#deps = deps; }

  enabled(): boolean { return this.#deps.store.getMeta(ENABLED_KEY) === "1"; }

  heartbeat(): WeixinHeartbeat {
    try { return JSON.parse(this.#deps.store.getMeta(HEARTBEAT_KEY) || "{}") as WeixinHeartbeat; } catch { return {}; }
  }

  setEnabled(on: boolean): void {
    this.#deps.store.setMeta(ENABLED_KEY, on ? "1" : "0");
    if (on) this.start(); else this.stop();
  }

  /** 进程启动时调用：开着才起循环 */
  start(): void {
    if (this.#timer || !this.enabled()) return;
    this.#timer = setInterval(() => { void this.tick(); }, LOOP_MS);
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 轮询一次；上一次没跑完就等它（手动测试也不会叠跑） */
  tick(debug = false): Promise<WeixinHeartbeat> {
    if (this.#running) return this.#running;
    if (!debug && !this.enabled()) return Promise.resolve(this.heartbeat());
    this.#running = this.#poll(debug).finally(() => { this.#running = null; });
    return this.#running;
  }

  async #poll(debug: boolean): Promise<WeixinHeartbeat> {
    const now = this.#deps.now ?? Date.now;
    const startedAt = now();
    let beat: WeixinHeartbeat;
    try {
      const { mod, source } = await this.#loadCore();
      // 媒体回复以运行包里的开关为准，和云函数一样不强开
      mod.setMediaReplyEnabled(false);
      const result = await mod.pollOnce({ SUPABASE_URL: this.#deps.url, SUPABASE_SERVICE_ROLE_KEY: this.#deps.key, SUPABASE_BUCKET: BUCKET, WEIXIN_AUTO_REPLY: "true" }, undefined, { debug, deadlineAt: startedAt + POLL_BUDGET_MS });
      const rows = Array.isArray(result?.results) ? result.results : [];
      const error = rows.map(row => row.autoReply?.error || (row.tokenExpired ? "Token 已过期，请重新扫码" : "") || (row.ilinkErrorCode !== undefined ? `iLink error_code ${row.ilinkErrorCode}` : "")).find(Boolean);
      beat = {
        lastRunAt: new Date(now()).toISOString(), ...(error ? { lastError: String(error).slice(0, 300) } : {}), polled: rows.length,
        received: rows.reduce((n, r) => n + Number(r.received || 0), 0), sent: rows.reduce((n, r) => n + Number(r.autoReply?.sent || 0), 0),
        elapsedMs: now() - startedAt, codeSource: source,
      };
      if (beat.sent) this.#deps.log(`[companion] 微信助手：收到 ${beat.received}，回复 ${beat.sent}`);
    } catch (e) {
      beat = { lastRunAt: new Date(now()).toISOString(), lastError: errText(e), elapsedMs: now() - startedAt };
      const last = this.heartbeat();
      if (last.lastError !== beat.lastError) this.#deps.log(`[companion] 微信助手轮询失败：${beat.lastError}`);
    }
    this.#deps.store.setMeta(HEARTBEAT_KEY, JSON.stringify(beat));
    return beat;
  }

  async #loadCore(): Promise<{ mod: Core; source: "bucket" | "bundled" }> {
    const now = (this.#deps.now ?? Date.now)();
    if (this.#core && now - this.#core.at < CORE_TTL_MS) return { mod: this.#core.mod, source: "bucket" };
    const f = this.#deps.fetch ?? fetch;
    try {
      const headers: Record<string, string> = { apikey: this.#deps.key, Authorization: `Bearer ${this.#deps.key}` };
      if (this.#core?.etag) headers["If-None-Match"] = this.#core.etag;
      const res = await f(`${this.#deps.url}/storage/v1/object/${BUCKET}/${CORE_PATH}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.status === 304 && this.#core) { this.#core.at = now; return { mod: this.#core.mod, source: "bucket" }; }
      if (res.ok) {
        const code = await res.text();
        if (code.includes("export async function pollOnce") && code.includes(`WEIXIN_CORE_PROTOCOL_VERSION = ${PROTOCOL}`)) {
          const mod = await (this.#deps.importCore ?? importFromText)(code);
          if (typeof mod.pollOnce === "function" && typeof mod.setMediaReplyEnabled === "function" && mod.WEIXIN_CORE_PROTOCOL_VERSION === PROTOCOL) {
            this.#core = { mod, at: now, etag: res.headers.get("etag") || "" };
            return { mod, source: "bucket" };
          }
        }
      }
    } catch { /* 读不到桶里的就用内置 */ }
    return { mod: this.#deps.bundledCore ?? bundled as unknown as Core, source: "bundled" };
  }
}

function importFromText(code: string): Promise<Core> {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<Core>;
}
