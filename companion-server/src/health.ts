// 健康状况：轮询有没有卡住、模型通不通、推送送不送得出去。
// /health 不带鉴权，只给问题代号；带原因的说明走要令牌的 /status。

import { characterTz } from "./engine.ts";
import { localDate } from "./life.ts";
import type { PushResult } from "./push.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";

export type Problem = { code: string; note: string };
export type HealthReport = { ok: boolean; stale: boolean; problems: Problem[] };

/** 一轮里判断和成文各调一次模型，带上备用通道最坏十来分钟（生成一天已经挪到锁外）；超过这么久没跑完一轮就算卡住 */
export const STALE_MS = 20 * 60_000;
/** 卡到这么久：进程自己退出，交给 systemd 重启 */
export const WATCHDOG_MS = 30 * 60_000;

const HOUR = 3600_000;

/** 最近一次推送的结果（进程内记，重启清空） */
export class PushWatch {
  last: { at: number; sent: number; total: number; errors: string[] } | null = null;

  record(at: number, result: PushResult | null, error = ""): void {
    this.last = { at, sent: result?.sent || 0, total: result?.total || 0, errors: result ? result.errors.slice(0, 3) : [error.slice(0, 120)] };
  }
}

/** 离上一轮跑完过去多久（还没跑完过就从启动算） */
export function tickAge(runner: Runner, startedAt: number, nowMs: number): number {
  return nowMs - Math.max(runner.lastTickAt, startedAt);
}

export function healthReport(store: Store, runner: Runner, push: PushWatch | undefined, startedAt: number, nowMs = Date.now()): HealthReport {
  const problems: Problem[] = [];
  const age = tickAge(runner, startedAt, nowMs);
  const stale = age > STALE_MS;
  if (stale) problems.push({ code: "tick_stale", note: `已经 ${Math.round(age / 60_000)} 分钟没跑完一轮了` });

  for (const c of store.listCharacters()) {
    if (!c.enabled || Number(c.settings.recheckEnabled) === 0) continue;
    const name = c.name || c.characterId;
    const tz = characterTz(c);
    const row = tz === null ? null : store.getDay(c.characterId, localDate(nowMs, tz));
    if (row?.genError) problems.push({ code: "gen_failed", note: `${name}今天的日程没生成出来：${row.genError.slice(0, 120)}` });
    const judge = store.lastDecision(c.characterId, "judge");
    if (judge?.data?.failed === "call" && nowMs - judge.at < 6 * HOUR) problems.push({ code: "model_unreachable", note: `${name}：${judge.note.slice(0, 160)}` });
    const error = store.lastDecision(c.characterId, "error");
    if (error && nowMs - error.at < 2 * HOUR) problems.push({ code: "send_failing", note: `${name}：${error.note.slice(0, 160)}` });
  }

  if (push?.last && nowMs - push.last.at < 24 * HOUR && push.last.sent === 0) {
    problems.push(push.last.total === 0 && !push.last.errors.length
      ? { code: "no_push_subscription", note: "个人云里没有这个账号的推送订阅，通知推不到任何设备" }
      : { code: "push_failing", note: `最近一次推送一条也没送出去：${push.last.errors.join("；") || "原因不明"}` });
  }
  return { ok: problems.length === 0, stale, problems };
}
