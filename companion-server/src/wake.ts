// 唤醒后端：外部事件（花园、任意 Webhook 来源…）叫醒角色，在 VPS 上跑完「回复 + 调工具」，结果寄回手机。
//   收件：本机事件网关（tools/tool-events，127.0.0.1:18062）负责适配器、投递鉴权、去重和排队；
//         处理方式选了「交给 VPS 后端」（mode=server）的来源只由这里领取，手机不再领。
//   底稿：手机按来源冻一份唤醒模板寄来（PUT /app/wake/templates/:sourceId）：聊天提示词 + 完整聊天记录，
//         末尾一条占位的用户消息；绑定的 MCP 地址和请求头、原生工具名对照、文字协议的指令说明。
//   处理：领到事件先 ack（与手机一致：工具可能有副作用，失败不自动重放）→ 占位换成事件原文 →
//         多轮调模型，模型要调工具就经 MCP 调 → 最终回复写 push_outbox（meta.toolEvent 带事件原文和动作记录）→ Web Push。
//   手机补收时先落「事件原文」这条用户消息和动作灰条，再按普通离线回复解析。

import { acquireGenerationLease, GenerationBusy, type GenerationLease } from "./generation-lease.ts";
import { readHistory, historyText, type CloudHistory } from "./history.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { appendUserNote, callModel, splitPreview, usageAdd, usageBudget, usageExceeded, type ModelFetch } from "./llm.ts";
import { McpClient, type McpFetch, type McpResult } from "./mcp.ts";
import type { PushMessage, PushResult } from "./push.ts";
import type { Store } from "./store.ts";
import type { Rest } from "./supabase.ts";
import { fillChatTemplate } from "./templates.ts";
import type { ModelRequest, ProviderKind } from "./types.ts";

export type WakeProtocol = "native" | "text" | "none";

export type WakeTemplate = {
  sourceId: string;
  characterId: string;
  sessionId: string;
  capturedAt: number;
  /** 聊天请求：历史末尾是一条内容为 placeholder 的用户消息；原生协议时 body 里已带工具定义 */
  request: ModelRequest;
  placeholder: string;
  protocol: WakeProtocol;
  /** 原生工具名 → MCP 真实工具名 */
  toolNames: Record<string, string>;
  /** 文字协议 [获取指令:X] 的返回说明，键是 X */
  schemaText: Record<string, string>;
  mcp: { url: string; headers: Record<string, string> } | null;
  maxRounds: number;
  merge: Record<string, unknown>;
  notify: { title?: string; url?: string };
};

export type WakeEvent = {
  id: string; messageId: string; sourceId: string; serverId: string; characterId: string; mode: string;
  message: string; reason: string; createdAt: string;
};

export type WakeAction = { name: string; args: Record<string, unknown>; ok: boolean; text: string };

export type WakeRunRow = {
  id: number; sourceId: string; characterId: string; eventId: string; at: number;
  status: string; note: string; data: Record<string, unknown> | null;
};

const PROVIDERS = new Set<ProviderKind>(["openai-compatible", "anthropic", "gemini"]);

