// 后端自己的数据：SQLite 单文件。快照里带模型地址和密钥，文件与目录权限由 main 收紧到 0600/0700。
//   snapshots  每个角色每种用途一份最新请求（chat 聊天 / judge 判断 / daily 生成一天）
//   characters 设置（App 同步）+ 跨天状态（账本、回音账、发圈账）
//   days       每天的生活面、念头、判断计数、生成记录
//   timers     到点要发的念头 / 约定
//   sends      真发出去的消息（回音账的凭据）
//   decisions  全量判断记录（诊断用）
//   calendar   手机日程表上已定的安排和固定作息（生成一天时用）
//   routines   固定作息原件和例外：宿主只寄今明两天，更远的日子后端自己展开
//   wake_templates / wake_runs  唤醒后端：每个来源一份底稿、处理记录（见 wake.ts）

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { Ctx, GuanianDay, ModelRequest, PlanItem, ProviderKind } from "./types.ts";
import type { FixedItem, Routine } from "./day.ts";
import type { WakeRunRow, WakeTemplate } from "./wake.ts";
import type { ShortcutCommand, ShortcutContinuation, ShortcutMarker } from "./delivery.ts";

export type SnapshotPurpose = "chat" | "judge" | "daily";

export type Snapshot = {
  characterId: string;
  purpose: SnapshotPurpose;
  sessionId: string;
  /** 快照拼好的时刻（毫秒）；之后的聊天由后端从镜像补成「最新聊天事实」 */
  capturedAt: number;
  request: ModelRequest;
  /** 推送标题、点开地址 */
  notify: { title?: string; url?: string };
  /** 写 push_outbox 时带上的 meta：regexes / characterName / userName / appId / appTags / onlineThinking 等 */
  merge: Record<string, unknown>;
  /** 聊天模板才有：角色绑定的真实微信 bot（可改送微信）、快捷动作结果续跑底稿 */
  weixin?: { botId?: string };
  shortcutContinuation?: ShortcutContinuation;
};

export type SnapshotInfo = { characterId: string; purpose: string; sessionId: string; capturedAt: number; receivedAt: string; bytes: number };

const PROVIDERS = new Set<ProviderKind>(["openai-compatible", "anthropic", "gemini"]);
const PURPOSES = new Set<SnapshotPurpose>(["chat", "judge", "daily"]);

export function validateSnapshot(value: unknown): string | null {
  const s = value as Partial<Snapshot> | null;
  if (!s || typeof s !== "object") return "快照不是对象";
  if (typeof s.characterId !== "string" || !s.characterId) return "缺少 characterId";
  if (!PURPOSES.has(s.purpose as SnapshotPurpose)) return "purpose 无效";
  if (typeof s.sessionId !== "string" || !s.sessionId) return "缺少 sessionId";
  if (!Number.isFinite(s.capturedAt)) return "capturedAt 无效";
  const r = s.request;
  if (!r || typeof r !== "object") return "缺少 request";
  if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return "request.url 无效";
  if (!r.headers || typeof r.headers !== "object") return "request.headers 无效";
  if (!r.body || typeof r.body !== "object") return "request.body 无效";
  if (!PROVIDERS.has(r.providerKind as ProviderKind)) return "request.providerKind 无效";
  if (!s.merge || typeof s.merge !== "object") return "缺少 merge";
  if (!s.notify || typeof s.notify !== "object") return "缺少 notify";
  return null;
}

export type CharacterRow = {
  characterId: string; sessionId: string; name: string; enabled: boolean;
  settings: Partial<Ctx>; state: Partial<Ctx>; importedAt: number; updatedAt: number;
};

export type DayRow = {
  characterId: string; date: string; day: GuanianDay | null; items: PlanItem[];
  selfUsed: number; recheckCount: number; judgedAt: number; judgedChatAt: number;
  genTries: number; genError: string; genLog: string[]; source: string; updatedAt: number;
  /** 上次尝试生成的时刻：失败退避用它，不用每轮都会刷新的 updatedAt */
  genAt?: number;
};

