// 离线任务执行器：小手机选了「离线执行：后端」时，回复兜底 / 追问 / 定时消息（安静太久、一次性定时）/ 经期关怀
// 不再寄到个人云 push_jobs，而是直接寄到这里（POST /app/jobs），到点由后端生成、写 push_outbox、推送。
// 规则与文案照搬 push-generate 里这几类任务走的路径（挂念专属的计划复核不在这里，挂念由 engine.ts 管）。
//
// 同一条任务（按 triggerKey）任何时刻只挂在一边：手机重挂时先撤另一边、确认后才挂新的（lib/offline-jobs-client.ts）。
// 这里到点再兜一道：个人云里还有同名任务在跑、比这条新、或者这条挂上之后云端已经处理过，就不发。
//
// 忙碌回复（deferred:*）走 POST /app/jobs/deferred，协议照搬个人云网关的 deferred-reply（回执、改版、撤销墓碑），
// 这一轮建在哪边就一直在哪边（lib/deferred-reply-cloud.ts 记在 cloud.line），到点先按 reply-timing 判断现在回不回。

import { randomUUID } from "node:crypto";

import {
  createShortcutCommand, deliverShortcutCommand, extractCall, extractShortcut, extractWeixin, replaceMarker,
  sendWeixin, SHORTCUT_VISION_OFF_NOTE, writeShortcutDiagnostic, type CloudCtx, type ShortcutCommand, type ShortcutContinuation, type ShortcutMarker,
} from "./delivery.ts";
import type { EngineDeps } from "./engine.ts";
import { acquireGenerationLease, GenerationBusy, type GenerationLease } from "./generation-lease.ts";
import { historyText, readHistory, unansweredRounds, type CloudHistory } from "./history.ts";
import { appendUserNote, callModel, splitPreview, usageAdd, usageBudget } from "./llm.ts";
import type { PushMessage } from "./push.ts";
import type { OfflineJob, Store } from "./store.ts";
import { advanceCloudReplyTiming, type CloudReplyTiming } from "./reply-timing.ts";
import type { ModelRequest, ProviderKind } from "./types.ts";

export const JOB_KINDS = new Set(["reply_bailout", "followup", "timed_task"]);
export const MAX_JOB_PAYLOAD = 900_000;
const DAILY_GENERATION_CAP = 50;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** 手机寄来的任务体，和寄个人云的一样 */
export type JobPayload = {
  request: ModelRequest;
  notify?: { title?: string; url?: string; characterId?: string };
  merge?: Record<string, any>;
  weixin?: { botId?: string; force?: boolean };
  shortcutContinuation?: ShortcutContinuation;
  allowSilence?: boolean;
  silenceThinkingTag?: string;
  /** 忙碌回复：手机改版号和冻结的时机规则 */
  deferredReply?: { revision: number; timing: CloudReplyTiming };
  /** 后端自己记：成文正文和交付进度，重试时不重新调模型、不重复执行外部动作 */
  draft?: JobDraft;
};

type JobDraft = {
  rawText: string; createdAt: string;
  delivery?: {
    rawText: string; deliverAsCall: boolean; shortcut?: ShortcutMarker;
    shortcutTried?: boolean; shortcutCommand?: ShortcutCommand | null; shortcutDelivered?: boolean; deliveryError?: string;
    weixinBotId?: string; weixinState?: "sending" | "sent" | "failed" | "unknown"; weixinError?: string;
    outboxWritten?: boolean; pushed?: boolean;
  };
};

export function validateJob(body: Record<string, unknown>): string | null {
  if (typeof body.triggerKey !== "string" || !/^[^\s]{1,200}$/.test(body.triggerKey)) return "缺少 triggerKey";
  if (!JOB_KINDS.has(String(body.kind))) return "kind 无效";
  if (!Number.isFinite(Date.parse(String(body.executeAt)))) return "executeAt 无效";
  const p = body.payload as JobPayload | undefined;
  if (!p || typeof p !== "object") return "缺少 payload";
  const r = p.request;
  if (!r || typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || !r.body || typeof r.body !== "object" || !["openai-compatible", "anthropic", "gemini"].includes(r.providerKind)) return "request 无效";
  if (JSON.stringify(p).length > MAX_JOB_PAYLOAD) return "快照过大";
  return null;
}