export function validateWakeTemplate(value: unknown): string | null {
  const t = value as Partial<WakeTemplate> | null;
  if (!t || typeof t !== "object") return "模板不是对象";
  if (typeof t.sourceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,149}$/.test(t.sourceId)) return "sourceId 无效";
  if (typeof t.characterId !== "string" || !t.characterId) return "缺少 characterId";
  if (typeof t.sessionId !== "string" || !t.sessionId) return "缺少 sessionId";
  if (!Number.isFinite(t.capturedAt)) return "capturedAt 无效";
  const r = t.request;
  if (!r || typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || !r.headers || !r.body || !PROVIDERS.has(r.providerKind as ProviderKind)) return "request 无效";
  if (typeof t.placeholder !== "string" || t.placeholder.length < 8 || !JSON.stringify(r.body).includes(t.placeholder)) return "请求里找不到事件占位";
  if (!["native", "text", "none"].includes(String(t.protocol))) return "protocol 无效";
  if (!t.toolNames || typeof t.toolNames !== "object" || !t.schemaText || typeof t.schemaText !== "object") return "工具对照无效";
  if (t.mcp !== null && (!t.mcp || typeof t.mcp.url !== "string" || !/^https:\/\//.test(t.mcp.url) || !t.mcp.headers || typeof t.mcp.headers !== "object")) return "mcp 地址必须是 https";
  if (!t.merge || typeof t.merge !== "object" || !t.notify || typeof t.notify !== "object") return "缺少 merge / notify";
  return null;
}

// ─── 模型回合里的工具调用：解析 + 把这一轮和工具结果接回请求

type Call = { id: string; name: string; args: Record<string, unknown> };

const objectArgs = (v: unknown): Record<string, unknown> => {
  if (typeof v === "string") { try { v = JSON.parse(v || "{}"); } catch { return {}; } }
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
};

export function nativeCalls(kind: ProviderKind, data: any): Call[] {
  if (kind === "anthropic") {
    return (Array.isArray(data?.content) ? data.content : []).filter((b: any) => b?.type === "tool_use")
      .map((b: any) => ({ id: String(b.id || randomUUID()), name: String(b.name || ""), args: objectArgs(b.input) }));
  }
  if (kind === "gemini") {
    return (data?.candidates?.[0]?.content?.parts || []).filter((p: any) => p?.functionCall)
      .map((p: any) => ({ id: `gemini_${randomUUID()}`, name: String(p.functionCall.name || ""), args: objectArgs(p.functionCall.args) }));
  }
  return (data?.choices?.[0]?.message?.tool_calls || []).map((c: any) => ({
    id: String(c?.id || randomUUID()), name: String(c?.function?.name || ""), args: objectArgs(c?.function?.arguments),
  }));
}

/** 与小手机 formatNativeChatToolResult 一致 */
export function nativeResultText(name: string, r: McpResult): string {
  return [
    `<action_result name="${name}" success="${r.ok ? "true" : "false"}">`,
    r.text || (r.ok ? "执行成功。" : "执行失败。"),
    "</action_result>",
    "工具结果已经返回给你，不要重复你之前已经说过的内容，不要再次执行相同的动作。",
  ].join("\n");
}

/** 把模型这一轮原样接回去（保留 thoughtSignature、reasoning_content 等），再接工具结果 */
export function appendNativeTurn(body: any, kind: ProviderKind, data: any, results: { call: Call; content: string }[]): void {
  if (kind === "anthropic") {
    body.messages.push({ role: "assistant", content: data.content });
    body.messages.push({ role: "user", content: results.map(r => ({ type: "tool_result", tool_use_id: r.call.id, content: r.content })) });
    return;
  }
  if (kind === "gemini") {
    body.contents.push({ role: "model", parts: data.candidates[0].content.parts });
    body.contents.push({ role: "tool", parts: results.map(r => ({ functionResponse: { name: r.call.name, response: { result: r.content } } })) });
    return;
  }
  const msg = data.choices[0].message;
  body.messages.push({
    role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls,
    ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
    ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}),
  });
  for (const r of results) body.messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content });
}

// 文字协议：[获取指令:X] / [执行动作:名字({参数})]，与小手机 parseToolFetches / parseToolCalls 同规则

