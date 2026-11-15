// 与旧 push-generate 共用会话租约；拿不到锁时留待下轮，不消耗生成重试次数。
import { randomUUID } from "node:crypto";
import type { Rest } from "./supabase.ts";

export class GenerationBusy extends Error {
  constructor() { super("同一会话正在生成，稍后再试"); }
}

export type GenerationLease = { check: () => Promise<void>; release: () => Promise<void> };

/** 数据库里租约一次续 10 分钟；留 2 分钟余量，离上次续成不到这么久就还握着锁 */
const HELD_MS = 8 * 60_000;

export async function acquireGenerationLease(rest: Rest, userId: string, sessionId: string, owner: string,
  renewMs = 60_000, now: () => number = Date.now): Promise<GenerationLease> {
  if (!sessionId) throw new Error("会话租约缺少 sessionId");
  const token = `companion:${owner}:${randomUUID()}`;
  const action = async (p_action: string) => {
    const response = await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
      p_user_id: userId, p_session_id: sessionId, p_token: token, p_action,
    }) });
    if (!response.ok) throw new Error(`会话租约 ${p_action} 失败 HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result !== "boolean") throw new Error("会话租约回执无效");
    return result;
  };
  if (!await action("claim")) throw new GenerationBusy();
  let heldAt = now();
  // 只有个人云明确说「这把锁不是你的了」才算丢；续租请求没问到（超时、5xx）不算
  let lost: Error | null = null;
  let renewing: Promise<void> | null = null;
  let closed = false;
  const check = async () => {
    if (closed) throw new Error("会话租约已释放");
    if (lost) throw lost;
    if (!renewing) renewing = (async () => {
      try {
        if (await action("renew")) { heldAt = now(); return; }
        lost = new Error("会话生成租约已失效");
        throw lost;
      } catch (err) {
        if (lost) throw lost;
        // 个人云抖了一下：租约在库里还没到期就照常往下走，下次续租再问；真拖到快到期还续不上才停
        if (now() - heldAt < HELD_MS) return;
        throw new Error(`会话租约续不上，已经 ${Math.round((now() - heldAt) / 60_000)} 分钟没续成：${err instanceof Error ? err.message : String(err)}`);
      } finally { renewing = null; }
    })();
    await renewing;
  };
  const timer = setInterval(() => { void check().catch(() => undefined); }, renewMs);
  timer.unref();
  return {
    check,
    release: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await renewing?.catch(() => undefined);
      // 失败时由数据库 TTL 回收，不能盖掉原来的生成/投递错误。
      await action("release").catch(() => undefined);
    },
  };
}
