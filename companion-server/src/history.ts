// 聊天历史：个人云的聊天镜像 + 代发的 push_outbox（云端和后端写的都带 meta.pushGenerated）。
// 从 push-recheck「GUANIAN CLOUD HISTORY」段原样搬来。

import type { Rest } from "./supabase.ts";

export type CloudMessage = { id: string; role: string; content: string; message_at: string; response_batch_id?: string; media_type?: string };
export type CloudOutput = { id: string; trigger_key?: string; raw_text: string; created_at: string; consumed_at?: string; meta?: Record<string, unknown> };
export type CloudHistory = {
  messages: CloudMessage[]; outputs: CloudOutput[]; lastGeneratedAt: number;
  uncertainLegacy?: { message: CloudMessage; outputIds: string[]; exactText: boolean }[];
};
export type HistoryWindow = { onlineRounds?: unknown; offlineRounds?: unknown };

function roundLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(1, Math.round(n))) : 40;
}

export function hasWindow(window?: HistoryWindow): boolean {
  return window?.onlineRounds != null || window?.offlineRounds != null;
}

function onlineRounds(messages: CloudMessage[]): CloudMessage[][] {
  const rounds: CloudMessage[][] = [];
  for (const m of [...messages].filter(m => m.media_type !== "offline_summary")
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id))) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const current = rounds[rounds.length - 1];
    const last = current?.[current.length - 1];
    const batch = m.response_batch_id || (m.id.startsWith("push-outbox:") ? m.id : "");
    const previousBatch = last?.response_batch_id || (last?.id.startsWith("push-outbox:") ? last.id : "");
    const separateReply = last?.role === "assistant" && m.role === "assistant"
      && (batch && previousBatch ? batch !== previousBatch : Date.parse(m.message_at) - Date.parse(last.message_at) > 180000);
    if (!current || m.role === "user" || separateReply) rounds.push([m]);
    else current.push(m);
  }
  return rounds;
}

export function selectHistory(messages: CloudMessage[], window: HistoryWindow): CloudMessage[] {
  const online = onlineRounds(messages).slice(-roundLimit(window.onlineRounds)).flat();
  const offline = messages.filter(m => m.media_type === "offline_summary" && m.content.trim())
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id))
    .slice(-roundLimit(window.offlineRounds));
  return [...online, ...offline].sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id));
}

const MIRROR_FIELDS = "select=id,role,content,message_at,response_batch_id,media_type";

