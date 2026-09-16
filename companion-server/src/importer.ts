// 从个人云迁入：push_recheck_plans 的设置 / 账本 / 当天计划，push_jobs 里冻结的提示词模板当初始快照。
// 只读个人云，不改云端任何东西。force=true 时覆盖后端已有的状态（切换到真发之前用，丢掉影子运行留下的痕迹）。

import { decryptPayload, type EncryptedPayload } from "./crypto.ts";
import type { CharacterRow, DayRow, Snapshot, SnapshotPurpose, Store } from "./store.ts";
import { restJson, type Rest } from "./supabase.ts";
import { SETTING_KEYS, STATE_KEYS, type Ctx, type GuanianDay, type PlanItem } from "./types.ts";
import type { FixedItem } from "./day.ts";

type PlanRow = {
  character_id: string; plan_date: string; session_id: string; context: Record<string, any> | null; items: PlanItem[] | null;
  recheck_count: number | null; judged_at: number | null; judged_chat_at: number | null; last_recheck_at: string | null;
};

export type ImportReport = { characters: { characterId: string; name: string; days: string[]; snapshots: string[]; timers?: number; skipped?: string }[] };

function timezoneOf(ctx: Record<string, any>): number | null {
  for (const v of [ctx.day?.tz, ctx.genKit?.tz, ctx.tzOffsetMin]) {
    if (typeof v !== "number" && !(typeof v === "string" && v.trim())) continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= -840 && n <= 840) return n;
  }
  return null;
}