// ─── 忙碌回复（个人云网关 deferred-reply 的同款协议）
export const DEFERRED_KEY = /^deferred:[A-Za-z0-9_-]{1,150}$/;

export function deferredReceipt(job: OfflineJob | null): Record<string, unknown> {
  if (!job) return { ok: true, status: "missing" };
  const p = job.payload as JobPayload & { receipt?: Record<string, unknown> };
  const accepted = p.receipt ?? (p.deferredReply ? { revision: p.deferredReply.revision, acceptedMessageId: String(p.merge?.replyAfterLocalMessageId || "") } : {});
  // 已成文还没送达的算「正在处理」，手机不能再撤
  return { ok: true, status: job.status === "pending" && p.draft ? "running" : job.status, executeAt: new Date(job.executeAt).toISOString(), resultNote: job.note, ...accepted };
}

/** 新建或改版：新消息 / 换了 API 只更新快照，不重掷机会、不重置时钟 */
export function putDeferred(store: Store, key: string, payload: JobPayload, nowMs: number): { status: number; body: Record<string, unknown> } {
  const d = payload?.deferredReply;
  const r = payload?.request;
  if (!r || typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || !r.body || typeof r.body !== "object" || !["openai-compatible", "anthropic", "gemini"].includes(r.providerKind)
    || !d?.timing || !Number.isSafeInteger(d.revision) || d.revision < 1 || !Number.isFinite(d.timing.nextAt)
    || !Array.isArray(d.timing.windows) || !Array.isArray(d.timing.sleeps)) return { status: 400, body: { ok: false, error: "Invalid deferred snapshot" } };
  if (JSON.stringify(payload).length > MAX_JOB_PAYLOAD) return { status: 413, body: { ok: false, error: "快照过大，离线等待未同步" } };
  const row = store.getJob(key);
  if (row && row.status !== "pending") return { status: 200, body: deferredReceipt(row) };
  if (row) {
    const old = row.payload as JobPayload;
    if (!old.deferredReply) return { status: 409, body: { ok: false, error: "Unexpected task" } };
    if (old.draft || old.deferredReply.revision >= d.revision) return { status: 200, body: deferredReceipt(row) };
    const prev = old.deferredReply.timing;
    const executeAt = d.timing.disabled ? nowMs : row.executeAt;
    d.timing = { ...d.timing, nextAt: executeAt, reason: prev.reason, windowKey: prev.windowKey, availableUntil: prev.availableUntil, check: prev.check, note: prev.note };
    store.putJob({ id: row.id, triggerKey: key, kind: "reply_bailout", executeAt, payload, createdAt: row.createdAt }, nowMs);
  } else {
    store.putJob({ id: `job_${randomUUID()}`, triggerKey: key, kind: "reply_bailout", executeAt: d.timing.nextAt, payload, createdAt: nowMs }, nowMs);
  }
  return { status: 200, body: deferredReceipt(store.getJob(key)) };
}

