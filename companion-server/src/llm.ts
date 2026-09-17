// 模型调用：借手机寄来的请求（地址、密钥、人设、预设），在末尾追加任务或备忘。
// 响应解析、用量记账、推送预览分条都从 push-recheck / push-generate 搬来。

import type { Rest } from "./supabase.ts";
import type { ModelRequest, ProviderKind } from "./types.ts";

const PLACEHOLDER = "__CUSTOM_APP_INSTRUCTION__";

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>;

function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      return typeof item.text === "string" ? item.text : "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

export function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    let text = "";
    for (const block of (data as { content?: unknown[] }).content || []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; output?: { text?: string }; response?: string };
  return stripHallucinatedTimestamps(textFromContent(d.choices?.[0]?.message?.content).trim()
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : ""));
}

export function extractUsage(providerKind: ProviderKind, data: unknown): { prompt: number; completion: number } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  if (providerKind === "gemini") {
    const u = d.usageMetadata || {};
    return { prompt: n(u.promptTokenCount), completion: n(u.candidatesTokenCount) };
  }
  const u = d.usage || {};
  if (providerKind === "anthropic") {
    return { prompt: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), completion: n(u.output_tokens) };
  }
  return { prompt: n(u.prompt_tokens), completion: n(u.completion_tokens) };
}

/** 追加一条用户视角的备忘（各家消息结构不同） */
export function appendUserNote(body: Record<string, unknown>, providerKind: ProviderKind, note: string): boolean {
  if (providerKind === "gemini") {
    if (!Array.isArray(body.contents)) return false;
    body.contents.push({ role: "user", parts: [{ text: note }] });
    return true;
  }
  if (!Array.isArray(body.messages)) return false;
  body.messages.push(providerKind === "anthropic" ? { role: "user", content: [{ type: "text", text: note }] } : { role: "user", content: note });
  return true;
}

/** 挂念专用模板里最后一条是「[挂念] __CUSTOM_APP_INSTRUCTION__」，把占位符换成真正的指令 */
function fillTemplate(body: Record<string, unknown>, providerKind: ProviderKind, instruction: string): boolean {
  let hit = false;
  const fix = (text: string) => {
    if (!text.includes(PLACEHOLDER)) return text;
    hit = true;
    return text.split(PLACEHOLDER).join(instruction);
  };
  const walkParts = (parts: unknown) => {
    for (const part of Array.isArray(parts) ? parts : []) {
      const p = part as Record<string, unknown>;
      if (typeof p?.text === "string") p.text = fix(p.text);
    }
  };
  if (providerKind === "gemini") {
    for (const one of Array.isArray(body.contents) ? body.contents : []) walkParts((one as Record<string, unknown>)?.parts);
    return hit;
  }
  for (const one of Array.isArray(body.messages) ? body.messages : []) {
    const m = one as Record<string, unknown>;
    if (typeof m?.content === "string") m.content = fix(m.content);
    else walkParts(m?.content);
  }
  return hit;
}

function nonStreaming(body: Record<string, unknown>, providerKind: ProviderKind, maxTokens: number): void {
  if (providerKind === "gemini") {
    body.generationConfig = { maxOutputTokens: maxTokens, ...((body.generationConfig || {}) as Record<string, unknown>) };
  } else {
    body.stream = false; delete body.stream_options;
    if (!body.max_tokens && !body.max_completion_tokens) body.max_tokens = maxTokens;
  }
}

/** 后台判断/生成任务：有占位符就替换，没有就在末尾追加；去掉工具 */
export function buildTaskRequest(template: ModelRequest, instruction: string): ModelRequest {
  const body = structuredClone(template.body);
  const task = instruction.startsWith("【后台") ? instruction : "【后台判断任务：本轮仅按下面要求输出 JSON，不生成聊天回复、不调用工具】\n" + instruction;
  if (!fillTemplate(body, template.providerKind, instruction)) appendUserNote(body, template.providerKind, task);
  delete body.tools; delete body.tool_choice; delete body.toolConfig;
  nonStreaming(body, template.providerKind, 2048);
  return { ...template, body };
}

/** 聊天请求：在快照末尾依次追加备忘 */
export function buildChatRequest(template: ModelRequest, notes: string[]): ModelRequest {
  const body = structuredClone(template.body);
  for (const note of notes) if (note) appendUserNote(body, template.providerKind, note);
  delete body.tools; delete body.tool_choice; delete body.toolConfig;
  nonStreaming(body, template.providerKind, 4096);
  return { ...template, body };
}

export type ModelResult = { text: string; data: unknown };

