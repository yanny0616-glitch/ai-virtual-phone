// Shared by both self-contained cloud workers; injected by push:build-dist.
export type GuanianCloudMessage = { id: string; role: string; content: string; message_at: string; response_batch_id?: string; media_type?: string };
export type GuanianCloudOutput = { id: string; trigger_key?: string; raw_text: string; created_at: string; consumed_at?: string; meta?: Record<string, unknown> };
export type GuanianCloudHistory = { messages: GuanianCloudMessage[]; outputs: GuanianCloudOutput[]; lastGeneratedAt: number;
  uncertainLegacy?: { message: GuanianCloudMessage; outputIds: string[]; exactText: boolean }[] };

/** Absence, null, booleans and invalid offsets are not UTC. Explicit zero is. */
export function guanianTimezone(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) continue;
    const n = Number(value);
    if (Number.isInteger(n) && n >= -840 && n <= 840) return n;
  }
  return null;
}
export function guanianContextTimezone(context: Record<string, unknown>, at: number): number | null {
  const day = context.day as { tz?: unknown } | undefined;
  const kit = context.genKit as { tz?: unknown } | undefined;
  const explicit = guanianTimezone(day?.tz, kit?.tz, context.tzOffsetMin);
  if (explicit !== null) return explicit;
  // Old gateways defaulted missing userSleepTz to zero. Only the actual IANA
  // zone is trustworthy in such a legacy row; never use that defaulted zero.
  if (typeof context.userSleepTimeZone === "string" && context.userSleepTimeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: context.userSleepTimeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
      const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
      return guanianTimezone((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(at / 60000) * 60000) / 60000);
    } catch { /* Invalid zone: require a new phone snapshot. */ }
  }
  return null;
}
export async function readGuanianCloudHistory(
  rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, sessionId: string,
): Promise<GuanianCloudHistory> {
  if (!sessionId) throw new Error("缺少聊天会话，不能核对云端消息");
  const scope = `user_id=eq.${encodeURIComponent(userId)}&session_id=eq.${encodeURIComponent(sessionId)}`;
  const responses = await Promise.all([
    rest(`push_chat_mirror?${scope}&select=id,role,content,message_at,response_batch_id,media_type&or=(media_type.is.null,media_type.neq.response_batch)&order=message_at.desc&limit=200`),
    rest(`push_outbox?${scope}&meta->>pushGenerated=eq.true&select=id,trigger_key,raw_text,created_at,consumed_at,meta&order=created_at.desc&limit=200`),
  ]);
  if (responses.some(r => !r.ok)) throw new Error("云端聊天读取失败，请检查 schema 11 与云函数部署；稍后重试");
  const [mirrors, outputs] = await Promise.all(responses.map(r => r.json())) as [GuanianCloudMessage[], GuanianCloudOutput[]];
  if (!Array.isArray(mirrors) || !Array.isArray(outputs)) throw new Error("云端聊天数据格式错误");
  const records = new Map<string, GuanianCloudMessage>();
  const cloudIds = new Set(outputs.map(o => `push-outbox:${o.id}`));
  const snapshots = new Map<string, GuanianCloudMessage[]>();
  // Fetch snapshots by batch, independently of the recent 200-bubble window.
  // Each row is an atomic full replacement; an empty list is a deletion.
  const batchIds = [...cloudIds];
  for (let start = 0; start < batchIds.length; start += 50) {
    const ids = batchIds.slice(start, start + 50).map(id => JSON.stringify(id)).join(",");
    const response = await rest(`push_chat_mirror?${scope}&media_type=eq.response_batch&response_batch_id=in.(${encodeURIComponent(ids)})&select=id,content,response_batch_id,media_type&limit=50`);
    if (!response.ok) throw new Error("整轮聊天镜像读取失败，保留任务等待重试");
    for (const row of await response.json() as GuanianCloudMessage[]) {
      if (row.media_type !== "response_batch" || !row.response_batch_id || !cloudIds.has(row.response_batch_id)) continue;
      const value = JSON.parse(row.content) as { v?: number; messages?: GuanianCloudMessage[] };
      if (value.v !== 1 || !Array.isArray(value.messages) || value.messages.some(m =>
        typeof m.id !== "string" || typeof m.content !== "string" || !Number.isFinite(Date.parse(m.message_at)))) {
        throw new Error("整轮聊天镜像格式异常，请重新同步镜像");
      }
      snapshots.set(row.response_batch_id, value.messages);
    }
  }
  for (const m of mirrors) {
    if (!m || !["user", "assistant"].includes(m.role) || !Number.isFinite(Date.parse(m.message_at))) continue;
    if (m.media_type === "response_batch") continue;
    // A single mirrored bubble never proves a full response. Use the atomic
    // batch snapshot when available, otherwise retain the original whole reply.
    if (m.response_batch_id && cloudIds.has(m.response_batch_id)) continue;
    records.set(`mirror:${m.id}`, m);
  }
  // Pre-batch hosts stamped imported bubbles with consumption time. Match only a
  // complete, unique consecutive sequence at that receipt time; never dedupe by
  // an isolated phrase or by the latest mirror timestamp.
  const compact = (s: string) => s.replace(/\s+/g, "").trim();
  const legacy = mirrors.filter(m => records.has(`mirror:${m.id}`) && !m.response_batch_id)
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id));
  const candidates = new Map<string, { groups: GuanianCloudMessage[][]; output: GuanianCloudOutput }>();
  for (const o of outputs) {
    const receivedAt = Date.parse(o.consumed_at || "");
    if (!Number.isFinite(receivedAt)) continue;
    const raw = String(o.raw_text || "");
    const forms = new Set([compact(raw), compact(raw.split(/\[(?:内心|心声)\]/)[0])].filter(Boolean));
    const matches: GuanianCloudMessage[][] = [];
    for (let start = 0; start < legacy.length; start++) {
      const group: GuanianCloudMessage[] = []; let text = "";
      for (const m of legacy.slice(start, start + 40)) {
        if (m.role !== "assistant" || !records.has(`mirror:${m.id}`) || Math.abs(Date.parse(m.message_at) - receivedAt) > 120_000) break;
        group.push(m); text += compact(m.content);
        if (forms.has(text)) matches.push([...group]);
        if (![...forms].some(f => f.startsWith(text))) break;
      }
    }
    candidates.set(o.id, { groups: matches, output: o });
  }
  // Resolve across ALL outputs before removing anything. Two identical outputs
  // may otherwise both claim the same mirror sequence in iteration order.
  const owners = new Map<string, Set<string>>();
  for (const [id, candidate] of candidates) for (const group of candidate.groups) for (const m of group) {
    if (!owners.has(m.id)) owners.set(m.id, new Set());
    owners.get(m.id)!.add(id);
  }
  const uncertainLegacy: NonNullable<GuanianCloudHistory["uncertainLegacy"]> = [];
  for (const candidate of candidates.values()) {
    if (candidate.groups.length === 1 && candidate.groups[0].every(m => owners.get(m.id)?.size === 1)) {
      for (const m of candidate.groups[0]) records.delete(`mirror:${m.id}`);
    }
  }
  for (const m of legacy) {
    if (m.role !== "assistant" || !records.has(`mirror:${m.id}`)) continue;
    const exact = [...(owners.get(m.id) || [])];
    // Receipt-time proximity is not identity. Unrelated old-format utterances
    // stay in the factual history and can open the promise-update gate.
    const possible = exact;
    if (!possible.length) continue;
    // Insufficient old metadata cannot establish a separate utterance. Keep
    // the evidence in an explicitly uncertain appendix, never as a fresh turn
    // or as evidence for automatic unanswered-round cancellation.
    uncertainLegacy.push({ message: m, outputIds: possible, exactText: exact.length > 0 });
    records.delete(`mirror:${m.id}`);
  }
  let lastGeneratedAt = 0;
  for (const o of outputs) {
    const at = Date.parse(o.created_at);
    if (!Number.isFinite(at)) continue;
    lastGeneratedAt = Math.max(lastGeneratedAt, at);
    const id = `push-outbox:${o.id}`;
    const snapshot = snapshots.get(id);
    if (snapshot && !snapshot.length) continue; // Explicit whole-batch deletion.
    records.set(id, { id, role: "assistant", content: snapshot
      ? snapshot.map(m => m.content).join("\n") : String(o.raw_text || ""), message_at: o.created_at });
  }
  return { messages: [...records.values()].sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id)), outputs, lastGeneratedAt, uncertainLegacy };
}
export function guanianHistoryText(history: GuanianCloudHistory, tz: number, limit = 80): string {
  const main = history.messages.slice(-limit).map(m => {
    const local = new Date(Date.parse(m.message_at) + tz * 60_000).toISOString().slice(0, 16).replace("T", " ");
    return `[${m.id}] ${local} ${m.role === "user" ? "用户" : "你"}：${m.content.slice(0, 4000)}`;
  }).join("\n");
  const uncertain = (history.uncertainLegacy || []).slice(-20);
  if (!uncertain.length) return main;
  return main + "\n[旧镜像待核对资料：可能是补收副本，不能当作新发言、新承诺或新增未回应轮次；不推断用户已读。原始记录未删除。]\n"
    + uncertain.map(({ message: m, outputIds, exactText }) => `[mirror:${m.id}] 记录时间 ${m.message_at}；可能对应 ${outputIds.map(id => "push-outbox:" + id).join(",")}；`
      + (exactText ? "正文已见对应云端输出，不重复列出。" : "待核对原文：" + m.content.slice(0, 4000))).join("\n");
}
export function guanianHistoryRounds(history: GuanianCloudHistory, nowMs: number): number {
  let rounds = 0, last = Infinity;
  for (const m of [...history.messages].reverse()) {
    if (m.role === "user") break;
    const at = Date.parse(m.message_at);
    if (last - at > 3 * 60_000 && nowMs - at >= 30 * 60_000) rounds++;
    last = at;
  }
  return rounds;
}

/** Explicit timed wakes drive proactive spacing; passive replies never consume it. */
export function guanianLastProactiveAt(history: GuanianCloudHistory): number {
  return history.outputs.reduce((at, o) => {
    if (!o.trigger_key?.startsWith("timedwake:")) return at;
    const event = o.meta?.guanianPromise as { id?: string } | undefined;
    const context = o.meta?.guanianContext as { revision?: number | null } | undefined;
    if (event?.id || context?.revision) return at;
    return Math.max(at, Date.parse(o.created_at) || 0);
  }, 0);
}