export type TimerRow = { id: string; characterId: string; date: string; fireAt: number; kind: string; status: string; note: string; updatedAt: number };
export type SendRow = { wakeId: string; characterId: string; date: string; kind: string; fromId: string; sentAt: number; outboxId: string; fbDone: boolean };
export type GeneratedDraft = {
  wakeId: string; userId: string; sessionId: string; outboxId: string; createdAt: string;
  rawText: string; meta: Record<string, unknown>; notify: { title: string; url: string };
  /** 发送分流（delivery.ts）：以来电送达 / 改发真实微信 / 要请对方跑的快捷动作 */
  deliverAsCall?: boolean;
  weixinBotId?: string; weixinDone?: boolean;
  weixinState?: "sending" | "sent" | "failed" | "unknown";
  weixinError?: string; deliveredAt?: number;
  shortcut?: ShortcutMarker; continuation?: ShortcutContinuation;
  /** 建命令前先记 tried：重启后看到 tried 却没有结果，就不重复执行 */
  shortcutTried?: boolean; shortcutCommand?: ShortcutCommand | null; shortcutDelivered?: boolean;
  deliveryError?: string;
};

/** 快捷动作结果续跑：命令建好后等手机回传结果，再由后端生成第二轮 */
export type ShortcutResume = {
  commandId: string; characterId: string; sessionId: string; dueAt: number; tries: number;
  outboxId: string; request: ModelRequest; resultMarker: string; imageMarker?: string;
  actionName: string; notify: { title: string; url: string }; merge: Record<string, unknown>;
  sourceWakeId?: string; pauseReason?: string; failed?: boolean;
  /** 离线任务（jobs.ts）建的命令：角色不一定在后端挂念名单里，不查角色启用状态 */
  sourceJobKey?: string;
  generated?: { rawText: string; createdAt: string; reasoningText?: string; imagePath?: string };
};
/** 离线任务：回复兜底 / 追问 / 定时消息 / 经期关怀。小手机选了「离线执行：后端」时直接寄来，云端看不到（见 jobs.ts） */
export type OfflineJob = {
  id: string; triggerKey: string; kind: string; executeAt: number; status: "pending" | "running" | "done" | "failed" | "cancelled";
  payload: Record<string, any>; note: string; tries: number; createdAt: number; updatedAt: number;
  /** 手机在任务生成期间撤销：发送边界看到就停 */
  cancelRequested?: boolean;
};
export type DecisionRow = { id: number; characterId: string; at: number; kind: string; note: string; data: Record<string, unknown> | null; mode: string };

const j = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