export async function callModel(request: ModelRequest, fetchImpl: ModelFetch = fetch, timeoutMs = 240_000): Promise<ModelResult> {
  const response = await fetchImpl(request.url, {
    method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`模型 HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 160)}`);
  const data = await response.json();
  return { text: extractResponseText(request.providerKind, data), data };
}

/** 模型爱把 JSON 裹在解释或 ``` 里：先整体解析，再逐个截取平衡的花括号 */
export function parseModelJson(text: unknown): any {
  const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(t); } catch { /* 继续截取 */ }
  for (let a = t.indexOf("{"); a >= 0; a = t.indexOf("{", a + 1)) {
    let depth = 0, inStr = false, escaped = false;
    for (let i = a; i < t.length; i++) {
      const ch = t[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(t.slice(a, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error("模型没回 JSON，它说的是：「" + t.slice(0, 100) + (t.length > 100 ? "…" : "") + "」");
}

/** 第一次没拿到 JSON 就追加严格指令再试一次（与 App generateJson 一致） */
export async function generateJson(template: ModelRequest, instruction: string, fetchImpl: ModelFetch,
  record: (providerKind: ProviderKind, data: unknown) => Promise<void>, log: (line: string) => void): Promise<any> {
  const once = async (inst: string) => {
    const result = await callModel(buildTaskRequest(template, inst), fetchImpl);
    await record(template.providerKind, result.data);
    return parseModelJson(result.text);
  };
  try { return await once(instruction); } catch (e) {
    log("首次生成未得到 JSON（" + (e instanceof Error ? e.message : String(e)) + "），追加严格指令重试");
    return await once(instruction + "\n\n重要：只输出 JSON 本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何解释、前言、思考过程或代码块标记。");
  }
}

/** 拆出可见台词和思考块；不完整的思考标签不能当台词交付 */
export function visibleResponse(text: string, config: unknown): { text: string; reasoningText?: string } {
  const settings = config as { enabled?: boolean; tag?: string } | undefined;
  if (settings?.enabled === false) return { text: text.trim() };
  const tags = settings?.enabled === true
    ? [typeof settings.tag === "string" && settings.tag.trim() ? settings.tag.trim() : "thinking"]
    : ["thinking", "think", "thought"];
  const thoughts: string[] = [];
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "gi"), (_block, thought: string) => {
      if (thought.trim()) thoughts.push(thought.trim());
      return "";
    });
    if (new RegExp(`</?${escaped}>`, "i").test(text)) throw new Error("思考块不完整");
  }
  return { text: text.trim(), reasoningText: thoughts.join("\n\n") || undefined };
}

// ── 推送预览分条（lib/push-preview-split）
const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  return text.replace(/\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g, (m, rawName: string) => {
    const name = rawName.trim();
    if (!name || /^\d+$/.test(name) || RICH_MEDIA_NAMES.has(name)) return m;
    return "";
  });
}

function stripBracketBlock(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

function humanizeSegment(segment: string): string {
  const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
  if (!marker) return segment;
  const kind = marker[1];
  if (/表情包/.test(kind)) return "[表情包]";
  if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
  if (/语音通话/.test(kind)) return "发起了语音通话";
  if (/视频通话/.test(kind)) return "发起了视频通话";
  if (/语音/.test(kind)) return "[语音]";
  if (/红包/.test(kind)) return "[红包]";
  if (/转账/.test(kind)) return "[转账]";
  if (/位置/.test(kind)) return "[位置]";
  if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
  return segment;
}

export function splitPreview(rawText: string): string[] {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.split(/\n\n+/).map(s => humanizeSegment(s.trim())).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// ── 用量账本（个人云 push_api_usage / push_api_limits，与云函数共用同一套上限）
export type UsageBudget = { day: string; tz: number; calls: number; tokens: number; dailyCalls: number; dailyTokens: number };

function usageLocalDay(nowMs: number, tz: number): string {
  const d = new Date(nowMs + tz * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function usageBudget(rest: Rest, userId: string, nowMs = Date.now()): Promise<UsageBudget> {
  const limitsRes = await rest(`push_api_limits?user_id=eq.${encodeURIComponent(userId)}&select=daily_calls,daily_tokens,tz&limit=1`).catch(() => null);
  const limits = limitsRes?.ok ? (await limitsRes.json().catch(() => []) as { daily_calls?: number; daily_tokens?: number; tz?: number }[])[0] : undefined;
  const tz = Number(limits?.tz) || 0;
  const day = usageLocalDay(nowMs, tz);
  const rowsRes = await rest(`push_api_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${encodeURIComponent(day)}&source=neq.cloud-chat&select=calls,prompt_tokens,completion_tokens`).catch(() => null);
  const rows = rowsRes?.ok ? await rowsRes.json().catch(() => []) as { calls: number; prompt_tokens: number; completion_tokens: number }[] : [];
  let calls = 0, tokens = 0;
  for (const r of rows) { calls += Number(r.calls) || 0; tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0); }
  return { day, tz, calls, tokens, dailyCalls: Number(limits?.daily_calls) || 0, dailyTokens: Number(limits?.daily_tokens) || 0 };
}

export function usageExceeded(b: UsageBudget): string {
  if (b.dailyCalls > 0 && b.calls >= b.dailyCalls) return `今天的模型调用次数用完了（${b.calls}/${b.dailyCalls}）`;
  if (b.dailyTokens > 0 && b.tokens >= b.dailyTokens) return `今天的 token 额度用完了（${b.tokens}/${b.dailyTokens}）`;
  return "";
}

export async function usageAdd(rest: Rest, userId: string, tz: number, source: string, providerKind: ProviderKind, data: unknown): Promise<void> {
  const u = extractUsage(providerKind, data);
  await rest("rpc/ai_phone_usage_add", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_user_id: userId, p_day: usageLocalDay(Date.now(), tz), p_source: source, p_calls: 1, p_prompt: u.prompt, p_completion: u.completion }),
  }).catch(() => undefined);
}
