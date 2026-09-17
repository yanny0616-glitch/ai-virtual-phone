// 从个人云迁入：push_recheck_plans 的设置 / 账本 / 当天计划，push_jobs 里冻结的提示词模板当初始快照。
// 只读个人云，不改云端任何东西。force=true 时覆盖后端已有的状态（切换到真发之前用，丢掉影子运行留下的痕迹）。

import { LEGACY_HANDOFF_NOTE } from "./handoff.ts";
import { decryptPayload, type EncryptedPayload } from "./crypto.ts";
import type { CharacterRow, DayRow, Snapshot, SnapshotPurpose, Store } from "./store.ts";
import { restJson, type Rest } from "./supabase.ts";
import { SETTING_KEYS, STATE_KEYS, type Ctx, type GuanianDay, type PlanItem, type Thread } from "./types.ts";
import type { FixedItem } from "./day.ts";
import { localDate } from "./life.ts";

type PlanRow = {
  character_id: string; plan_date: string; session_id: string; context: Record<string, any> | null; items: PlanItem[] | null;
  recheck_count: number | null; judged_at: number | null; judged_chat_at: number | null; last_recheck_at: string | null;
};

export type ImportReport = { characters: { characterId: string; name: string; days: string[]; snapshots: string[]; timers?: number; skipped?: string }[] };

/** 接续旧复核器会结算的当天/前一天尾账；累计 fb 不覆盖，已结算 wakeId 不重新计数。 */
export async function importPendingCloudFeedback(rest: Rest, store: Store, userId: string, characterId: string, nowMs = Date.now()): Promise<number> {
  if (store.getMeta("handoff-feedback:" + characterId) === "done") return 0;
  const c = store.getCharacter(characterId);
  if (!c) return 0;
  // 已经交接过的后端：从首次后端发送之前的交接窗口找，避免补丁晚到一天就漏掉尾账。
  const boundary = Math.min(nowMs, store.firstSendAt(characterId) ?? nowMs);
  const tz = Number(c.settings.tzOffsetMin);
  if (!Number.isFinite(tz)) throw new Error("回音补迁缺少角色时区");
  const since = localDate(boundary - 86_400_000, tz);
  const scope = `user_id=eq.${encodeURIComponent(userId)}`;
  const plans: PlanRow[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await restJson<PlanRow[]>(rest, `push_recheck_plans?${scope}&character_id=eq.${encodeURIComponent(characterId)}`
      + `&plan_date=gte.${since}&select=character_id,plan_date,session_id,context,items&order=plan_date.desc&limit=200&offset=${offset}`);
    if (!Array.isArray(page) || page.some(p => p.character_id !== characterId)) throw new Error("回音补迁计划身份或格式异常");
    plans.push(...page);
    if (page.length < 200) break;
  }
  const seen = new Set<string>([...(c.state.fbSeen || []), ...plans.flatMap(p => Array.isArray(p.context?.fbSeen) ? p.context.fbSeen : [])]);
  const candidates = new Map<string, { plan: PlanRow; item: PlanItem }>();
  for (const plan of plans) for (const item of Array.isArray(plan.items) ? plan.items : []) {
    if (item?.wakeId && item.act && !seen.has(item.wakeId) && !candidates.has(item.wakeId)) candidates.set(item.wakeId, { plan, item });
  }
  const records: Parameters<Store["addSend"]>[0][] = [];
  const keys = [...candidates.keys()];
  for (let start = 0; start < keys.length; start += 100) {
    const filter = `${scope}&trigger_key=in.(${encodeURIComponent(keys.slice(start, start + 100).map(k => JSON.stringify("timedwake:" + k)).join(","))})`;
    const jobs = await restJson<{ trigger_key: string; status: string; result_note: string; updated_at: string }[]>(rest,
      `push_jobs?${filter}&select=trigger_key,status,result_note,updated_at&limit=100`);
    if (!Array.isArray(jobs)) throw new Error("回音补迁任务回执格式异常");
    const outputs: { id: string; trigger_key: string; created_at: string; session_id: string }[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await restJson<typeof outputs>(rest, `push_outbox?${filter}&select=id,trigger_key,created_at,session_id&order=id&limit=200&offset=${offset}`);
      if (!Array.isArray(page)) throw new Error("回音补迁发送凭据格式异常");
      outputs.push(...page);
      if (page.length < 200) break;
    }
    for (const wakeId of keys.slice(start, start + 100)) {
      const { plan, item } = candidates.get(wakeId)!;
      const trigger = "timedwake:" + wakeId;
      const job = jobs.find(j => j.trigger_key === trigger);
      if (job && ["pending", "running"].includes(job.status)) continue;
      const output = outputs.find(o => o.trigger_key === trigger && o.session_id === plan.session_id);
      // outbox 是强凭据；微信等旧路径可能只有 sent 回执，不能凭计划上的 generatedAt 猜测发送。
      const jobSentAt = job?.status === "done" && /^(generated|sent)/.test(job.result_note || "") ? Date.parse(job.updated_at) : NaN;
      const sentAt = Number.isFinite(jobSentAt) ? jobSentAt : output ? Date.parse(output.created_at) : NaN;
      if (!Number.isFinite(sentAt) || sentAt > nowMs) continue;
      records.push({ wakeId, characterId, date: plan.plan_date, kind: item.kind || "plan", fromId: item.from || "", sentAt, outboxId: output?.id || "" });
    }
  }
  // 网络读取全部成功后才写入；中途退出重试时 addSend 保留已有 fb_done。
  for (const record of records) store.addSend(record);
  store.setMeta("handoff-feedback:" + characterId, "done");
  return records.length;
}

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