export async function importFromCloud(rest: Rest, store: Store, userId: string, opts: { force?: boolean; now?: number; characterId?: string } = {}): Promise<ImportReport> {
  const nowMs = opts.now ?? Date.now();
  const report: ImportReport = { characters: [] };
  const rows = await restJson<PlanRow[]>(rest, `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + (opts.characterId ? `&character_id=eq.${encodeURIComponent(opts.characterId)}` : "")
    + "&select=character_id,plan_date,session_id,context,items,recheck_count,judged_at,judged_chat_at,last_recheck_at&order=plan_date.desc&limit=60");
  const [cfg] = await restJson<{ payload_key: string | null }[]>(rest, "push_server_config?id=eq.main&select=payload_key&limit=1");
  const byCharacter = new Map<string, PlanRow[]>();
  for (const row of rows) byCharacter.set(row.character_id, [...(byCharacter.get(row.character_id) || []), row]);

  for (const [characterId, plans] of byCharacter) {
    const entry: ImportReport["characters"][number] = { characterId, name: "", days: [], snapshots: [] };
    report.characters.push(entry);
    const latest = plans[0];
    const ctx = latest.context || {};
    const tz = timezoneOf(ctx) ?? plans.map(p => timezoneOf(p.context || {})).find(v => v !== null) ?? null;
    if (tz === null) { entry.skipped = "时区缺失"; continue; }
    const existing = store.getCharacter(characterId);
    if (existing && !opts.force) { entry.skipped = "已迁入过（force 才覆盖）"; continue; }

    const settings: Partial<Ctx> = { tzOffsetMin: tz };
    // recheckEnabled / genEnabled 在云端是「云端复核 / 云端生成」开关，切到后端时会被关掉，不能跟着迁
    const cloudOnly = new Set(["tzOffsetMin", "recheckEnabled", "genEnabled"]);
    for (const key of SETTING_KEYS) if (ctx[key] !== undefined && !cloudOnly.has(key)) (settings as Record<string, unknown>)[key] = ctx[key];
    const kit = plans.map(p => p.context?.genKit).find(k => k && typeof k === "object");
    if (kit) {
      if (kit.autoGenAt) settings.autoGenAt = kit.autoGenAt;
      settings.forkLevel = Number(kit.forkLevel ?? 1);
      settings.forkBurst = kit.forkBurst === false ? 0 : 1;
      settings.moodGate = kit.moodGate === false ? 0 : 1;
    }
    const state: Partial<Ctx> = {};
    for (const key of STATE_KEYS) if (ctx[key] !== undefined) (state as Record<string, unknown>)[key] = ctx[key];

    // 提示词模板：judge / daily 是挂念专用模板，chat 是哨兵聊天快照
    const snapshots: [SnapshotPurpose, string][] = [];
    const judgeKey = plans.map(p => p.context?.judgeTemplate).find(k => typeof k === "string" && k);
    if (judgeKey) snapshots.push(["judge", judgeKey]);
    const dailyKey = plans.map(p => p.context?.genKit?.tplDaily).find(k => typeof k === "string" && k)
      || (judgeKey ? String(judgeKey).replace(/:judge$/, ":daily") : "");
    if (dailyKey) snapshots.push(["daily", dailyKey]);
    for (const p of plans) {
      const sentinel = p.context?.sentinelWakeId;
      if (typeof sentinel === "string" && sentinel && !snapshots.some(s => s[0] === "chat")) snapshots.push(["chat", `timedwake:${sentinel}`]);
    }
    let name = existing?.name || "";
    for (const [purpose, key] of snapshots) {
      if (!cfg?.payload_key) break;
      if (!opts.force && store.getSnapshot(characterId, purpose)) continue;
      const jobs = await restJson<{ payload: EncryptedPayload; updated_at: string }[]>(rest,
        `push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=eq.${encodeURIComponent(key)}&select=payload,updated_at&order=updated_at.desc&limit=1`);
      if (!jobs.length) continue;
      try {
        const payload = JSON.parse(await decryptPayload(jobs[0].payload, cfg.payload_key));
        if (!payload?.request?.url) continue;
        const merge = (payload.merge && typeof payload.merge === "object" ? payload.merge : {}) as Record<string, unknown>;
        const capturedAt = Date.parse(String(merge.snapshotAt || "")) || Date.parse(jobs[0].updated_at) || nowMs;
        const snap: Snapshot = {
          characterId, purpose, sessionId: String(merge.sessionId || latest.session_id || ""), capturedAt,
          request: payload.request, notify: { title: payload.notify?.title, url: payload.notify?.url }, merge,
        };
        if (purpose === "chat" && (store.getSnapshot(characterId, "chat")?.capturedAt || 0) > capturedAt) continue;
        store.saveSnapshot(snap);
        entry.snapshots.push(purpose);
        name = name || String(payload.notify?.title || merge.characterName || "");
      } catch { /* 解不开就算没有 */ }
    }
    entry.name = name;

    const character: CharacterRow = {
      characterId, sessionId: String(latest.session_id || existing?.sessionId || ""), name, enabled: existing ? existing.enabled : true,
      settings: { ...(opts.force ? existing?.settings : {}), ...settings }, state, importedAt: nowMs, updatedAt: nowMs,
    };
    store.saveCharacter(character);
    if (opts.force) store.clearShadowTimers(characterId);

    // 最近几天的计划：生活面、念头、判断计数
    for (const p of plans.slice(0, 4)) {
      const pc = p.context || {};
      const day = pc.day ? { ...(pc.dayFull || {}), ...pc.day, tz } as GuanianDay : null;
      if (!day && !(p.items || []).length) continue;
      if (store.getDay(characterId, p.plan_date) && !opts.force) continue;
      const row: DayRow = {
        characterId, date: p.plan_date, day, items: Array.isArray(p.items) ? p.items : [],
        selfUsed: Number(pc.selfUsed) || 0, recheckCount: Number(p.recheck_count) || 0,
        judgedAt: Math.max(Number(p.judged_at) || 0, Date.parse(p.last_recheck_at || "") || 0), judgedChatAt: Number(p.judged_chat_at) || 0,
        genTries: 0, genError: "", genLog: Array.isArray(pc.genLog) ? pc.genLog : [], source: "cloud", updatedAt: nowMs,
      };
      store.saveDay(row);
      entry.days.push(p.plan_date);
      // 云端已点亮、还没到点的念头由后端接手（切真发前要撤掉云端对应的 timedwake 预约，避免两边都发）
      for (const item of row.items) {
        if (!item.act || item.generatedAt || !item.wakeId || !(item.fireAt > nowMs) || store.getTimer(item.wakeId)) continue;
        store.addTimer({ id: item.wakeId, characterId, date: p.plan_date, fireAt: item.fireAt, kind: item.kind || "plan", status: "pending", note: "云端迁入" });
        entry.timers = (entry.timers || 0) + 1;
      }
      if (pc.genKit?.date && Array.isArray(pc.genKit.existing)) {
        store.saveCalendar(characterId, pc.genKit.date, pc.genKit.existing as FixedItem[], {});
      }
    }
  }
  return report;
}