export function textFetches(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[["“]?[^"”\]]*?["”]?\s*(?:获取指令|获取工具)[:：]\s*([^\]]+?)\s*\]/g)) out.push(m[1].trim());
  return out;
}

function argsJson(raw: string): Record<string, unknown> | null {
  for (const text of [raw.trim(), raw.trim().replace(/'/g, '"')]) {
    try { const v = JSON.parse(text); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* 下一个 */ }
  }
  return null;
}

export function textCalls(text: string): { calls: Call[]; clean: string } {
  const calls: Call[] = [];
  const spans: [number, number][] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("[", pos);
    if (start < 0) break;
    pos = start + 1;
    let opener = -1;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\n" || text[i] === "]") break;
      if (text[i] === "(" || text[i] === "（") { opener = i; break; }
    }
    if (opener < 0) continue;
    const head = /^(.*?)\s*(?:执行动作|工具调用)\s*[:：]\s*(.+)$/.exec(text.slice(start + 1, opener).trim());
    if (!head || !head[2].trim()) continue;
    let depth = 1, quote = "", escaped = false, end = -1, argsRaw = "";
    for (let i = opener + 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "]" && depth === 1 && argsJson(text.slice(opener + 1, i))) { argsRaw = text.slice(opener + 1, i); end = i + 1; break; }
      if (ch === "(" || ch === "（") { depth++; continue; }
      if (ch !== ")" && ch !== "）") continue;
      if (--depth !== 0) continue;
      let close = i + 1;
      while (close < text.length && /\s/.test(text[close])) close++;
      if (text[close] === "]") { argsRaw = text.slice(opener + 1, i); end = close + 1; }
      break;
    }
    if (end < 0) continue;
    calls.push({ id: randomUUID(), name: head[2].trim(), args: argsJson(argsRaw) || {} });
    spans.push([start, end]);
    pos = end;
  }
  let clean = "", cursor = 0;
  for (const [a, b] of spans) { clean += text.slice(cursor, a); cursor = b; }
  clean += text.slice(cursor);
  return { calls, clean: clean.replace(/\[["“]?[^"”\]]*?["”]?\s*(?:获取指令|获取工具)[:：]\s*[^\]]+?\s*\]/g, "").replace(/\n{3,}/g, "\n\n").trim() };
}

/** 与小手机 formatToolResults 一致 */
export function textResultsText(results: { name: string; r: McpResult }[]): string {
  const items = results.map(({ name, r }) => r.ok
    ? `<action_result name="${name}">${r.text}</action_result>`
    : `<action_result name="${name}" error="${r.text || "未知错误"}"></action_result>`).join("\n");
  return `以下是系统处理结果：\n${items}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}

function messageList(body: any, kind: ProviderKind): any[] {
  return kind === "gemini" ? body.contents : body.messages;
}

function textMessage(kind: ProviderKind, role: "user" | "assistant", text: string): unknown {
  if (kind === "gemini") return { role: role === "assistant" ? "model" : "user", parts: [{ text }] };
  if (kind === "anthropic") return { role, content: [{ type: "text", text }] };
  return { role, content: text };
}

// ─── 一次唤醒

export type WakeDeps = {
  store: Store;
  rest: Rest;
  userId: string;
  fetchModel: ModelFetch;
  fetchMcp?: McpFetch;
  push: (messages: PushMessage[]) => Promise<PushResult>;
  now: () => number;
  log: (line: string) => void;
};

export type WakeOutcome = { status: "sent" | "silent"; note: string; text: string; actions: WakeAction[]; outboxId?: string };

export async function runWake(deps: WakeDeps, tpl: WakeTemplate, event: WakeEvent, beforeRun?: () => Promise<void>): Promise<WakeOutcome> {
  const lease = await acquireGenerationLease(deps.rest, deps.userId, tpl.sessionId, "wake:" + event.id);
  try {
    const history = await readHistory(deps.rest, deps.userId, tpl.sessionId);
    await lease.check();
    // 在拿到会话锁且读到最新事实后才 ack；等待锁不能把事件提前消费掉。
    await beforeRun?.();
    return await runWakeLocked(deps, tpl, event, history, lease);
  } finally { await lease.release(); }
}

async function runWakeLocked(deps: WakeDeps, tpl: WakeTemplate, event: WakeEvent, history: CloudHistory, lease: GenerationLease): Promise<WakeOutcome> {
  const nowMs = deps.now();
  const kind = tpl.request.providerKind;
  const tz = Number(tpl.merge.tzOffsetMin);
  const filled = fillChatTemplate(tpl.request, { intentPlaceholder: tpl.placeholder, ...(Number.isFinite(tz) ? { tzOffsetMin: tz } : {}) }, { intent: event.message, elapsedMin: 0, nowMs });
  const body: any = filled.body;
  const newer = history.messages.filter(m => Date.parse(m.message_at) > tpl.capturedAt);
  if (newer.length) appendUserNote(body, kind, "[模板冻结之后的最新聊天事实，非用户新消息；与旧底稿冲突时以此为准，不代表已读]\n"
    + historyText({ ...history, messages: newer, uncertainLegacy: [] }, Number.isFinite(tz) ? tz : 0, 80));
  if (kind === "gemini") body.generationConfig = { maxOutputTokens: 4096, ...(body.generationConfig || {}) };
  else { body.stream = false; delete body.stream_options; if (!body.max_tokens && !body.max_completion_tokens) body.max_tokens = 4096; }
  if (tpl.protocol !== "native") { delete body.tools; delete body.tool_choice; delete body.toolConfig; }
  const list = messageList(body, kind);
  // 文字协议的工具往返插在事件消息后面（与小手机插在历史末尾一致），原生协议接在最后
  const needle = JSON.stringify(event.message).slice(1, -1);
  let insertAt = list.length;
  for (let i = list.length - 1; i >= 0; i--) if (JSON.stringify(list[i]).includes(needle)) { insertAt = i + 1; break; }

  const budget = await usageBudget(deps.rest, deps.userId, nowMs);
  const exceeded = usageExceeded(budget);
  if (exceeded) throw new Error(exceeded);

  const mcp = tpl.mcp ? new McpClient(tpl.mcp.url, tpl.mcp.headers, deps.fetchMcp) : null;
  const call = async (name: string, args: Record<string, unknown>): Promise<McpResult> => {
    if (!mcp) return { ok: false, text: "这个唤醒来源没有绑定可用的 MCP" };
    await lease.check();
    return mcp.callTool(name, args);
  };
  const parts: string[] = [];
  const actions: WakeAction[] = [];
  const maxRounds = Math.min(10, Math.max(1, Math.floor(tpl.maxRounds) || 5));
  for (let round = 0; round < maxRounds; round++) {
    await lease.check();
    const result = await callModel({ ...filled, body }, deps.fetchModel);
    await usageAdd(deps.rest, deps.userId, budget.tz, "wake", kind, result.data);
    if (tpl.protocol === "native") {
      const calls = nativeCalls(kind, result.data);
      if (result.text.trim()) parts.push(result.text.trim());
      if (!calls.length) break;
      const results: { call: Call; content: string }[] = [];
      for (const c of calls) {
        const real = tpl.toolNames[c.name] || c.name;
        const r = tpl.toolNames[c.name] ? await call(real, c.args) : { ok: false, text: "动作未找到" };
        actions.push({ name: real, args: c.args, ok: r.ok, text: r.text });
        results.push({ call: c, content: nativeResultText(real, r) });
      }
      appendNativeTurn(body, kind, result.data, results);
      continue;
    }
    const raw = result.text.trim();
    const fetches = tpl.protocol === "text" ? textFetches(raw) : [];
    const parsed = tpl.protocol === "text" ? textCalls(raw) : { calls: [], clean: raw };
    if (parsed.clean) parts.push(parsed.clean);
    if (!fetches.length && !parsed.calls.length) break;
    const inserts: unknown[] = [textMessage(kind, "assistant", raw)];
    if (fetches.length) {
      inserts.push(textMessage(kind, "user", fetches.map(name => tpl.schemaText[name] || `以下是你获取指令的返回结果：\n动作类别「${name}」未找到，请检查名称。`).join("\n\n")));
    } else {
      const results: { name: string; r: McpResult }[] = [];
      for (const c of parsed.calls) {
        const r = await call(c.name, c.args);
        actions.push({ name: c.name, args: c.args, ok: r.ok, text: r.text });
        results.push({ name: c.name, r });
      }
      inserts.push(textMessage(kind, "user", textResultsText(results)));
    }
    list.splice(insertAt, 0, ...inserts);
    insertAt += inserts.length;
  }

  const rawText = parts.join("\n\n").trim();
  const createdAt = new Date(deps.now()).toISOString();
  const outboxId = `out_${randomUUID()}`;
  await lease.check();
  await writeOutbox(deps, tpl, event, { outboxId, rawText, createdAt, actions });
  if (!rawText) return { status: "silent", note: actions.length ? `调了 ${actions.length} 次工具，没说话` : "角色没说话", text: "", actions, outboxId };
  const title = String(tpl.notify.title || tpl.merge.characterName || "小手机");
  const previews = splitPreview(rawText).slice(0, 6);
  const pushed = await deps.push((previews.length ? previews : ["发来一条消息"]).map((line, index) => ({
    type: "chat_outbox", title, body: line.slice(0, 80), tag: `wake-${event.id}-${index}`, url: tpl.notify.url || "/", characterId: tpl.characterId,
  }))).catch(e => ({ sent: 0, total: 0, removed: 0, skippedShell: 0, errors: [e instanceof Error ? e.message : String(e)] }));
  return { status: "sent", note: `回复已寄出（推送 ${pushed.sent}/${pushed.total}）`, text: rawText, actions, outboxId };
}

async function writeOutbox(deps: WakeDeps, tpl: WakeTemplate, event: WakeEvent, o: { outboxId: string; rawText: string; createdAt: string; actions: WakeAction[]; error?: string }): Promise<void> {
  const { tzOffsetMin: _tz, ...merge } = tpl.merge;
  const meta = {
    ...merge,
    sessionId: tpl.sessionId,
    pushGenerated: true,
    companionServer: true,
    toolEvent: {
      id: event.id, messageId: event.messageId, sourceId: event.sourceId, reason: event.reason, message: event.message, createdAt: event.createdAt,
      actions: o.actions.map(a => ({ name: a.name, ok: a.ok, args: a.args, text: a.text.slice(0, 2000) })),
      ...(o.error ? { error: o.error } : {}),
    },
  };
  const saved = await deps.rest("push_outbox", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ id: o.outboxId, user_id: deps.userId, job_id: null, session_id: tpl.sessionId, trigger_key: `wake:${event.id}`, raw_text: o.rawText, created_at: o.createdAt, meta }]),
  });
  if (!saved.ok) throw new Error(`outbox 写入失败 HTTP ${saved.status}: ${(await saved.text().catch(() => "")).slice(0, 160)}`);
}

// ─── 轮询事件网关

export type Gateway = (body: Record<string, unknown>) => Promise<any>;

export function localGateway(url: string, tokenFile: string, fetchImpl: typeof fetch = fetch): Gateway {
  return async body => {
    const token = (await readFile(tokenFile, "utf8")).trim();
    const res = await fetchImpl(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`事件网关 HTTP ${res.status}：${String((data as { error?: string }).error || "")}`);
    return data;
  };
}

export type GatewaySource = { serverId: string; characterId: string; mode: string; adapter: string; status: string; lastError: string };

export class WakeService {
  #deps: WakeDeps;
  #gateway: Gateway;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #waiting = new Set<string>();
  #statuses = new Map<string, string>();
  lastPollAt = 0;
  lastError = "";
  sources: GatewaySource[] = [];

  constructor(deps: WakeDeps, gateway: Gateway) {
    this.#deps = deps;
    this.#gateway = gateway;
  }

  start(intervalMs = 15_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.poll(); }, intervalMs);
    setTimeout(() => { void this.poll(); }, 3_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async poll(): Promise<number> {
    if (this.#busy) return 0;
    this.#busy = true;
    let handled = 0;
    try {
      const inbox = await this.#gateway({ action: "events", mode: "server" });
      this.lastPollAt = this.#deps.now();
      if (this.lastError) this.#deps.log("[wake] 事件网关恢复");
      this.lastError = "";
      this.sources = (Array.isArray(inbox.sources) ? inbox.sources : []) as GatewaySource[];
      await this.#watchSources();
      for (const event of (Array.isArray(inbox.events) ? inbox.events : []) as WakeEvent[]) {
        if (await this.#handle(event)) handled += 1;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.lastError) this.#deps.log(`[wake] 轮询失败：${msg}`);
      this.lastError = msg;
    } finally {
      this.#busy = false;
    }
    return handled;
  }

  /** 交给后端的来源断开了（花园断线不自动重连）：推一条提醒，去工具箱手动启动 */
  async #watchSources(): Promise<void> {
    for (const s of this.sources) {
      const prev = this.#statuses.get(s.serverId);
      this.#statuses.set(s.serverId, s.status);
      if (s.mode !== "server" || prev !== "connected" || s.status !== "stopped") continue;
      const note = s.lastError || "来源已停止";
      this.#deps.store.addWakeRun({ sourceId: s.serverId, characterId: s.characterId, eventId: "", status: "disconnected", note, data: null, at: this.#deps.now() });
      await this.#deps.push([{ type: "wake_source", title: "唤醒来源断开了", body: `${note.slice(0, 60)} 去工具箱里手动启动。`, tag: `wake-source-${s.serverId}`, url: "/" }]).catch(() => undefined);
    }
  }

  async #handle(event: WakeEvent): Promise<boolean> {
    const { store } = this.#deps;
    const tpl = store.getWakeTemplate(event.sourceId);
    const stale = !tpl ? "手机还没寄来这个来源的唤醒模板" : tpl.characterId !== event.characterId ? "唤醒模板绑定的角色和来源配置不一致，等手机重寄" : "";
    if (stale) {
      if (!this.#waiting.has(event.id)) {
        this.#waiting.add(event.id);
        store.addWakeRun({ sourceId: event.sourceId, characterId: event.characterId, eventId: event.id, status: "waiting", note: stale, data: { message: event.message.slice(0, 200) }, at: this.#deps.now() });
        this.#deps.log(`[wake] ${event.sourceId} 事件先留在网关：${stale}`);
      }
      return false;
    }
    let accepted = false;
    const base = { sourceId: event.sourceId, characterId: event.characterId, eventId: event.id };
    try {
      const out = await runWake(this.#deps, tpl!, event, async () => {
        const ack = await this.#gateway({ action: "ack", ids: [event.id] });
        if (!Array.isArray(ack.acceptedIds) || !ack.acceptedIds.includes(event.id)) throw new GenerationBusy();
        accepted = true;
        this.#waiting.delete(event.id);
      });
      store.addWakeRun({ ...base, status: out.status, note: out.note, at: this.#deps.now(), data: { reason: event.reason, message: event.message.slice(0, 500), text: out.text.slice(0, 500), actions: out.actions.map(a => ({ name: a.name, ok: a.ok, text: a.text.slice(0, 300) })), outboxId: out.outboxId } });
      this.#deps.log(`[wake] ${event.sourceId} → ${tpl!.merge.characterName || event.characterId}：${out.note}`);
    } catch (e) {
      if (!accepted) {
        if (!(e instanceof GenerationBusy)) throw e; // 网络/租约不可用：事件留在网关，下轮重试
        if (!this.#waiting.has(event.id)) {
          this.#waiting.add(event.id);
          store.addWakeRun({ ...base, status: "waiting", note: e.message, data: null, at: this.#deps.now() });
        }
        return false;
      }
      const msg = e instanceof Error ? e.message : String(e);
      store.addWakeRun({ ...base, status: "error", note: msg.slice(0, 300), at: this.#deps.now(), data: { reason: event.reason, message: event.message.slice(0, 500) } });
      this.#deps.log(`[wake] ${event.sourceId} 处理失败：${msg}`);
      // 事件已经领走了：把原文和失败原因寄回聊天，别让它悄悄消失
      await writeOutbox(this.#deps, tpl!, event, { outboxId: `out_${randomUUID()}`, rawText: "", createdAt: new Date(this.#deps.now()).toISOString(), actions: [], error: msg.slice(0, 300) }).catch(() => undefined);
    }
    return true;
  }
}