/** 已建档角色的增量交接：只补缺项，绝不 force 覆盖后端日程、账本或任务终态。调用方持有 Runner 锁。 */
export async function importMissingCloudTasks(rest: Rest, store: Store, userId: string, characterId: string, nowMs = Date.now()) {
  const c = store.getCharacter(characterId);
  if (!c) return { items: 0, timers: 0 };
  const plans: PlanRow[] = [];
  const scope = `user_id=eq.${encodeURIComponent(userId)}`;
  for (let offset = 0; ; offset += 200) {
    const page = await restJson<PlanRow[]>(rest, `push_recheck_plans?${scope}&character_id=eq.${encodeURIComponent(characterId)}`
      + `&select=character_id,plan_date,session_id,context,items,recheck_count,judged_at,judged_chat_at,last_recheck_at&order=plan_date.desc&limit=200&offset=${offset}`);
    if (!Array.isArray(page) || page.some(p => p.character_id !== characterId)) throw new Error("交接计划身份或格式异常");
    plans.push(...page);
    if (page.length < 200) break;
  }
  const candidates = new Map<string, { plan: PlanRow; item: PlanItem }>();
  for (const plan of plans) for (const item of Array.isArray(plan.items) ? plan.items : []) {
    if (!item?.wakeId || candidates.has(item.wakeId)) continue;
    // 最新计划优先，连已取消的身份也记住，不能被旧快照重新点亮。
    candidates.set(item.wakeId, { plan, item });
  }
  const keys = [...candidates.keys()].map(id => "timedwake:" + id);
  const handedOff = new Set<string>(), sent = new Set<string>();
  // 全部云端读取完成后才写本地；失败可以安全重试。
  for (let start = 0; start < keys.length; start += 100) {
    const filter = `${scope}&trigger_key=in.(${encodeURIComponent(keys.slice(start, start + 100).map(k => JSON.stringify(k)).join(","))})`;
    const jobs = await restJson<{ trigger_key: string; status: string; result_note: string }[]>(rest,
      `push_jobs?${filter}&kind=eq.timed_task&select=trigger_key,status,result_note&limit=100`);
    if (!Array.isArray(jobs)) throw new Error("交接任务回执格式异常");
    for (const job of jobs) if (job.status === "cancelled" && job.result_note === LEGACY_HANDOFF_NOTE) handedOff.add(job.trigger_key);
    for (let offset = 0; ; offset += 200) {
      const outputs = await restJson<{ trigger_key: string }[]>(rest, `push_outbox?${filter}&select=trigger_key&order=id&limit=200&offset=${offset}`);
      if (!Array.isArray(outputs)) throw new Error("交接发送凭据格式异常");
      for (const output of outputs) sent.add(output.trigger_key);
      if (outputs.length < 200) break;
    }
  }
  // SQLite LIMIT -1：检查全部已有任务身份，不只检查展示窗口最近几天。
  const rows = new Map(store.listDays(characterId, -1).map(r => [r.date, r]));
  const existing = new Map([...rows.values()].flatMap(row => row.items.map(item => [item.wakeId, { row, item }] as const)));
  const threads: Thread[] = structuredClone(Array.isArray(c.state.threads) ? c.state.threads : []);
  const dirty = new Set<string>();
  const timers: Parameters<Store["addTimer"]>[0][] = [];
  let added = 0;
  const skipped: string[] = [];
  for (const [wakeId, candidate] of candidates) {
    const key = "timedwake:" + wakeId;
    if (!handedOff.has(key) || sent.has(key) || store.getTimer(wakeId)) continue;
    const known = existing.get(wakeId);
    const item = known?.item || candidate.item;
    if (!item.act || item.generatedAt || item.matterSuppressed || !Number.isFinite(item.fireAt)) continue;
    let thread = item.from ? threads.find(t => t.id === item.from) : undefined;
    if (thread && (thread.done || ["completed", "cancelled"].includes(String(thread.status))
      || item.kind === "promise" && Number(thread.revision || 1) !== Number(item.promiseRevision || 1))) continue;
    if (!thread && item.from) {
      const source = (Array.isArray(candidate.plan.context?.threads) ? candidate.plan.context.threads : []).find((t: Thread) => t.id === item.from) as Thread | undefined;
      if (source) {
        if (source.done || ["completed", "cancelled"].includes(String(source.status))
          || item.kind === "promise" && Number(source.revision || 1) !== Number(item.promiseRevision || 1)) continue;
        thread = structuredClone(source); threads.push(thread);
      }
    }
    // 找不到账本的约定没法核对版本：不补这一条，也不让整个交接失败（失败会让两边都停着）
    if (item.kind === "promise" && !thread) { skipped.push(wakeId); continue; }
    let row = known?.row || rows.get(candidate.plan.plan_date);
    if (!row) {
      const p = candidate.plan, pc = p.context || {};
      row = { characterId, date: p.plan_date, day: pc.day ? { ...(pc.dayFull || {}), ...pc.day, tz: Number(c.settings.tzOffsetMin) } : null,
        items: [], selfUsed: Number(pc.selfUsed) || 0, recheckCount: Number(p.recheck_count) || 0,
        judgedAt: Number(p.judged_at) || 0, judgedChatAt: Number(p.judged_chat_at) || 0,
        genTries: 0, genError: "", genLog: [], source: "cloud-handoff", updatedAt: nowMs };
      rows.set(row.date, row);
    }
    if (!known) {
      const copy = structuredClone(item); row.items.push(copy); existing.set(wakeId, { row, item: copy });
      dirty.add(row.date); added++;
    }
    timers.push({ id: wakeId, characterId, date: row.date, fireAt: item.fireAt, kind: item.kind || "plan", status: "pending", note: "交接补迁" });
  }
  for (const date of dirty) store.saveDay(rows.get(date)!);
  for (const timer of timers) store.addTimer(timer);
  if (JSON.stringify(threads) !== JSON.stringify(c.state.threads || [])) { c.state.threads = threads; store.saveCharacter(c); }
  return { items: added, timers: timers.length, skipped };
}