type Row = Record<string, unknown>;

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("pragma journal_mode = wal");
    // 阶段 1 的快照表按角色一份，换成按用途分份
    const cols = this.#db.prepare("pragma table_info(snapshots)").all() as { name: string }[];
    if (cols.length && !cols.some(c => c.name === "purpose")) this.#db.exec("drop table snapshots");
    this.#db.exec(`
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists snapshots (
        character_id text not null, purpose text not null, session_id text not null, captured_at integer not null,
        payload text not null, received_at text not null, primary key (character_id, purpose)
      );
      create table if not exists characters (
        character_id text primary key, session_id text not null default '', name text not null default '',
        enabled integer not null default 1, settings text not null default '{}', state text not null default '{}',
        imported_at integer not null default 0, updated_at integer not null default 0
      );
      create table if not exists days (
        character_id text not null, date text not null, day text, items text not null default '[]',
        self_used integer not null default 0, recheck_count integer not null default 0,
        judged_at integer not null default 0, judged_chat_at integer not null default 0,
        gen_tries integer not null default 0, gen_error text not null default '', gen_log text not null default '[]',
        source text not null default '', updated_at integer not null default 0, primary key (character_id, date)
      );
      create table if not exists timers (
        id text primary key, character_id text not null, date text not null, fire_at integer not null,
        kind text not null, status text not null, note text not null default '', updated_at integer not null
      );
      create index if not exists timers_due on timers (status, fire_at);
      create table if not exists generated_drafts (wake_id text primary key, payload text not null);
      create table if not exists offline_jobs (
        trigger_key text primary key, id text not null, kind text not null, execute_at integer not null, status text not null,
        payload text not null, note text not null default '', tries integer not null default 0, cancel_requested integer not null default 0,
        created_at integer not null, updated_at integer not null
      );
      create index if not exists offline_jobs_due on offline_jobs (status, execute_at);
      create table if not exists shortcut_resumes (command_id text primary key, due_at integer not null, payload text not null);
      create table if not exists sends (
        wake_id text primary key, character_id text not null, date text not null, kind text not null,
        from_id text not null default '', sent_at integer not null, outbox_id text not null default '', fb_done integer not null default 0
      );
      create table if not exists decisions (
        id integer primary key autoincrement, character_id text not null, at integer not null,
        kind text not null, note text not null, data text, mode text not null
      );
      create index if not exists decisions_char on decisions (character_id, at);
      create table if not exists wake_templates (source_id text primary key, payload text not null, received_at text not null);
      create table if not exists wake_runs (
        id integer primary key autoincrement, source_id text not null, character_id text not null, event_id text not null default '',
        at integer not null, status text not null, note text not null, data text
      );
      create table if not exists calendar (
        character_id text not null, date text not null, items text not null default '[]', routine text not null default '{}',
        updated_at integer not null, primary key (character_id, date)
      );
      create table if not exists routines (
        character_id text primary key, routine text not null default '[]', exceptions text not null default '[]',
        routine_on integer not null default 1, updated_at integer not null
      );
    `);
    const dayCols = this.#db.prepare("pragma table_info(days)").all() as { name: string }[];
    if (!dayCols.some(c => c.name === "gen_at")) this.#db.exec("alter table days add column gen_at integer not null default 0");
  }

  // ── 唤醒后端
  saveWakeTemplate(t: WakeTemplate, now = new Date()): void {
    this.#db.prepare("insert into wake_templates (source_id, payload, received_at) values (?, ?, ?) on conflict(source_id) do update set payload = excluded.payload, received_at = excluded.received_at")
      .run(t.sourceId, JSON.stringify(t), now.toISOString());
  }

  getWakeTemplate(sourceId: string): WakeTemplate | null {
    const row = this.#db.prepare("select payload from wake_templates where source_id = ?").get(sourceId) as { payload: string } | undefined;
    return row ? j<WakeTemplate | null>(row.payload, null) : null;
  }

  listWakeTemplates(): { template: WakeTemplate; receivedAt: string }[] {
    return (this.#db.prepare("select payload, received_at from wake_templates order by source_id").all() as { payload: string; received_at: string }[])
      .map(r => ({ template: j<WakeTemplate | null>(r.payload, null), receivedAt: r.received_at }))
      .filter((r): r is { template: WakeTemplate; receivedAt: string } => Boolean(r.template));
  }

  deleteWakeTemplate(sourceId: string): boolean {
    return Number(this.#db.prepare("delete from wake_templates where source_id = ?").run(sourceId).changes) > 0;
  }

  addWakeRun(r: Omit<WakeRunRow, "id">): void {
    this.#db.prepare("insert into wake_runs (source_id, character_id, event_id, at, status, note, data) values (?, ?, ?, ?, ?, ?, ?)")
      .run(r.sourceId, r.characterId, r.eventId, r.at, r.status, r.note, r.data ? JSON.stringify(r.data) : null);
    this.#db.prepare("delete from wake_runs where id <= (select max(id) from wake_runs) - 500").run();
  }

  listWakeRuns(limit = 30, sourceId = ""): WakeRunRow[] {
    const rows = (sourceId
      ? this.#db.prepare("select * from wake_runs where source_id = ? order by id desc limit ?").all(sourceId, limit)
      : this.#db.prepare("select * from wake_runs order by id desc limit ?").all(limit)) as Row[];
    return rows.map(r => ({
      id: Number(r.id), sourceId: String(r.source_id), characterId: String(r.character_id), eventId: String(r.event_id), at: Number(r.at),
      status: String(r.status), note: String(r.note), data: j<Record<string, unknown> | null>(r.data as string | null, null),
    }));
  }

  getMeta(key: string): string | null {
    const row = this.#db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  // ── 快照
  saveSnapshot(s: Snapshot, now = new Date()): void {
    this.#db.prepare(`
      insert into snapshots (character_id, purpose, session_id, captured_at, payload, received_at) values (?, ?, ?, ?, ?, ?)
      on conflict(character_id, purpose) do update set session_id = excluded.session_id, captured_at = excluded.captured_at,
        payload = excluded.payload, received_at = excluded.received_at
    `).run(s.characterId, s.purpose, s.sessionId, s.capturedAt, JSON.stringify(s), now.toISOString());
  }

  getSnapshot(characterId: string, purpose: SnapshotPurpose): Snapshot | null {
    const row = this.#db.prepare("select payload from snapshots where character_id = ? and purpose = ?").get(characterId, purpose) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Snapshot : null;
  }

  /** 诊断用：不含请求内容（里面有密钥） */
  listSnapshots(): SnapshotInfo[] {
    const rows = this.#db.prepare(
      "select character_id, purpose, session_id, captured_at, received_at, length(payload) as bytes from snapshots order by received_at desc",
    ).all() as Row[];
    return rows.map(r => ({ characterId: String(r.character_id), purpose: String(r.purpose), sessionId: String(r.session_id), capturedAt: Number(r.captured_at), receivedAt: String(r.received_at), bytes: Number(r.bytes) }));
  }

  // ── 角色
  listCharacters(): CharacterRow[] {
    return (this.#db.prepare("select * from characters order by character_id").all() as Row[]).map(r => this.#character(r));
  }

  getCharacter(id: string): CharacterRow | null {
    const r = this.#db.prepare("select * from characters where character_id = ?").get(id) as Row | undefined;
    return r ? this.#character(r) : null;
  }

  #character(r: Row): CharacterRow {
    return {
      characterId: String(r.character_id), sessionId: String(r.session_id), name: String(r.name), enabled: Number(r.enabled) === 1,
      settings: j(String(r.settings), {}), state: j(String(r.state), {}), importedAt: Number(r.imported_at), updatedAt: Number(r.updated_at),
    };
  }

  saveCharacter(c: CharacterRow): void {
    this.#db.prepare(`
      insert into characters (character_id, session_id, name, enabled, settings, state, imported_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(character_id) do update set session_id = excluded.session_id, name = excluded.name, enabled = excluded.enabled,
        settings = excluded.settings, state = excluded.state, imported_at = excluded.imported_at, updated_at = excluded.updated_at
    `).run(c.characterId, c.sessionId, c.name, c.enabled ? 1 : 0, JSON.stringify(c.settings), JSON.stringify(c.state), c.importedAt, Date.now());
  }

  // ── 每天
  getDay(characterId: string, date: string): DayRow | null {
    const r = this.#db.prepare("select * from days where character_id = ? and date = ?").get(characterId, date) as Row | undefined;
    return r ? this.#day(r) : null;
  }

  listDays(characterId: string, limit = 8): DayRow[] {
    return (this.#db.prepare("select * from days where character_id = ? order by date desc limit ?").all(characterId, limit) as Row[]).map(r => this.#day(r));
  }

  #day(r: Row): DayRow {
    return {
      characterId: String(r.character_id), date: String(r.date), day: j(r.day as string | null, null), items: j(String(r.items), []),
      selfUsed: Number(r.self_used), recheckCount: Number(r.recheck_count), judgedAt: Number(r.judged_at), judgedChatAt: Number(r.judged_chat_at),
      genTries: Number(r.gen_tries), genError: String(r.gen_error), genLog: j(String(r.gen_log), []), source: String(r.source), updatedAt: Number(r.updated_at), genAt: Number(r.gen_at) || 0,
    };
  }

  saveDay(d: DayRow): void {
    this.#db.prepare(`
      insert into days (character_id, date, day, items, self_used, recheck_count, judged_at, judged_chat_at, gen_tries, gen_error, gen_log, source, gen_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(character_id, date) do update set day = excluded.day, items = excluded.items, self_used = excluded.self_used,
        recheck_count = excluded.recheck_count, judged_at = excluded.judged_at, judged_chat_at = excluded.judged_chat_at,
        gen_tries = excluded.gen_tries, gen_error = excluded.gen_error, gen_log = excluded.gen_log, source = excluded.source, gen_at = excluded.gen_at, updated_at = excluded.updated_at
    `).run(d.characterId, d.date, d.day ? JSON.stringify(d.day) : null, JSON.stringify(d.items), d.selfUsed, d.recheckCount, d.judgedAt, d.judgedChatAt,
      d.genTries, d.genError, JSON.stringify(d.genLog.slice(-40)), d.source, d.genAt || 0, Date.now());
  }

  // ── 定时器
  addTimer(t: Omit<TimerRow, "updatedAt">): void {
    this.#db.prepare(`
      insert into timers (id, character_id, date, fire_at, kind, status, note, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set fire_at = excluded.fire_at, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
    `).run(t.id, t.characterId, t.date, t.fireAt, t.kind, t.status, t.note, Date.now());
  }

  updateTimer(id: string, patch: { fireAt?: number; status?: string; note?: string }): void {
    const cur = this.getTimer(id);
    if (!cur) return;
    this.#db.prepare("update timers set fire_at = ?, status = ?, note = ?, updated_at = ? where id = ?")
      .run(patch.fireAt ?? cur.fireAt, patch.status ?? cur.status, (patch.note ?? cur.note).slice(0, 300), Date.now(), id);
  }

  /** 开始生成：只有仍是 pending 的才抢得到，撤销过的不会被改回 running */
  claimTimer(id: string): boolean {
    return Number(this.#db.prepare("update timers set status = 'running', note = '生成中', updated_at = ? where id = ? and status = 'pending'").run(Date.now(), id).changes) > 0;
  }

  /** 启动时：上个进程生成到一半就退出的，放回 pending。重发前 fireTimer 会先按 trigger_key 查投递凭据，已投递的不会再发 */
  recoverRunningTimers(): number {
    return Number(this.#db.prepare("update timers set status = 'pending', note = '进程重启，恢复待发（先核对投递凭据）', updated_at = ? where status = 'running'").run(Date.now()).changes);
  }

  getTimer(id: string): TimerRow | null {
    const r = this.#db.prepare("select * from timers where id = ?").get(id) as Row | undefined;
    return r ? this.#timer(r) : null;
  }

  dueTimers(nowMs: number, characterId: string): TimerRow[] {
    return (this.#db.prepare("select * from timers where status = 'pending' and fire_at <= ? and character_id = ? order by fire_at")
      .all(nowMs, characterId) as Row[]).map(r => this.#timer(r));
  }

  listTimers(characterId: string, sinceMs: number): TimerRow[] {
    return (this.#db.prepare("select * from timers where character_id = ? and (fire_at >= ? or status = 'pending') order by fire_at")
      .all(characterId, sinceMs) as Row[]).map(r => this.#timer(r));
  }

  #timer(r: Row): TimerRow {
    return { id: String(r.id), characterId: String(r.character_id), date: String(r.date), fireAt: Number(r.fire_at), kind: String(r.kind), status: String(r.status), note: String(r.note), updatedAt: Number(r.updated_at) };
  }

  /** 重新迁入前清掉没发完的定时器（迁入时按云端计划重挂） */
  clearShadowTimers(characterId: string): number {
    const r = this.#db.prepare("delete from timers where character_id = ? and status in ('shadow', 'pending', 'running')").run(characterId);
    return Number(r.changes);
  }

  // ── 离线任务（jobs.ts）
  #job(r: Row | undefined): OfflineJob | null {
    if (!r) return null;
    return { id: String(r.id), triggerKey: String(r.trigger_key), kind: String(r.kind), executeAt: Number(r.execute_at), status: String(r.status) as OfflineJob["status"],
      payload: j(r.payload as string, {}), note: String(r.note), tries: Number(r.tries), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      ...(Number(r.cancel_requested) ? { cancelRequested: true } : {}) };
  }

  getJob(triggerKey: string): OfflineJob | null {
    return this.#job(this.#db.prepare("select * from offline_jobs where trigger_key = ?").get(triggerKey) as Row | undefined);
  }

  /** 同键覆盖；正在生成的不覆盖，返回 false */
  putJob(job: Omit<OfflineJob, "updatedAt" | "note" | "tries" | "status">, nowMs: number): boolean {
    const old = this.getJob(job.triggerKey);
    if (old?.status === "running") return false;
    this.#db.prepare(`insert into offline_jobs (trigger_key, id, kind, execute_at, status, payload, note, tries, cancel_requested, created_at, updated_at)
      values (?, ?, ?, ?, 'pending', ?, '', 0, 0, ?, ?)
      on conflict(trigger_key) do update set id = excluded.id, kind = excluded.kind, execute_at = excluded.execute_at, status = 'pending',
        payload = excluded.payload, note = '', tries = 0, cancel_requested = 0, created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .run(job.triggerKey, job.id, job.kind, job.executeAt, JSON.stringify(job.payload), job.createdAt, nowMs);
    return true;
  }

  #jobFilter(key: { triggerKey?: string; triggerPrefix?: string; excludeKey?: string }): { where: string; args: string[] } {
    if (key.triggerKey) return { where: "trigger_key = ?", args: [key.triggerKey] };
    const prefix = String(key.triggerPrefix || "").replace(/[\\%_]/g, m => "\\" + m);
    return key.excludeKey
      ? { where: "trigger_key like ? escape '\\' and trigger_key <> ?", args: [prefix + "%", key.excludeKey] }
      : { where: "trigger_key like ? escape '\\'", args: [prefix + "%"] };
  }

  /** 撤销：没开始的直接删，正在生成的挂撤销标记。返回 { deleted, running } */
  cancelJobs(key: { triggerKey?: string; triggerPrefix?: string; excludeKey?: string }, nowMs: number): { deleted: number; running: number } {
    const f = this.#jobFilter(key);
    const deleted = Number(this.#db.prepare(`delete from offline_jobs where status = 'pending' and ${f.where}`).run(...f.args).changes);
    const running = Number(this.#db.prepare(`update offline_jobs set cancel_requested = 1, updated_at = ? where status = 'running' and ${f.where}`).run(nowMs, ...f.args).changes);
    return { deleted, running };
  }

  /** 心跳：没开始的往后推（runNow 立即） */
  delayJob(triggerKey: string, executeAt: number, nowMs: number): boolean {
    return Number(this.#db.prepare("update offline_jobs set execute_at = ?, updated_at = ? where trigger_key = ? and status = 'pending'").run(executeAt, nowMs, triggerKey).changes) > 0;
  }

  dueJobs(nowMs: number, limit = 20): OfflineJob[] {
    return (this.#db.prepare("select * from offline_jobs where status = 'pending' and execute_at <= ? order by execute_at limit ?").all(nowMs, limit) as Row[])
      .map(r => this.#job(r)!);
  }

  /** 原子抢占：只有还是 pending、id 没被同键覆盖时才变 running */
  claimJob(job: OfflineJob, nowMs: number): boolean {
    return Number(this.#db.prepare("update offline_jobs set status = 'running', updated_at = ? where trigger_key = ? and id = ? and status = 'pending'")
      .run(nowMs, job.triggerKey, job.id).changes) > 0;
  }

  /** 只改这一次抢到的那条（同键被覆盖了就不动新的） */
  updateJob(job: OfflineJob, patch: { status?: OfflineJob["status"]; executeAt?: number; note?: string; tries?: number; payload?: Record<string, any> }, nowMs: number): void {
    const next = { ...job, ...patch };
    this.#db.prepare("update offline_jobs set status = ?, execute_at = ?, note = ?, tries = ?, payload = ?, updated_at = ? where trigger_key = ? and id = ?")
      .run(next.status, next.executeAt, next.note.slice(0, 300), next.tries, JSON.stringify(next.payload), nowMs, job.triggerKey, job.id);
    Object.assign(job, patch);
  }

  jobCancelRequested(job: OfflineJob): boolean {
    const r = this.#db.prepare("select cancel_requested, id from offline_jobs where trigger_key = ?").get(job.triggerKey) as Row | undefined;
    return !r || String(r.id) !== job.id || Number(r.cancel_requested) === 1;
  }

  recoverRunningJobs(nowMs: number): number {
    return Number(this.#db.prepare("update offline_jobs set status = 'pending', updated_at = ? where status = 'running'").run(nowMs).changes);
  }

  listJobs(limit = 30): OfflineJob[] {
    return (this.#db.prepare("select * from offline_jobs order by updated_at desc limit ?").all(limit) as Row[]).map(r => this.#job(r)!);
  }

  /** 忙碌回复撤销：没开始的改成 cancelled；还没有就留一条 cancelled 墓碑，免得迟到的上传把它又建出来 */
  cancelDeferredJob(triggerKey: string, nowMs: number): OfflineJob | null {
    this.#db.prepare(`insert into offline_jobs (trigger_key, id, kind, execute_at, status, payload, note, tries, cancel_requested, created_at, updated_at)
      values (?, ?, 'reply_bailout', ?, 'cancelled', '{}', '', 0, 0, ?, ?) on conflict(trigger_key) do nothing`).run(triggerKey, `job_${randomUUID()}`, nowMs, nowMs, nowMs);
    this.#db.prepare("update offline_jobs set status = 'cancelled', payload = '{}', updated_at = ? where trigger_key = ? and status = 'pending'").run(nowMs, triggerKey);
    return this.getJob(triggerKey);
  }

  /** 做完的留 7 天查重和诊断，之后清掉 */
  pruneJobs(nowMs: number): number {
    return Number(this.#db.prepare("delete from offline_jobs where status in ('done', 'failed', 'cancelled') and updated_at < ?").run(nowMs - 7 * 86_400_000).changes);
  }

  // ── 发送记录
  saveDraft(draft: GeneratedDraft): void {
    this.#db.prepare("insert into generated_drafts (wake_id, payload) values (?, ?) on conflict(wake_id) do nothing")
      .run(draft.wakeId, JSON.stringify(draft));
  }

  updateDraft(draft: GeneratedDraft): void {
    this.#db.prepare("update generated_drafts set payload = ? where wake_id = ?").run(JSON.stringify(draft), draft.wakeId);
  }

  saveResume(r: ShortcutResume): void {
    this.#db.prepare("insert into shortcut_resumes (command_id, due_at, payload) values (?, ?, ?) on conflict(command_id) do nothing")
      .run(r.commandId, r.dueAt, JSON.stringify(r));
  }

  dueResumes(nowMs: number): ShortcutResume[] {
    return (this.#db.prepare("select payload from shortcut_resumes where due_at <= ? order by due_at").all(nowMs) as { payload: string }[])
      .map(r => JSON.parse(r.payload) as ShortcutResume);
  }

  updateResume(r: ShortcutResume): void {
    this.#db.prepare("update shortcut_resumes set due_at = ?, payload = ? where command_id = ?").run(r.dueAt, JSON.stringify(r), r.commandId);
  }

  shortcutDraft(commandId: string): GeneratedDraft | null {
    const row = this.#db.prepare("select payload from generated_drafts where json_extract(payload, '$.shortcutCommand.id') = ? limit 1")
      .get(commandId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as GeneratedDraft : null;
  }

  deleteResume(commandId: string): void {
    this.#db.prepare("delete from shortcut_resumes where command_id = ?").run(commandId);
  }

  getDraft(wakeId: string): GeneratedDraft | null {
    const row = this.#db.prepare("select payload from generated_drafts where wake_id = ?").get(wakeId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as GeneratedDraft : null;
  }

  deleteDraft(wakeId: string): void {
    this.#db.prepare("delete from generated_drafts where wake_id = ?").run(wakeId);
  }

  /** 回音计数和结算标记一起提交，重启/重复交接不会漏记或重算。 */
  settleFeedback(wakeId: string, characterId: string, kind: string, replied: boolean): Ctx["fb"] {
    this.#db.exec("begin immediate");
    try {
      const c = this.getCharacter(characterId);
      if (!c) throw new Error("回音账角色不存在");
      const changed = this.#db.prepare("update sends set fb_done = 1 where wake_id = ? and character_id = ? and fb_done = 0").run(wakeId, characterId).changes;
      if (changed) {
        const fb = { ...(c.state.fb || {}) };
        const prev = fb[kind] || [0, 0];
        fb[kind] = [Number(prev[0] || 0) + 1, Number(prev[1] || 0) + (replied ? 1 : 0)];
        c.state.fb = fb;
        this.saveCharacter(c);
      }
      this.#db.exec("commit");
      return c.state.fb;
    } catch (err) { this.#db.exec("rollback"); throw err; }
  }

  addSend(s: Omit<SendRow, "fbDone">): void {
    this.#db.prepare("insert or ignore into sends (wake_id, character_id, date, kind, from_id, sent_at, outbox_id, fb_done) values (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(s.wakeId, s.characterId, s.date, s.kind, s.fromId, s.sentAt, s.outboxId);
  }

  pendingFeedback(characterId: string): SendRow[] {
    return (this.#db.prepare("select * from sends where character_id = ? and fb_done = 0 order by sent_at").all(characterId) as Row[]).map(r => ({
      wakeId: String(r.wake_id), characterId: String(r.character_id), date: String(r.date), kind: String(r.kind), fromId: String(r.from_id),
      sentAt: Number(r.sent_at), outboxId: String(r.outbox_id), fbDone: Number(r.fb_done) === 1,
    }));
  }

  firstSendAt(characterId: string): number | null {
    const row = this.#db.prepare("select min(sent_at) as at from sends where character_id = ?").get(characterId) as { at: number | null };
    return row.at;
  }

  markFeedbackDone(wakeId: string): void {
    this.#db.prepare("update sends set fb_done = 1 where wake_id = ?").run(wakeId);
  }

  // ── 判断记录
  addDecision(characterId: string, kind: string, note: string, mode: string, data: Record<string, unknown> | null = null, at = Date.now()): void {
    this.#db.prepare("insert into decisions (character_id, at, kind, note, data, mode) values (?, ?, ?, ?, ?, ?)")
      .run(characterId, at, kind, note.slice(0, 2000), data ? JSON.stringify(data) : null, mode);
  }

  listDecisions(characterId: string, limit = 50): DecisionRow[] {
    return (this.#db.prepare("select * from decisions where character_id = ? order by id desc limit ?").all(characterId, limit) as Row[]).map(r => this.#decision(r));
  }

  /** 某时刻之后的全部判断（给念头详情拼轨迹），按时间正序 */
  listDecisionsSince(characterId: string, sinceMs: number, limit = 3000): DecisionRow[] {
    return (this.#db.prepare("select * from decisions where character_id = ? and at >= ? order by id asc limit ?").all(characterId, sinceMs, limit) as Row[]).map(r => this.#decision(r));
  }

  lastDecision(characterId: string, kind: string): DecisionRow | null {
    const r = this.#db.prepare("select * from decisions where character_id = ? and kind = ? order by id desc limit 1").get(characterId, kind) as Row | undefined;
    return r ? this.#decision(r) : null;
  }

  #decision(r: Row): DecisionRow {
    return { id: Number(r.id), characterId: String(r.character_id), at: Number(r.at), kind: String(r.kind), note: String(r.note), data: j(r.data as string | null, null), mode: String(r.mode) };
  }

  // ── 日程表
  saveCalendar(characterId: string, date: string, items: FixedItem[], routine: Routine): void {
    this.#db.prepare(`
      insert into calendar (character_id, date, items, routine, updated_at) values (?, ?, ?, ?, ?)
      on conflict(character_id, date) do update set items = excluded.items, routine = excluded.routine, updated_at = excluded.updated_at
    `).run(characterId, date, JSON.stringify(items), JSON.stringify(routine), Date.now());
  }

  getCalendar(characterId: string, date: string): { items: FixedItem[]; routine: Routine } | null {
    const r = this.#db.prepare("select items, routine from calendar where character_id = ? and date = ?").get(characterId, date) as { items: string; routine: string } | undefined;
    return r ? { items: j(r.items, []), routine: j(r.routine, {}) } : null;
  }

  saveRoutine(characterId: string, routine: unknown[], exceptions: unknown[], routineOn: boolean): void {
    this.#db.prepare(`
      insert into routines (character_id, routine, exceptions, routine_on, updated_at) values (?, ?, ?, ?, ?)
      on conflict(character_id) do update set routine = excluded.routine, exceptions = excluded.exceptions, routine_on = excluded.routine_on, updated_at = excluded.updated_at
    `).run(characterId, JSON.stringify(routine), JSON.stringify(exceptions), routineOn ? 1 : 0, Date.now());
  }

  getRoutine(characterId: string): { routine: unknown[]; exceptions: unknown[]; routineOn: boolean } | null {
    const r = this.#db.prepare("select routine, exceptions, routine_on from routines where character_id = ?").get(characterId) as { routine: string; exceptions: string; routine_on: number } | undefined;
    return r ? { routine: j(r.routine, []), exceptions: j(r.exceptions, []), routineOn: Number(r.routine_on) === 1 } : null;
  }

  close(): void { this.#db.close(); }
}