// ─── 沉默协议（push-generate「CHAT SILENCE PROTOCOL」）
export const CHAT_SILENCE_TOKEN = "[本轮不回复]";
function silenceThinkingTags(tag?: string): string {
  return ["think", "thinking", ...(tag && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tag) ? [tag] : [])].join("|");
}
function stripSilenceThinking(text: string, tag?: string): string {
  return text.replace(new RegExp(`<(${silenceThinkingTags(tag)})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
}
export function isChatSilenceResponse(text: string, tag?: string): boolean {
  const c = stripSilenceThinking(text, tag).trim();
  return c === CHAT_SILENCE_TOKEN || c.startsWith(`${CHAT_SILENCE_TOKEN}\n`) || c.startsWith(`${CHAT_SILENCE_TOKEN}\r\n`);
}
export function stripChatSilenceMarker(text: string, tag?: string): string {
  if (!isChatSilenceResponse(text, tag)) return text;
  return stripSilenceThinking(text, tag).trim().slice(CHAT_SILENCE_TOKEN.length).trim();
}

/** 缺省、null、布尔、越界都不算时区；明确的 0 算 */
function timezone(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) continue;
    const n = Number(value);
    if (Number.isInteger(n) && n >= -840 && n <= 840) return n;
  }
  return null;
}

/** 安静时段内顺延到时段结束（idleRepeat 续排用） */
export function skipQuiet(at: number, quiet: { startMin: number; endMin: number; tzOffsetMin: number } | null | undefined): number {
  if (!quiet || !Number.isFinite(quiet.startMin) || !Number.isFinite(quiet.endMin)) return at;
  const local = ((Math.floor(at / 60000) + quiet.tzOffsetMin) % 1440 + 1440) % 1440;
  const inQuiet = quiet.startMin < quiet.endMin ? local >= quiet.startMin && local < quiet.endMin : local >= quiet.startMin || local < quiet.endMin;
  return inQuiet ? at + ((quiet.endMin - local + 1440) % 1440) * 60000 : at;
}

class Hold extends Error {
  until: number;
  constructor(note: string, until: number) { super(note); this.until = until; }
}
class Finish extends Error {
  status: "done" | "failed";
  constructor(status: "done" | "failed", note: string) { super(note); this.status = status; }
}

export async function runOfflineJobs(deps: EngineDeps): Promise<number> {
  let handled = 0;
  deps.store.pruneJobs(deps.now());
  for (const job of deps.store.dueJobs(deps.now())) {
    if (!deps.store.claimJob(job, deps.now())) continue;
    handled += 1;
    job.status = "running";
    try {
      const note = await runJob(deps, job);
      deps.store.updateJob(job, { status: "done", note, payload: slim(job.payload as JobPayload) }, deps.now());
    } catch (e) {
      const nowMs = deps.now();
      if (e instanceof Finish) {
        deps.store.updateJob(job, { status: e.status, note: e.message, payload: e.status === "done" ? slim(job.payload as JobPayload) : job.payload }, nowMs);
      } else if (e instanceof Hold || e instanceof GenerationBusy) {
        deps.store.updateJob(job, { status: "pending", executeAt: e instanceof Hold ? e.until : nowMs + 60_000, note: `hold: ${e.message}` }, nowMs);
      } else {
        // 和 push-generate 一样：最多 6 次，1/2/4/8/16/30 分钟后重试；已成文的正文保留
        const tries = job.tries + 1;
        if (tries >= 6) deps.store.updateJob(job, { status: "failed", tries, note: `[retry:${tries}] stopped: ${errText(e)}` }, nowMs);
        else deps.store.updateJob(job, { status: "pending", tries, executeAt: nowMs + Math.min(30, 2 ** (tries - 1)) * 60_000, note: `[retry:${tries}] ${errText(e)}` }, nowMs);
      }
      if (!(e instanceof Hold || e instanceof GenerationBusy) && !(e instanceof Finish && e.status === "done")) deps.log(`[companion] 离线任务 ${job.triggerKey}：${errText(e)}`);
    }
  }
  return handled;
}

/** 做完的只留诊断需要的，请求本体（含上游密钥）删掉 */
function slim(p: JobPayload): Record<string, any> {
  return { notify: p.notify, merge: { sessionId: p.merge?.sessionId }, draft: p.draft ? { createdAt: p.draft.createdAt } : undefined,
    ...(p.deferredReply ? { receipt: { revision: p.deferredReply.revision, acceptedMessageId: String(p.merge?.replyAfterLocalMessageId || "") } } : {}) };
}

async function cloudGuard(deps: EngineDeps, job: OfflineJob): Promise<void> {
  const scope = `user_id=eq.${encodeURIComponent(deps.userId)}&trigger_key=eq.${encodeURIComponent(job.triggerKey)}`;
  const r = await deps.rest(`push_jobs?${scope}&select=id,status,created_at,updated_at&limit=5`);
  if (!r.ok) throw new Error(`个人云同名任务核对失败 HTTP ${r.status}`);
  const rows = await r.json() as { id: string; status: string; created_at: string; updated_at: string }[];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.status === "running") throw new Hold("个人云里同名任务正在生成", deps.now() + 60_000);
    if (row.status === "pending") {
      if (Date.parse(row.created_at) > job.createdAt) throw new Finish("done", "cloud skip: 个人云里有更新的同名任务");
      const del = await deps.rest(`push_jobs?${scope}&id=eq.${encodeURIComponent(row.id)}&status=eq.pending`, { method: "DELETE", headers: { Prefer: "return=representation" } });
      if (!del.ok) throw new Error(`撤个人云旧同名任务失败 HTTP ${del.status}`);
      const gone = await del.json() as unknown[];
      if (!Array.isArray(gone) || !gone.length) throw new Hold("个人云旧同名任务刚被领走，稍后核对", deps.now() + 60_000);
    } else if (Date.parse(row.updated_at) >= job.createdAt) {
      throw new Finish("done", "cloud skip: 这条挂上后个人云已处理过同名任务");
    }
  }
}

async function runJob(deps: EngineDeps, job: OfflineJob): Promise<string> {
  const p = job.payload as JobPayload;
  const merge = p.merge || {};
  const sessionId = typeof merge.sessionId === "string" ? merge.sessionId : "";
  const scope = `user_id=eq.${encodeURIComponent(deps.userId)}`;
  const outboxId = `out_job_${job.id}`;
  const cancelled = () => { if (deps.store.jobCancelRequested(job)) throw new Finish("done", "cancelled: 手机已撤销"); };

  let lease: GenerationLease | null = null;
  if (sessionId) lease = await acquireGenerationLease(deps.rest, deps.userId, sessionId, "job:" + job.triggerKey);
  try {
    const guard = async () => { cancelled(); if (lease) await lease.check(); cancelled(); };
    await guard();
    // 上次写进去了但没来得及收尾
    const existing = await deps.rest(`push_outbox?${scope}&id=eq.${encodeURIComponent(outboxId)}&select=id&limit=1`);
    if (!existing.ok) throw new Error(`投递凭据读取失败 HTTP ${existing.status}`);
    const written = (await existing.json() as unknown[]).length > 0;
    if (!p.draft) {
      if (written) return "generated previously; recovered";
      let timingNote = "";
      if (p.deferredReply) {
        const { ready, ...timing } = advanceCloudReplyTiming(p.deferredReply.timing, deps.now(), deps.random);
        p.deferredReply.timing = timing;
        if (!ready) {
          deps.store.updateJob(job, { payload: p }, deps.now());
          throw new Hold("deferred: waiting for an opportunity", timing.nextAt);
        }
        timingNote = timing.note;
      }
      await cloudGuard(deps, job);
      await generate(deps, job, p, sessionId, guard, timingNote);
      if (!p.draft) return String(job.note || "done");
    }
    return await deliver(deps, job, p, sessionId, outboxId, written, guard);
  } finally {
    if (lease) await lease.release().catch(() => undefined);
  }
}

async function generate(deps: EngineDeps, job: OfflineJob, p: JobPayload, sessionId: string, guard: () => Promise<void>, timingNote = ""): Promise<void> {
  const merge = p.merge || {};
  const nowMs = deps.now();
  const subs = await deps.rest(`push_subscriptions?user_id=eq.${encodeURIComponent(deps.userId)}&select=endpoint&limit=1`);
  if (!subs.ok) throw new Error(`推送订阅读取失败 HTTP ${subs.status}`);
  if (!(await subs.json() as unknown[]).length && p.weixin?.force !== true) throw new Finish("done", "no_subscription");

  // 硬闸：每天最多 50 条离线生成（云端和后端合计，都带 pushGenerated）
  const dayStart = `${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`;
  const cap = await deps.rest(`push_outbox?user_id=eq.${encodeURIComponent(deps.userId)}&created_at=gte.${encodeURIComponent(dayStart)}&meta->>pushGenerated=eq.true&select=id&limit=${DAILY_GENERATION_CAP + 1}`);
  if (cap.ok && (await cap.json() as unknown[]).length >= DAILY_GENERATION_CAP) throw new Finish("done", `daily cap (${DAILY_GENERATION_CAP}) reached`);

  const request: ModelRequest = structuredClone(p.request);
  if (timingNote && !appendUserNote(request.body, request.providerKind, `<reply_timing>\n${timingNote}\n不要提这段说明本身。\n</reply_timing>`)) {
    throw new Finish("failed", "deferred prompt unsupported");
  }
  let history: CloudHistory | null = null;
  if ((job.kind === "timed_task" || job.kind === "followup" || p.deferredReply) && sessionId) {
    try { history = await readHistory(deps.rest, deps.userId, sessionId); }
    catch { throw new Hold("最新聊天读取失败，稍后核对", nowMs + 5 * 60_000); }
    if (p.deferredReply) {
      // 等待期间别处（微信等）又来了新消息：这轮回复接在最新一条后面
      const latestUser = [...history.messages].reverse().find(m => m.role === "user");
      if (latestUser && Date.parse(latestUser.message_at) > Date.parse(String(merge.replyAfterCreatedAt || "1970-01-01"))) {
        merge.replyAfterLocalMessageId = latestUser.id;
        merge.replyAfterCreatedAt = latestUser.message_at;
      }
    }
    const tz = timezone(merge.tzOffsetMin, merge.idleRepeat?.quietWin?.tzOffsetMin);
    appendUserNote(request.body, request.providerKind,
      `[最新云端聊天事实，非用户消息；${tz === null ? "当地时区未知，下方仅以 UTC 标示，不得推断当地钟点" : `统一时区 UTC${tz >= 0 ? "+" : ""}${tz / 60}，当前当地时间 ${new Date(nowMs + tz * 60000).toISOString().slice(0, 16)}`}。以下时间是生成时间，不代表用户已读；与旧快照冲突时以这里为准。]\n`
      + historyText(history, tz ?? 0, 80));
  }
  // 未回应降速：连续这么多轮没等到回就不发
  const coolTarget = Number(merge.cooldownRounds);
  if (job.kind === "timed_task" && history?.messages.length && Number.isFinite(coolTarget) && coolTarget > 0) {
    const rounds = unansweredRounds(history, nowMs);
    if (rounds >= coolTarget) throw new Finish("done", `presend skip: 连续 ${rounds} 轮没等到你回 (rounds ${rounds})`);
  }

  const budget = await usageBudget(deps.rest, deps.userId, nowMs).catch(() => null);
  await guard();
  let result;
  try { result = await callModel(request, deps.fetchModel, 300_000); }
  catch (e) { throw new Finish("failed", errText(e)); }
  const rawText = result.text.trim();
  if (!rawText) throw new Finish("failed", "empty response");
  p.draft = { rawText, createdAt: new Date(deps.now()).toISOString() };
  deps.store.updateJob(job, { payload: p }, deps.now());
  await usageAdd(deps.rest, deps.userId, budget?.tz ?? 0, "cloud-chat", request.providerKind as ProviderKind, result.data).catch(() => undefined);

  if (p.allowSilence === true && isChatSilenceResponse(rawText, p.silenceThinkingTag)) {
    const updates = stripChatSilenceMarker(rawText, p.silenceThinkingTag);
    if (updates) {
      await guard();
      const saved = await deps.rest("push_outbox?on_conflict=id", {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify([{ id: `out_silence_${job.id}`, user_id: deps.userId, job_id: null, session_id: sessionId || null, trigger_key: job.triggerKey,
          raw_text: `${CHAT_SILENCE_TOKEN}\n${updates}`, created_at: p.draft.createdAt, meta: { ...merge, pushGenerated: true, silentUpdate: true, companionServer: true } }]),
      });
      if (!saved.ok) throw new Error(`silence updates pending: outbox write failed HTTP ${saved.status}`);
    }
    job.note = "reply silenced";
    delete p.draft;
  }
}

async function deliver(deps: EngineDeps, job: OfflineJob, p: JobPayload, sessionId: string, outboxId: string, written: boolean, guard: () => Promise<void>): Promise<string> {
  const draft = p.draft!;
  const merge = p.merge || {};
  const save = () => deps.store.updateJob(job, { payload: p }, deps.now());
  const cc: CloudCtx | null = deps.cloud ? { rest: deps.rest, cloud: deps.cloud, key: deps.cloudKey || "", userId: deps.userId, beforeEffect: guard } : null;
  const title = String(p.notify?.title || "小手机");
  const characterId = String(p.notify?.characterId || "");

  if (!draft.delivery) {
    const called = extractCall(draft.rawText);
    const shortcut = extractShortcut(called.text);
    const weixin = extractWeixin(shortcut.text, shortcut.marker);
    const botId = typeof p.weixin?.botId === "string" ? p.weixin.botId : "";
    draft.delivery = {
      rawText: weixin.text, deliverAsCall: called.call,
      ...(shortcut.marker ? { shortcut: shortcut.marker } : {}),
      ...((weixin.weixin || p.weixin?.force === true) && botId ? { weixinBotId: botId } : {}),
    };
    save();
  }
  const d = draft.delivery;
  const notes: string[] = [];

  if (d.shortcut && !d.shortcutTried) {
    if (!cc) { d.shortcutCommand = null; d.deliveryError = `快捷动作「${d.shortcut.name}」没执行：后端没接个人云函数`; }
    else {
      const created = await createShortcutCommand({ ...cc, beforeEffect: async () => { await guard(); d.shortcutTried = true; save(); } }, d.shortcut, !!p.shortcutContinuation)
        .catch(e => { if (!d.shortcutTried) throw e; return { command: null, note: `快捷动作「${d.shortcut!.name}」创建结果未确认，没有重复执行：${errText(e)}` }; });
      d.shortcutCommand = created.command;
      if (!created.command) d.deliveryError = created.note;
    }
    d.shortcutTried = true;
    save();
  } else if (d.shortcut && d.shortcutCommand === undefined) {
    d.shortcutCommand = null;
    d.deliveryError = `快捷动作「${d.shortcut.name}」执行结果未确认，没有重复执行`;
    save();
  }
  const command = d.shortcutCommand || null;
  if (command) notes.push(`shortcut ${command.actionName}`);

  if (d.weixinState === "sending") { d.weixinState = "unknown"; d.weixinError = "微信发送被中断，结果未确认"; save(); }
  if (!written && d.weixinBotId && !d.weixinState) {
    const extra = typeof merge.replyAfterLocalMessageId === "string" && typeof merge.replyAfterCreatedAt === "string"
      ? { replyAfterLocalMessageId: merge.replyAfterLocalMessageId, replyAfterCreatedAt: merge.replyAfterCreatedAt } : {};
    const result = cc
      ? await sendWeixin({ ...cc, beforeEffect: async () => { await guard(); d.weixinState = "sending"; save(); } }, d.weixinBotId, d.rawText, extra)
      : { status: "failed" as const, error: "后端没接个人云函数" };
    d.weixinState = result.status; d.weixinError = result.error;
    save();
  }
  if (!written && d.weixinState === "unknown") throw new Finish("failed", d.weixinError || "微信发送结果未确认；核对送达前不自动重发或改投");

  const afterDelivery = async () => {
    if (command && !d.shortcutDelivered) {
      if (!cc) throw new Error("快捷命令待投递，但后端没接个人云函数");
      const failed = await deliverShortcutCommand(cc, command);
      if (failed) { d.deliveryError = failed; save(); throw new Error(failed); }
      d.shortcutDelivered = true; delete d.deliveryError; save();
      if (command.continued && p.shortcutContinuation) {
        const cont = structuredClone(p.shortcutContinuation);
        if (!replaceMarker(cont.request.body, cont.replyMarker, d.rawText)) throw new Error("续跑底稿缺少首条回复占位");
        const canSendImage = command.resultMode === "image" && cont.visionEnabled !== false;
        if (!canSendImage && cont.imageMarker) replaceMarker(cont.request.body, cont.imageMarker, command.resultMode === "image" ? SHORTCUT_VISION_OFF_NOTE : "（该动作没有图片回传）");
        deps.store.saveResume({
          commandId: command.id, sourceJobKey: job.triggerKey, characterId, sessionId, dueAt: deps.now() + 15_000, tries: 0,
          outboxId: `out_${randomUUID()}`, request: cont.request, resultMarker: cont.resultMarker, ...(canSendImage && cont.imageMarker ? { imageMarker: cont.imageMarker } : {}),
          actionName: command.actionName, notify: { title, url: String(p.notify?.url || "/") }, merge: { ...merge, shortcutCommandId: command.id },
        });
      }
    }
    if (cc && d.deliveryError) { await writeShortcutDiagnostic(cc, sessionId, d.deliveryError); delete d.deliveryError; save(); }
    await rearmIdle(deps, job, p);
  };

  if (d.weixinState === "sent") {
    await afterDelivery();
    return `sent via weixin${notes.length ? ", " + notes.join(", ") : ""}`;
  }
  if (d.weixinState === "failed") notes.push(`weixin failed: ${String(d.weixinError || "").slice(0, 80)}`);

  let pushed = 0; const pushErrors: string[] = [];
  if (!written) {
    await guard();
    const saved = await deps.rest("push_outbox", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ id: outboxId, user_id: deps.userId, job_id: null, session_id: sessionId || null, trigger_key: job.triggerKey, raw_text: d.rawText, created_at: draft.createdAt,
        meta: { ...merge, pushGenerated: true, companionServer: true, companionDeliveredAt: new Date(deps.now()).toISOString(),
          ...(command && d.shortcut ? { shortcutMarker: { text: d.shortcut.text, insertAt: d.shortcut.insertAt, name: d.shortcut.name } } : {}) } }]),
    });
    if (!saved.ok) throw new Error(`outbox write failed; saved reply retained: HTTP ${saved.status} ${(await saved.text().catch(() => "")).slice(0, 160)}`);
    const nowMs = deps.now();
    // 来电：单条推送（不分段），点开带 ring 参数直达振铃；正文照常进 outbox
    const url = d.deliverAsCall && sessionId ? `/?ring=${encodeURIComponent(sessionId)}&rt=${nowMs}` : String(p.notify?.url || "/");
    let parts = d.deliverAsCall ? ["来电话了…"] : splitPreview(d.rawText).slice(0, 6);
    if (!parts.length) parts = ["发来一条消息"];
    const messages: PushMessage[] = parts.map((body, index) => ({
      type: d.deliverAsCall ? "incoming_call" : "chat_outbox", title: d.deliverAsCall ? `📞 ${title}` : title, body: body.slice(0, 80), tag: `${job.id}-${index}`, url,
      ...(characterId ? { characterId } : {}), ...(d.deliverAsCall && sessionId ? { sessionId, callTs: nowMs } : {}),
    }));
    const r = await deps.push(messages).catch(e => ({ sent: 0, total: 0, removed: 0, skippedShell: 0, errors: [errText(e)] }));
    pushed = r.sent; pushErrors.push(...r.errors);
  }
  await afterDelivery();
  return `generated, pushed ${pushed}${d.deliverAsCall ? ", call" : ""}${notes.length ? ", " + notes.join(", ") : ""}${pushErrors.length ? `, errors: ${pushErrors.slice(0, 3).join(" | ")}` : ""}`;
}

/** 冷场重连的下一发：连发上限内自动续排 `${key}+`（用户回来后手机会撤销并按新周期重挂） */
async function rearmIdle(deps: EngineDeps, job: OfflineJob, p: JobPayload): Promise<void> {
  const repeat = p.merge?.idleRepeat as { intervalMs?: number; remaining?: number; quietWin?: { startMin: number; endMin: number; tzOffsetMin: number } | null } | undefined;
  if (!repeat || !(Number(repeat.remaining) > 0) || !(Number(repeat.intervalMs) > 0) || p.merge?.idleRearmed) return;
  const nowMs = deps.now();
  const nextFire = skipQuiet(nowMs + Number(repeat.intervalMs), repeat.quietWin);
  const { draft: _draft, ...rest } = p;
  const merge = {
    ...p.merge, armAt: new Date(nextFire).toISOString(),
    idleReconnect: { ...(p.merge?.idleReconnect || {}), firedAt: nextFire },
    idleRepeat: Number(repeat.remaining) - 1 > 0 ? { ...repeat, remaining: Number(repeat.remaining) - 1 } : undefined,
  };
  deps.store.putJob({ id: `job_${randomUUID()}`, triggerKey: `${job.triggerKey}+`, kind: "timed_task", executeAt: nextFire + 15_000, payload: { ...rest, merge }, createdAt: nowMs }, nowMs);
  p.merge = { ...p.merge, idleRearmed: true };
  deps.store.updateJob(job, { payload: p }, nowMs);
}