export async function readHistory(rest: Rest, userId: string, sessionId: string, window?: HistoryWindow): Promise<CloudHistory> {
  if (!sessionId) throw new Error("缺少聊天会话，不能核对云端消息");
  const scope = `user_id=eq.${encodeURIComponent(userId)}&session_id=eq.${encodeURIComponent(sessionId)}`;
  const onlineFilter = "or=(media_type.is.null,and(media_type.neq.response_batch,media_type.neq.offline_summary))";
  const responses = await Promise.all([
    rest(`push_chat_mirror?${scope}&${MIRROR_FIELDS}&${onlineFilter}&order=message_at.desc,id.desc&limit=200`),
    rest(`push_outbox?${scope}&meta->>pushGenerated=eq.true&select=id,trigger_key,raw_text,created_at,consumed_at,meta&order=created_at.desc&limit=200`),
  ]);
  if (responses.some(r => !r.ok)) throw new Error("云端聊天读取失败");
  const [mirrors, outputs] = await Promise.all(responses.map(r => r.json())) as [CloudMessage[], CloudOutput[]];
  if (!Array.isArray(mirrors) || !Array.isArray(outputs)) throw new Error("云端聊天数据格式错误");
  if (hasWindow(window)) {
    // 线上轮次取够完整轮；摘要单独取，挤不掉线上的
    let pageSize = mirrors.length;
    while (pageSize === 200 && onlineRounds(mirrors).length <= roundLimit(window?.onlineRounds)) {
      if (mirrors.length >= 5000) throw new Error("最近对话气泡过多，请减少线上回看轮数");
      const response = await rest(`push_chat_mirror?${scope}&${MIRROR_FIELDS}&${onlineFilter}&order=message_at.desc,id.desc&limit=200&offset=${mirrors.length}`);
      if (!response.ok) throw new Error("线上历史分页读取失败");
      const page = await response.json() as CloudMessage[];
      if (!Array.isArray(page)) throw new Error("线上历史分页格式错误");
      mirrors.push(...page); pageSize = page.length;
    }
    const response = await rest(`push_chat_mirror?${scope}&media_type=eq.offline_summary&select=id,role,content,message_at,media_type&order=message_at.desc,id.desc&limit=${roundLimit(window?.offlineRounds)}`);
    if (!response.ok) throw new Error("线下摘要读取失败");
    const summaries = await response.json() as CloudMessage[];
    if (!Array.isArray(summaries)) throw new Error("线下摘要格式错误");
    mirrors.push(...summaries);
  }
  const records = new Map<string, CloudMessage>();
  const cloudIds = new Set(outputs.map(o => `push-outbox:${o.id}`));
  const snapshots = new Map<string, CloudMessage[]>();
  // 整轮快照按批次取，每行是原子替换；空列表表示整轮删除
  const batchIds = [...cloudIds];
  for (let start = 0; start < batchIds.length; start += 50) {
    const ids = batchIds.slice(start, start + 50).map(id => JSON.stringify(id)).join(",");
    const response = await rest(`push_chat_mirror?${scope}&media_type=eq.response_batch&response_batch_id=in.(${encodeURIComponent(ids)})&select=id,content,response_batch_id,media_type&limit=50`);
    if (!response.ok) throw new Error("整轮聊天镜像读取失败");
    for (const row of await response.json() as CloudMessage[]) {
      if (row.media_type !== "response_batch" || !row.response_batch_id || !cloudIds.has(row.response_batch_id)) continue;
      const value = JSON.parse(row.content) as { v?: number; messages?: CloudMessage[] };
      if (value.v !== 1 || !Array.isArray(value.messages) || value.messages.some(m =>
        typeof m.id !== "string" || typeof m.content !== "string" || !Number.isFinite(Date.parse(m.message_at)))) {
        throw new Error("整轮聊天镜像格式异常");
      }
      snapshots.set(row.response_batch_id, value.messages);
    }
  }
  for (const m of mirrors) {
    if (!m || !["user", "assistant"].includes(m.role) || !Number.isFinite(Date.parse(m.message_at))) continue;
    if (m.media_type === "response_batch") continue;
    if (m.response_batch_id && cloudIds.has(m.response_batch_id)) continue;
    records.set(`mirror:${m.id}`, m);
  }
  // 旧宿主导入的气泡带的是收取时间：只认在那个时间点完整、唯一的连续序列
  const compact = (s: string) => s.replace(/\s+/g, "").trim();
  const legacy = mirrors.filter(m => records.has(`mirror:${m.id}`) && !m.response_batch_id && m.media_type !== "offline_summary")
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id));
  const candidates = new Map<string, { groups: CloudMessage[][]; output: CloudOutput }>();
  for (const o of outputs) {
    const receivedAt = Date.parse(o.consumed_at || "");
    if (!Number.isFinite(receivedAt)) continue;
    const raw = String(o.raw_text || "");
    const forms = new Set([compact(raw), compact(raw.split(/\[(?:内心|心声)\]/)[0])].filter(Boolean));
    const matches: CloudMessage[][] = [];
    for (let start = 0; start < legacy.length; start++) {
      const group: CloudMessage[] = []; let text = "";
      for (const m of legacy.slice(start, start + 40)) {
        if (m.role !== "assistant" || !records.has(`mirror:${m.id}`) || Math.abs(Date.parse(m.message_at) - receivedAt) > 120_000) break;
        group.push(m); text += compact(m.content);
        if (forms.has(text)) matches.push([...group]);
        if (![...forms].some(f => f.startsWith(text))) break;
      }
    }
    candidates.set(o.id, { groups: matches, output: o });
  }
  const owners = new Map<string, Set<string>>();
  for (const [id, candidate] of candidates) for (const group of candidate.groups) for (const m of group) {
    if (!owners.has(m.id)) owners.set(m.id, new Set());
    owners.get(m.id)!.add(id);
  }
  const uncertainLegacy: NonNullable<CloudHistory["uncertainLegacy"]> = [];
  for (const candidate of candidates.values()) {
    if (candidate.groups.length === 1 && candidate.groups[0].every(m => owners.get(m.id)?.size === 1)) {
      for (const m of candidate.groups[0]) records.delete(`mirror:${m.id}`);
    }
  }
  for (const m of legacy) {
    if (m.role !== "assistant" || !records.has(`mirror:${m.id}`)) continue;
    const exact = [...(owners.get(m.id) || [])];
    if (!exact.length) continue;
    uncertainLegacy.push({ message: m, outputIds: exact, exactText: true });
    records.delete(`mirror:${m.id}`);
  }
  let lastGeneratedAt = 0;
  for (const o of outputs) {
    const at = Date.parse(o.created_at);
    if (!Number.isFinite(at)) continue;
    lastGeneratedAt = Math.max(lastGeneratedAt, at);
    const id = `push-outbox:${o.id}`;
    const snapshot = snapshots.get(id);
    if (snapshot && !snapshot.length) continue;
    records.set(id, { id, role: "assistant", content: snapshot ? snapshot.map(m => m.content).join("\n") : String(o.raw_text || ""), message_at: o.created_at });
  }
  return {
    messages: [...records.values()].sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id)),
    outputs, lastGeneratedAt, uncertainLegacy,
  };
}

export function historyText(history: CloudHistory, tz: number, limit = 80, window?: HistoryWindow): string {
  const selected = hasWindow(window) ? selectHistory(history.messages, window!) : history.messages.filter(m => m.media_type !== "offline_summary").slice(-limit);
  const main = selected.map(m => {
    const local = new Date(Date.parse(m.message_at) + tz * 60_000).toISOString().slice(0, 16).replace("T", " ");
    return `[${m.id}] ${local} ${m.media_type === "offline_summary" ? "线下摘要（概述双方互动，非角色原话）" : m.role === "user" ? "用户" : "你"}：${m.content.slice(0, m.media_type === "offline_summary" ? 500 : 4000)}`;
  }).join("\n");
  const uncertain = (history.uncertainLegacy || []).slice(-20);
  if (!uncertain.length) return main;
  return main + "\n[旧镜像待核对资料：可能是补收副本，不能当作新发言、新承诺或新增未回应轮次；不推断用户已读。原始记录未删除。]\n"
    + uncertain.map(({ message: m, outputIds, exactText }) => `[mirror:${m.id}] 记录时间 ${m.message_at}；可能对应 ${outputIds.map(id => "push-outbox:" + id).join(",")}；`
      + (exactText ? "正文已见对应云端输出，不重复列出。" : "待核对原文：" + m.content.slice(0, 4000))).join("\n");
}

/** TA连续几轮主动没等到回：最新一轮要晾满 30 分钟才计数 */
export function unansweredRounds(history: CloudHistory, nowMs: number): number {
  let rounds = 0, last = Infinity;
  for (const m of [...history.messages].filter(m => m.media_type !== "offline_summary").reverse()) {
    if (m.role === "user") break;
    const at = Date.parse(m.message_at);
    if (last - at > 3 * 60_000 && nowMs - at >= 30 * 60_000) rounds++;
    last = at;
  }
  return rounds;
}

/** 最近一次主动消息的时间：约定到点不算，被动回复不算 */
export function lastProactiveAt(history: CloudHistory): number {
  return history.outputs.reduce((at, o) => {
    if (!o.trigger_key?.startsWith("timedwake:")) return at;
    const event = o.meta?.guanianPromise as { id?: string } | undefined;
    const context = o.meta?.guanianContext as { revision?: number | null } | undefined;
    if (event?.id || context?.revision) return at;
    return Math.max(at, Date.parse(o.created_at) || 0);
  }, 0);
}
