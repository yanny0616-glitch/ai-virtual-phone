// 离线推送·兜底生成执行器（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-generate → 粘贴本文件 →
//      关闭 JWT 校验（Enforce JWT verification = off，本函数用 cron_secret 自校验）
// 职责：认领预约 → 解密快照 → 补齐快照之后本服务已发的消息 → 重放 LLM 请求 → 原始输出写 push_outbox →
//      分条推送（800ms 节奏）→ 标记完成。逻辑与 netlify 版一致。
// 注意：本文件为自包含移植，若改动 lib/llm-provider-adapter 的解析或
//      lib/push-preview-split 的分条规则，需同步更新这里。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

// ── 内嵌：Web Push 协议原生实现（RFC8291 aes128gcm + RFC8292 VAPID）──
// npm:web-push 依赖 Node 加密接口，在 Deno Edge 运行时不可靠，这里用 WebCrypto 手写。

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptWebPushPayload(p256dhB64: string, authB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    aesKey,
    plaintext as unknown as BufferSource,
  ));

  // aes128gcm 头：salt(16) + rs(4, 4096) + idlen(1) + as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const pub = b64urlToBytes(publicKeyB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput) as unknown as BufferSource,
  ));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKeyB64}`;
}

/** 发送一条 Web Push；返回 HTTP 状态码（201=成功，404/410=订阅失效）。 */
async function sendWebPushRaw(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttl: number,
): Promise<number> {
  const body = await encryptWebPushPayload(sub.p256dh, sub.auth, payload);
  const authorization = await buildVapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

// ── 内嵌：lib/llm-provider-adapter 的响应文本提取 ──
function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

/* ─── 模型调用用量账本（push_api_usage / push_api_limits）：几个云函数各有一份同样的副本 ─── */
type UsageBudget = { day: string; tz: number; calls: number; tokens: number; dailyCalls: number; dailyTokens: number };
function usageLocalDay(nowMs: number, tz: number): string {
  const d = new Date(nowMs + tz * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function extractUsage(providerKind: ProviderKind, data: unknown): { prompt: number; completion: number } {
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
async function usageBudget(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string): Promise<UsageBudget> {
  const limitsRes = await rest(`push_api_limits?user_id=eq.${encodeURIComponent(userId)}&select=daily_calls,daily_tokens,tz&limit=1`).catch(() => null);
  const limits = limitsRes && limitsRes.ok ? (await limitsRes.json().catch(() => []) as { daily_calls?: number; daily_tokens?: number; tz?: number }[])[0] : undefined;
  const tz = Number(limits?.tz) || 0;
  const day = usageLocalDay(Date.now(), tz);
  const rowsRes = await rest(`push_api_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${encodeURIComponent(day)}&source=neq.cloud-chat&select=calls,prompt_tokens,completion_tokens`).catch(() => null);
  const rows = rowsRes && rowsRes.ok ? await rowsRes.json().catch(() => []) as { calls: number; prompt_tokens: number; completion_tokens: number }[] : [];
  let calls = 0, tokens = 0;
  for (const r of rows) { calls += Number(r.calls) || 0; tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0); }
  return { day, tz, calls, tokens, dailyCalls: Number(limits?.daily_calls) || 0, dailyTokens: Number(limits?.daily_tokens) || 0 };
}
function usageExceeded(b: UsageBudget): string {
  if (b.dailyCalls > 0 && b.calls >= b.dailyCalls) return `今天的模型调用次数用完了（${b.calls}/${b.dailyCalls}）`;
  if (b.dailyTokens > 0 && b.tokens >= b.dailyTokens) return `今天的 token 额度用完了（${b.tokens}/${b.dailyTokens}）`;
  return "";
}
async function usageAdd(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, tz: number, source: string,
  providerKind: ProviderKind, data: unknown): Promise<void> {
  const u = extractUsage(providerKind, data);
  await rest("rpc/ai_phone_usage_add", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_user_id: userId, p_day: usageLocalDay(Date.now(), tz), p_source: source, p_calls: 1, p_prompt: u.prompt, p_completion: u.completion }),
  }).catch(() => undefined);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
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
  const messageText = textFromUnknownContent(d.choices?.[0]?.message?.content).trim();
  const text = messageText
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
  return stripHallucinatedTimestamps(text);
}

// ── 内嵌：lib/push-preview-split 的弹窗预览分条 ──
const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
  return text.replace(regex, (m, rawName: string) => {
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

function splitResponseForPushPreview(rawText: string): string[] {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text
    .split(/\n\n+/)
    .map(segment => humanizeSegment(segment.trim()))
    .map(segment => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// ── 内嵌：lib/server/push-job-crypto 的解密（Web Crypto 实现，格式兼容） ──
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  const ct = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);
  const toB64 = (bytes: Uint8Array) => {
    let raw = "";
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw);
  };
  return { v: 1, iv: toB64(iv), tag: toB64(tag), ct: toB64(ct) };
}

async function decryptPayload(payload: EncryptedPayload, serviceKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serviceKey}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

// ── 主流程 ──
type JobRow = { id: string; user_id: string; trigger_key: string; kind: string; payload: EncryptedPayload };
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };
type JobPayload = {
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  shortcut?: {
    commandId: string;
    actionName: string;
    resultMode: "none" | "text" | "image";
    resultMarker: string;
    imageMarker?: string;
    style: "text" | "native";
  };
  notify?: { title?: string; url?: string; characterId?: string };
  /** 角色绑定的微信 bot：force 用于真实微信快捷动作结果续跑，保证第二轮仍回到微信。 */
  weixin?: { botId?: string; force?: boolean };
  /** 离线快捷动作的结果续跑快照：客户端预挂，AI 调用需回传的动作时武装 shortcut_resume */
  shortcutContinuation?: {
    request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
    replyMarker: string;
    resultMarker: string;
    imageMarker?: string;
    /** 角色 API 的图像识别开关（客户端挂快照时写入）；缺省视为开，兼容老快照 */
    visionEnabled?: boolean;
  };
  merge?: Record<string, unknown> & { sessionId?: string };
};

type ShortcutCommandRow = {
  id: string;
  status: "pending" | "claimed" | "succeeded" | "failed" | "expired" | "cancelled";
  action_name: string;
  result_mode: "none" | "text" | "image";
  result: Record<string, unknown> | null;
  error: string | null;
  expires_at: string;
};

// 【快捷动作：名称】与带参数的【快捷动作：名称({...})】都要认。参数允许换行
// （模型爱把 JSON 展开写），所以参数段用 [\s\S] 而不是 [^\n]。
/** 识图关着时代替截图进上下文的说明：不留这句话，模型面对的是空白，
 *  既不知道图回没回来，也不知道自己为什么看不见。 */
const SHORTCUT_VISION_OFF_NOTE = "（系统记录：未配置或未启用图像识别，本轮回传的图片没有交给你；请结合上一条的文字内容回应。）";

const SHORTCUT_MARKER_RE = /【快捷动作[：:]\s*([^(（）)】\n]{1,60}?)\s*(?:[(（]([\s\S]{0,2000}?)[)）])?\s*】/;
const SHORTCUT_MARKER_STRIP_RE = new RegExp(SHORTCUT_MARKER_RE.source, "g");

/** 标记括号里的 JSON 参数。写坏了就当没带参数——宁可少传，也不要整条动作失败。 */
function parseShortcutMarkerArgs(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  // 模型爱用全角标点（中文引号/冒号/逗号），原文解析失败就按归一化后的再试一次
  const candidates = [text, text.replace(/[\u201c\u201d\u201e\u201f]/g, '"').replace(/\uff1a/g, ":").replace(/\uff0c/g, ",")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try next */ }
  }
  console.warn(`[push-generate] 快捷动作参数解析失败 raw=${text.slice(0, 200)}`);
  return {};
}

function shortcutResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.message ?? record.value;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ""); }
}

function formatShortcutResult(command: ShortcutCommandRow, style: "text" | "native"): string {
  const actionName = String(command.action_name || "快捷动作").replace(/"/g, "&quot;");
  const success = command.status === "succeeded";
  const detail = success
    ? shortcutResultText(command.result) || "快捷指令已执行成功。"
    : command.error || (command.status === "expired" ? "等待手机执行超时。" : `命令状态：${command.status}`);
  if (style === "native") {
    return [
      `<action_result name="${actionName}" success="${success ? "true" : "false"}">`,
      detail,
      "</action_result>",
      "工具结果已经返回给你，不要重复你之前已经说过的内容，不要再次执行相同的动作。",
    ].join("\n");
  }
  const resultTag = success
    ? `<action_result name="${actionName}">${detail}</action_result>`
    : `<action_result name="${actionName}" error="${detail.replace(/"/g, "&quot;")}"></action_result>`;
  return `以下是系统处理结果：\n${resultTag}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}

function replaceMarker(value: unknown, marker: string, replacement: string): boolean {
  if (!value || typeof value !== "object") return false;
  let replaced = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === marker) {
        value[index] = replacement;
        replaced = true;
      } else if (replaceMarker(value[index], marker, replacement)) {
        replaced = true;
      }
    }
    return replaced;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (item === marker) {
      record[key] = replacement;
      replaced = true;
    } else if (replaceMarker(item, marker, replacement)) {
      replaced = true;
    }
  }
  return replaced;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(raw);
}

/** 与网关 encryptPayload 同格式：武装续跑任务时给快照加密落库。 */
async function encryptJobPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(combined.slice(combined.length - 16)),
    ct: bytesToBase64(combined.slice(0, combined.length - 16)),
  };
}

function injectShortcutImage(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  marker: string,
  image: { mimeType: string; base64: string } | null,
): void {
  const text = image ? "系统记录：这是快捷指令刚刚回传的截图。" : "系统记录：快捷指令截图读取失败。";
  if (providerKind === "anthropic") {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const content = (message as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const index = content.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      content.splice(index, 1,
        { type: "text", text },
        ...(image ? [{ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else if (providerKind === "gemini") {
    for (const message of Array.isArray(body.contents) ? body.contents : []) {
      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) continue;
      const index = parts.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      parts.splice(index, 1,
        { text },
        ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const record = message as { content?: unknown };
      if (record.content !== marker) continue;
      record.content = image ? [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } },
      ] : text;
      return;
    }
  }
  replaceMarker(body, marker, text);
}

/** 在冻结请求的消息列表末尾追加一条 user 角色的系统备忘（按 provider 格式）。 */
type RecheckPlanRow = {
  plan_date: string;
  context?: Record<string, unknown>;
  decisions?: unknown[];
  items?: { time?: string; wakeId?: string }[];
};

/** 挂念寄存的计划：靠 trigger_key 里的 wakeId 回查。取两天：跨零点触发时最新的那份可能已经是明天的计划。 */
async function loadRecheckPlan(
  rest: (path: string, init?: RequestInit) => Promise<Response>,
  userId: string,
  characterId: string,
  wakeId: string,
): Promise<{ row: RecheckPlanRow | null; item: { time?: string; wakeId?: string } | null }> {
  if (!characterId || !wakeId) return { row: null, item: null };
  const response = await rest(
    `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + `&character_id=eq.${encodeURIComponent(characterId)}`
    + "&select=plan_date,context,decisions,items&order=plan_date.desc&limit=2",
  );
  const rows = response.ok ? await response.json() as RecheckPlanRow[] : [];
  for (const row of rows) {
    const hit = (row.items || []).find(item => item.wakeId === wakeId);
    if (hit) return { row, item: hit };
  }
  return { row: rows[0] || null, item: null };
}

// ── 挂念：TA此刻的状态。预约里冻着的是编排那会儿的样子，到点了按寄存的日程和「情况」
// 重算一遍。算法与挂念 index.html 的 energyAt / moodNow / currentStep 一致，改一处要同步另一处。
type GuanianSched = { time?: string; end?: string; title?: string; place?: string; cost?: number; mood?: string; busy?: boolean; steps?: { time?: string; what?: string }[] };
type GuanianCond = { startAt?: number; halfLifeMin?: number; intensity?: number; energyDelta?: number; mood?: string; cause?: string };
type GuanianDay = {
  tz?: number; mood?: string; energy?: number; location?: string; doing?: string;
  wake?: string; bed?: string; schedule?: GuanianSched[]; conds?: GuanianCond[];
};
// 睡眠窗：bed 起到 wake 止，允许过零点；老版本 App 没寄 wake/bed 时退回免打扰时段。与 App 端 asleepAt 同步。
function guanianAsleep(day: GuanianDay, hm: string, quietStart?: string, quietEnd?: string): boolean {
  const bed = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wake = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  if (!bed || !wake || bed === wake) return false;
  return bed < wake ? (hm >= bed && hm < wake) : (hm >= bed || hm < wake);
}

// 忙与睡：TA此刻正做着顾不上看手机的事，返回那件事的结束时刻；否则空串。
// 新日程由生成时模型标 busy；老日程按标题猜（词表来自陪伴插件的 busy_reply_gate）。
const GUANIAN_BUSY_RE = /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/;
const GUANIAN_NOT_BUSY_RE = /睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/;
function guanianBusyUntil(day: GuanianDay, hm: string): string {
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  let cur: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) cur = it;
  if (!cur) return "";
  const end = typeof cur.end === "string" && cur.end > String(cur.time) ? cur.end : "";
  if (!end || hm >= end) return "";
  const title = String(cur.title || "");
  const busy = cur.busy === true || (GUANIAN_BUSY_RE.test(title) && !GUANIAN_NOT_BUSY_RE.test(title));
  return busy ? end : "";
}
// 本地 HH:MM → 下一次到达它的 UTC 毫秒（已过就算明天的）
function guanianLocalHMToMs(hm: string, tzMin: number, nowMs: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return 0;
  const local = new Date(nowMs + tzMin * 60_000);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(m[1]), Number(m[2])) - tzMin * 60_000;
  if (t <= nowMs) t += 86_400_000;
  return t;
}
function guanianRoll(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 100;
}

type GuanianAffection = { score?: number; tier?: string; relation?: string } | null | undefined;
function guanianStateNote(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string, affection?: GuanianAffection): string {
  const tz = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
  const local = new Date(nowMs + tz * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const nowHM = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");

  const condWeight = (c: GuanianCond) => {
    const half = Math.max(10, Number(c.halfLifeMin) || 180) * 60_000;
    return Math.pow(0.5, Math.max(0, nowMs - (Number(c.startAt) || 0)) / half);
  };
  const conds = (Array.isArray(day.conds) ? day.conds : [])
    .map(c => ({ c, w: condWeight(c) }))
    .filter(x => x.w > 0.08 && (Number(x.c.startAt) || 0) <= nowMs)
    .sort((a, b) => (b.w * (Number(b.c.intensity) || 50)) - (a.w * (Number(a.c.intensity) || 50)));

  let done: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= nowHM) done = it;
  const next = sched.find(it => String(it.time) > nowHM) || null;
  const asleep = guanianAsleep(day, nowHM, quietStart, quietEnd);
  // 与 App 端 phaseAt / currentDoing 同步（过零点还没睡的那段也是睡前）
  const bedHM = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  const lateNight = !done && !!bedHM && !!wakeHM && bedHM < wakeHM && nowHM < bedHM;
  const over = lateNight || !!(done && done.end && done.end > String(done.time) && nowHM >= done.end);
  const doing = lateNight ? "睡前自己待着，准备睡了"
    : !done ? (day.doing || "起床后的时间")
    : !over ? String(done.title || "")
    : next ? `歇着（刚忙完${done.title || ""}）` : "睡前自己待着，准备睡了";
  let step = "";
  if (done && !over && !asleep && Array.isArray(done.steps)) {
    for (const x of done.steps) if (x && typeof x.time === "string" && x.time <= nowHM) step = String(x.what || "");
  }
  // 与 App 端 currentPlace 同步：地点跟着最后一件已开始的日程走，第一件没开始才用早上的
  const place = String((done && done.place) || day.location || "");

  const hh = h < 5 ? h + 24 : h;
  let energy = Number.isFinite(Number(day.energy)) ? Number(day.energy) : 60;
  const hmNum = (v: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  };
  // 与面板 energyAt 同步：cost 按进度记账、状况负向合计封顶 -25、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > nowHM) continue;
    const a = hmNum(it.time), b = hmNum(it.end);
    const prog = a != null && b != null && b > a ? Math.max(0, Math.min(1, (h - a) / (b - a))) : 1;
    energy += (Number(it.cost) || 0) * prog;
  }
  let cd = 0;
  for (const x of conds) cd += (Number(x.c.energyDelta) || 0) * x.w;
  energy += Math.max(-25, cd);
  const wakeH = hmNum(day.wake) ?? 7;
  energy -= Math.max(0, Math.min(hh, 22) - wakeH) * 1.2 + Math.max(0, hh - 22) * 8;
  energy = Math.max(0, Math.min(100, Math.round(energy)));

  const cand: { text: string; from: string; w: number }[] = [];
  const top = conds[0];
  if (top && top.c.mood) cand.push({ text: String(top.c.mood), from: String(top.c.cause || "刚才聊的"), w: top.w * (Number(top.c.intensity) || 50) / 100 });
  if (done && done.mood) {
    const [dh, dm] = String(done.time).split(":").map(Number);
    const agoMs = Math.max(0, (h * 60 - (dh * 60 + dm)) * 60_000);
    cand.push({ text: String(done.mood), from: String(done.title || ""), w: Math.pow(0.5, agoMs / (90 * 60_000)) * 0.6 });
  }
  cand.sort((a, b) => b.w - a.w);
  const hit = cand.find(x => x.text && x.w > 0.15);
  const base = String(day.mood || "");
  const moodLine = hit
    ? `${hit.text}（因为${hit.from || "刚才那阵"}；今天的底色是「${base || "平常"}」）`
    : `${base || "说不上来"}（今天一整天的底色）`;

  const lines = [
    `[系统备忘：这不是对方发来的消息。这是你此刻（本地时间 ${nowHM}）的状态，提示词里若有更早的「挂念 · 某某时刻的状态」以这份为准：`,
    asleep
      ? `在睡觉${day.wake ? "（" + day.wake + " 左右才醒）" : ""}：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。`
      : `在做的事：${doing || "没什么特别的"}${step ? "，具体是在" + step : ""}${place ? "；人在" + place : ""}`,
    `情绪：${moodLine}`,
    `精力：${energy}%${energy < 25 ? "——很累了，话短、反应慢、容易敷衍" : energy < 50 ? "——有点乏" : energy < 80 ? "——还行" : "——精神很好"}`,
  ];
  if (asleep) { if (day.wake) lines.push(`接下来：${day.wake} 起床`); }
  else if (next) lines.push(`接下来：${next.time} ${next.title || ""}`);
  else if (over && day.bed) lines.push(`接下来：${day.bed} 睡觉`);
  if (affection && (affection.tier || affection.relation)) {
    lines.push(`对TA：${affection.tier || "说不上"}；两人现在的关系：${affection.relation || "没定"}。说话的分寸按这个来。`);
  }
  lines.push("这些是你自己的状态，说话时自然带出来就行，别报数字、别列清单、别提这段文字。]");
  return lines.join("\n");
}

function appendUserNote(body: Record<string, unknown>, providerKind: ProviderKind, note: string): boolean {
  if (providerKind === "gemini") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return false;
    contents.push({ role: "user", parts: [{ text: note }] });
    return true;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  if (providerKind === "anthropic") {
    messages.push({ role: "user", content: [{ type: "text", text: note }] });
  } else {
    messages.push({ role: "user", content: note });
  }
  return true;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DAILY_GENERATION_CAP = 50;

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { jobId, token } = await req.json().catch(() => ({})) as { jobId?: string; token?: string };
  if (!jobId || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key,site_origin&limit=1");
  const secretRows = secretResponse.ok ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null; site_origin?: string | null }[] : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  const siteOrigin = secretRows[0]?.site_origin || "";
  if (!cronSecret || String(token) !== cronSecret) {
    return new Response("forbidden", { status: 403 });
  }

  const claim = await rest(`push_jobs?id=eq.${encodeURIComponent(jobId)}&status=eq.pending&kind=neq.bridge_scan`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }),
  });
  const claimed = claim.ok ? await claim.json() as JobRow[] : [];
  const job = claimed[0];
  if (!job) return new Response("already claimed", { status: 200 });

  const finish = (status: "done" | "failed", note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, result_note: note.slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => undefined);

  // 分段进度：卡死时 result_note 会停在最后完成的一步，精确定位死点
  const startedAt = Date.now();
  const progress = (note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ result_note: `[${Math.round((Date.now() - startedAt) / 1000)}s] ${note}`.slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => undefined);

  // pg_net 的请求超时只有几秒：必须立即响应，重活放进 waitUntil 后台继续。
  const runJob = async (): Promise<void> => {
  try {
    if (!payloadKey) {
      await finish("failed", "payload_key missing (open push settings once to bootstrap)");
      return;
    }
    const payload = JSON.parse(await decryptPayload(job.payload, payloadKey)) as JobPayload;
    let shortcutStoragePath = "";

    // 模板预约（push.freeze）只是给云函数借提示词用的，到点即作废，永远不生成。
    if (job.kind === "template") {
      await finish("done", "template expired");
      return;
    }

    if (job.kind === "shortcut_resume" && payload.shortcut) {
      const commandResponse = await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(payload.shortcut.commandId)}`
        + `&user_id=eq.${encodeURIComponent(job.user_id)}`
        + "&select=id,status,action_name,result_mode,result,error,expires_at&limit=1",
      );
      const commandRows = commandResponse.ok ? await commandResponse.json() as ShortcutCommandRow[] : [];
      const command = commandRows[0];
      if (!command) {
        await finish("failed", "shortcut command missing");
        return;
      }

      if (command.status === "pending" || command.status === "claimed") {
        const expiresAt = Date.parse(command.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          const retryAt = new Date(Math.min(expiresAt + 5_000, Date.now() + 15_000)).toISOString();
          await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "pending",
              execute_at: retryAt,
              result_note: "waiting for shortcut result",
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        command.status = "expired";
        command.error = "等待手机执行超时。";
        await rest(`push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}&status=in.(pending,claimed)`, {
          method: "PATCH",
          body: JSON.stringify({ status: "expired", error: command.error, updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      }

      const resultContent = formatShortcutResult(command, payload.shortcut.style);
      if (!replaceMarker(payload.request.body, payload.shortcut.resultMarker, resultContent)) {
        await finish("failed", "shortcut result marker missing");
        return;
      }

      if (payload.shortcut.imageMarker) {
        let image: { mimeType: string; base64: string } | null = null;
        const result = command.result && typeof command.result === "object" ? command.result : {};
        const rawPath = typeof result.storagePath === "string" ? result.storagePath : "";
        const expectedPrefix = `${job.user_id}/${command.id}.`;
        if (command.status === "succeeded" && rawPath.startsWith(expectedPrefix) && /\.(?:jpg|png|webp)$/.test(rawPath)) {
          const storagePath = rawPath.split("/").map(encodeURIComponent).join("/");
          const file = await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${storagePath}`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          });
          if (file.ok) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length > 0 && bytes.length <= 8 * 1024 * 1024) {
              image = {
                mimeType: file.headers.get("content-type") || String(result.mimeType || "image/jpeg"),
                base64: bytesToBase64(bytes),
              };
              shortcutStoragePath = storagePath;
            }
          }
        }
        injectShortcutImage(payload.request.body, payload.request.providerKind, payload.shortcut.imageMarker, image);
      }
    }

    const subsResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(job.user_id)}&select=endpoint,p256dh,auth`);
    const subs = subsResponse.ok ? await subsResponse.json() as SubscriptionRow[] : [];
    if (subs.length === 0 && payload.weixin?.force !== true) {
      await finish("done", "no_subscription");
      return;
    }

    // 硬闸：每账号每天最多 50 条服务端兜底生成，超出只存任务记录不烧 token。
    // 只统计 push-generate 真正生成的回箱行，不让现实桥的纯存档行占用额度。
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const capResponse = await rest(
      `push_outbox?user_id=eq.${encodeURIComponent(job.user_id)}&created_at=gte.${encodeURIComponent(dayStart)}&meta->>pushGenerated=eq.true&select=id&limit=${DAILY_GENERATION_CAP + 1}`,
    );
    const todayRows = capResponse.ok ? await capResponse.json() as unknown[] : [];
    if (todayRows.length >= DAILY_GENERATION_CAP) {
      await finish("done", `daily cap (${DAILY_GENERATION_CAP}) reached`);
      return;
    }

    // ── 到点补上下文：快照是预约时冻结的，但预约之后本服务可能已经替角色主动
    // 发过消息（同一天多个定时唤醒 / 冷场连发）。这些消息全在 push_outbox 里——
    // 把「你已经发过这些、对方还没回」补进冻结请求，角色才不会失忆重复自己。
    // 只对主动类任务生效；reply_bailout 租约仅 90 秒无此问题，shortcut_resume
    // 的续跑快照已代入首条回复，再补会双重提及。老快照没有 snapshotAt 则跳过。
    if (job.kind === "timed_task" || job.kind === "followup") {
      const contextSessionId = typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
      const snapshotAt = typeof payload.merge?.snapshotAt === "string" ? payload.merge.snapshotAt : "";
      if (contextSessionId && snapshotAt && Number.isFinite(Date.parse(snapshotAt))) {
        try {
          const sinceResponse = await rest(
            `push_outbox?user_id=eq.${encodeURIComponent(job.user_id)}`
            + `&session_id=eq.${encodeURIComponent(contextSessionId)}`
            + "&meta->>pushGenerated=eq.true"
            + `&created_at=gt.${encodeURIComponent(new Date(Date.parse(snapshotAt)).toISOString())}`
            + "&select=raw_text,created_at&order=created_at.asc&limit=5",
          );
          const sinceRows = sinceResponse.ok
            ? await sinceResponse.json() as { raw_text: string; created_at: string }[]
            : [];
          if (sinceRows.length > 0) {
            const lines = sinceRows.map((row, index) => {
              const minutesAgo = Math.max(1, Math.round((Date.now() - Date.parse(row.created_at)) / 60000));
              const text = String(row.raw_text || "").replace(/\s+/g, " ").trim().slice(0, 400);
              return `${index + 1}.（约${minutesAgo}分钟前）${text}`;
            });
            const note = "[系统备忘：这不是对方发来的消息。在上面的对话之后，你已经又主动给对方发过下面这些消息，对方还没有回复：\n"
              + lines.join("\n")
              + "\n请自然衔接你已经说过的话——不要重复以上内容，不要把它们当成对方说的，也不要机械追问对方为什么不回。]";
            if (appendUserNote(payload.request.body, payload.request.providerKind, note)) {
              await progress(`context patched: +${sinceRows.length} sent since snapshot`);
            }
          }
        } catch { /* 补上下文失败不阻塞生成，按原快照重放 */ }
      }
    }

    // ── 发送前复核：到点了再综合判一次「这条现在发合不合适」。三个信号全部只读已有
    // 数据、不调模型：未回应轮数、你是不是正聊着、离TA上一条主动多久。加权成「不合时宜度」，
    // 过阈值就取消这次生成。判据写回挂念的计划，面板点开那条时刻就能展开看。
    // 阈值来自挂念上传的 push_recheck_plans.context.presend*；匹配不到挂念的计划
    // （不是它挂的预约）就只跑老的未回应硬规则。镜像没开（查不到会话记录）则一道都不拦。
    // 轮数口径与挂念本地一致：用户最后一条之后角色的连续主动按「轮」算（相邻 3 分钟归一轮），
    // 最新一轮要晾满 30 分钟才计数。数据源是聊天镜像 + 离线期间本服务代发的 push_outbox。
    const guanianCharacterId = job.kind === "timed_task" ? (payload.notify?.characterId || "") : "";
    const guanianWakeId = job.kind === "timed_task" && job.trigger_key.startsWith("timedwake:") ? job.trigger_key.slice(10) : "";
    const guanianPlan = await loadRecheckPlan(rest, job.user_id, guanianCharacterId, guanianWakeId)
      .catch(() => ({ row: null, item: null }));
    if (job.kind === "timed_task") {
      const cooldownRounds = Number(payload.merge?.cooldownRounds);
      const coolTarget = Number.isFinite(cooldownRounds) && cooldownRounds > 0 ? cooldownRounds : 0;
      const mirrorSessionId = typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
      if (mirrorSessionId) {
        try {
          const mirrorResponse = await rest(
            `push_chat_mirror?user_id=eq.${encodeURIComponent(job.user_id)}`
            + `&session_id=eq.${encodeURIComponent(mirrorSessionId)}`
            + "&select=role,message_at&order=message_at.desc&limit=40",
          );
          const mirrorRows = mirrorResponse.ok
            ? await mirrorResponse.json() as { role: string; message_at: string }[]
            : [];
          if (mirrorRows.length > 0) {
            const nowMs = Date.now();
            const graceMs = 30 * 60_000;
            let rounds = 0;
            let prevT: number | null = null;
            for (const row of mirrorRows) {
              if (row.role !== "assistant") break;
              const t = Date.parse(row.message_at);
              if (!Number.isFinite(t)) break;
              if (prevT === null || prevT - t > 3 * 60_000) {
                if (nowMs - t >= graceMs) rounds += 1;
              }
              prevT = t;
            }
            // TA最后一条主动：镜像里最新的 assistant，和离线期间代发还没被取走的 outbox，取更晚的那个
            let lastProactiveAt = 0;
            const newestAssistant = mirrorRows.find(row => row.role === "assistant");
            if (newestAssistant) {
              const t = Date.parse(newestAssistant.message_at);
              if (Number.isFinite(t)) lastProactiveAt = t;
            }
            const newestMirrorAt = Date.parse(mirrorRows[0].message_at);
            if (Number.isFinite(newestMirrorAt)) {
              const outboxResponse = await rest(
                `push_outbox?user_id=eq.${encodeURIComponent(job.user_id)}`
                + `&session_id=eq.${encodeURIComponent(mirrorSessionId)}`
                + "&meta->>pushGenerated=eq.true"
                + `&created_at=gt.${encodeURIComponent(new Date(newestMirrorAt).toISOString())}`
                + "&select=created_at&order=created_at.desc&limit=10",
              );
              const outboxRows = outboxResponse.ok
                ? await outboxResponse.json() as { created_at: string }[]
                : [];
              for (const row of outboxRows) {
                const t = Date.parse(row.created_at);
                if (!Number.isFinite(t)) continue;
                if (nowMs - t >= graceMs) rounds += 1;
                if (t > lastProactiveAt) lastProactiveAt = t;
              }
            }
            const newestUser = mirrorRows.find(row => row.role === "user");
            const lastUserAt = newestUser ? Date.parse(newestUser.message_at) : NaN;

            // 挂念的这条时刻：顺带拿到用户调的阈值
            const planRow = guanianPlan.row;
            const planItem = guanianPlan.item;
            const planContext = planRow?.context || {};
            const cfg = (key: string, def: number): number => {
              const value = Number(planContext[key]);
              return Number.isFinite(value) && value >= 0 ? value : def;
            };
            // 落在窗口内就按剩余比例给压力：刚说完话是 100，窗口边缘是 0
            const closeness = (elapsedMs: number, windowMin: number): number => {
              const span = windowMin * 60_000;
              if (!(span > 0) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= span) return 0;
              return Math.round((1 - elapsedMs / span) * 100);
            };
            const pr = coolTarget > 0 ? Math.min(100, Math.round(rounds / coolTarget * 100)) : 0;
            const pt = Number.isFinite(lastUserAt) ? closeness(nowMs - lastUserAt, cfg("presendTalkingMin", 15)) : 0;
            const pg = lastProactiveAt ? closeness(nowMs - lastProactiveAt, cfg("presendGapMin", 60)) : 0;
            const press = Math.round(pr * 0.4 + pt * 0.4 + pg * 0.2);
            const maxPress = cfg("presendMax", 70);
            const hardSkip = coolTarget > 0 && rounds >= coolTarget;
            const blocked = hardSkip
              ? `连续 ${rounds} 轮没等到你回`
              : (planItem && press >= maxPress ? `此刻不合时宜（${press}%）` : "");

            // 判据写回计划：不管发没发都写，面板要能看到"通过"的那次是几分过的
            if (planRow && planItem) {
              const prior = Array.isArray(planRow.decisions) ? planRow.decisions : [];
              await rest(
                `push_recheck_plans?user_id=eq.${encodeURIComponent(job.user_id)}`
                + `&character_id=eq.${encodeURIComponent(guanianCharacterId)}`
                + `&plan_date=eq.${encodeURIComponent(planRow.plan_date)}`,
                {
                  method: "PATCH",
                  headers: { Prefer: "return=minimal" },
                  body: JSON.stringify({
                    decisions: [...prior, {
                      at: nowMs,
                      kind: "presend",
                      time: planItem.time || "",
                      by: "cloud",
                      note: blocked || `到点复核通过（不合时宜度 ${press}%）`,
                      blocked: !!blocked,
                      scores: { pr, pt, pg, press, rounds, max: maxPress },
                    }].slice(-60),
                  }),
                },
              ).catch(() => undefined);
            }

            if (blocked) {
              await finish("done", `presend skip: ${blocked} (press ${press}%, rounds ${rounds})`);
              return;
            }
          }
        } catch { /* 复核查询失败不阻塞生成，按原计划发 */ }
      }
    }

    // ── 挂念：到点了把TA此刻的状态补进请求。只对挂念挂的预约（计划里查得到 wakeId）生效，
    // 计划里没寄 day 的老版本 App 照旧。
    // 挂念的哨兵预约只是给云端复核当凭据模板的，到点不生成。真到了这一步说明挂念两天没编排过，
    // 计划早已过了 cron 的派发窗口，作废就好。
    if (guanianWakeId && guanianPlan.row?.context?.sentinelWakeId === guanianWakeId) {
      await finish("done", "guanian sentinel");
      return;
    }
    if (guanianPlan.item && guanianPlan.row?.context?.day && typeof guanianPlan.row.context.day === "object") {
      // 编排时排开了睡眠窗，但聊天改日程或别的路径挂上的时刻可能落在TA睡着之后：睡着的人不发消息。
      const ctxQuiet = guanianPlan.row.context as { quietStart?: unknown; quietEnd?: unknown };
      const qs = typeof ctxQuiet.quietStart === "string" ? ctxQuiet.quietStart : undefined;
      const qe = typeof ctxQuiet.quietEnd === "string" ? ctxQuiet.quietEnd : undefined;
      const day = guanianPlan.row.context.day as GuanianDay;
      const tzMin = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
      const localNow = new Date(Date.now() + tzMin * 60_000);
      const localHM = `${String(localNow.getUTCHours()).padStart(2, "0")}:${String(localNow.getUTCMinutes()).padStart(2, "0")}`;
      const ctx = guanianPlan.row.context as Record<string, unknown>;
      const cnum = (key: string, def: number): number => {
        const v = Number(ctx[key]);
        return Number.isFinite(v) && v >= 0 ? v : def;
      };
      const nowMs = Date.now();
      const origFireAt = Number((guanianPlan.item as { fireAt?: unknown }).fireAt) || nowMs;
      const maxHoldMs = cnum("busyMaxHoldMin", 180) * 60_000;
      // 忙完 / 醒来再等多久不取整：按设定值上下浮动四成，种子用任务 id，同一条重判不会漂
      const bufferMs = cnum("busyBufferMin", 10) * 60_000 * (0.6 + guanianRoll(job.id + ":buffer") / 100 * 0.8);
      // 押后 = 这条任务改回 pending、到点时刻往后挪；判据记进计划，面板能看到「押后到几点」
      const hold = async (untilMs: number, note: string): Promise<void> => {
        const prior = Array.isArray(guanianPlan.row?.decisions) ? guanianPlan.row!.decisions : [];
        await rest(
          `push_recheck_plans?user_id=eq.${encodeURIComponent(job.user_id)}`
          + `&character_id=eq.${encodeURIComponent(guanianCharacterId)}`
          + `&plan_date=eq.${encodeURIComponent(guanianPlan.row!.plan_date)}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              decisions: [...prior, { at: nowMs, kind: "hold", time: guanianPlan.item?.time || "", by: "cloud", note, until: untilMs, blocked: false }].slice(-60),
            }),
          },
        ).catch(() => undefined);
        await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "pending", execute_at: new Date(untilMs).toISOString(), result_note: `hold: ${note}`.slice(0, 300), updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      };
      let sleepy = false;
      if (guanianAsleep(day, localHM, qs, qe)) {
        const mode = cnum("sleepMode", 0);
        if (mode === 1) {
          const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(qe || "");
          const untilMs = guanianLocalHMToMs(wakeHM, tzMin, nowMs) + bufferMs;
          if (untilMs > nowMs && untilMs - origFireAt <= maxHoldMs) {
            await hold(untilMs, `TA睡着了，押到起床后（${wakeHM}）再发`);
          } else {
            await finish("done", "guanian asleep, hold would exceed max");
          }
          return;
        }
        if (mode === 2) {
          const roll = guanianRoll(job.id), prob = cnum("sleepWakeProb", 18);
          if (roll >= prob) {
            await finish("done", `guanian asleep (roll ${roll} >= ${prob})`);
            return;
          }
          sleepy = true;
        } else {
          await finish("done", "guanian asleep");
          return;
        }
      }
      if (!sleepy && cnum("busyHold", 0) > 0) {
        const busyEnd = guanianBusyUntil(day, localHM);
        if (busyEnd) {
          const untilMs = guanianLocalHMToMs(busyEnd, tzMin, nowMs) + bufferMs;
          if (untilMs - origFireAt <= maxHoldMs) {
            await hold(untilMs, `TA正忙着顾不上，押到 ${busyEnd} 之后再发`);
          } else {
            await finish("done", `guanian busy until ${busyEnd}, hold would exceed max`);
          }
          return;
        }
      }
      try {
        const aff = ctx.affection && typeof ctx.affection === "object" ? ctx.affection as GuanianAffection : null;
        let note = guanianStateNote(day, nowMs, qs, qe, aff);
        if (sleepy) note += "\n（TA本来睡着了，半夜迷迷糊糊醒了一下想起你：只说一两句、带着困意、说完就要接着睡。）";
        if (appendUserNote(payload.request.body, payload.request.providerKind, note)) {
          await progress("context patched: guanian state" + (sleepy ? " (sleepy)" : ""));
        }
      } catch { /* 状态算不出来就按冻结快照发 */ }
    }

    // 挂念挂的时刻受「一天最多调多少次模型」约束；聊天兜底之类不是挂念的不拦，只记账
    const usageSource = guanianPlan.item ? "cloud-wake" : "cloud-chat";
    const budget = await usageBudget(rest, job.user_id).catch(() => null);
    if (guanianPlan.item && budget) {
      const over = usageExceeded(budget);
      if (over) {
        await finish("done", `usage cap: ${over}`);
        return;
      }
    }
    await progress("llm request started");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    let llmResponse: Response;
    try {
      llmResponse = await fetch(payload.request.url, {
        method: "POST",
        headers: payload.request.headers,
        body: JSON.stringify(payload.request.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => "");
      await finish("failed", `api ${llmResponse.status}: ${errorText.slice(0, 200)}`);
      return;
    }
    const data = await llmResponse.json();
    await usageAdd(rest, job.user_id, budget?.tz ?? 0, usageSource, payload.request.providerKind, data);
    let rawText = extractResponseText(payload.request.providerKind, data).trim();
    if (!rawText) {
      await finish("failed", "empty response");
      return;
    }

    // ── 离线来电：复用小手机既有的通话协议，并兼容已经预约的旧任务 ──
    // 仅在回复开头 200 字内识别严格的「我（向某人）发起了语音通话」标签，
    // 普通叙述中的“某人发起了通话”不会误触发。标签从正文剥离，不进聊天记录。
    const callMarkers = [
      /\[我向[^\]\r\n]{1,80}发起了语音通话\]/,
      /【我向[^】\r\n]{1,80}发起了语音通话】/,
      /\[我发起了语音通话\]/,
      /【我发起了语音通话】/,
      /【拨打电话】/,
    ];
    let deliverAsCall = false;
    {
      const head = rawText.slice(0, 200);
      const matched = callMarkers
        .map(pattern => {
          const match = pattern.exec(head);
          return match ? { marker: match[0], index: match.index } : null;
        })
        .filter((item): item is { marker: string; index: number } => item !== null)
        .sort((a, b) => a.index - b.index)[0];
      if (matched) {
        deliverAsCall = true;
        rawText = (rawText.slice(0, matched.index) + rawText.slice(matched.index + matched.marker.length)).trim();
        if (!rawText) rawText = "……";
      }
    }

    // ── 离线快捷动作：AI 输出【快捷动作：名称】则经本项目网关创建命令并推送运行通知 ──
    // 动作目录在 push_bridge_config.shortcut_actions（个人云由客户端同步；
    // 老库/站点库无此列时查询失败即视为无目录，不执行）。标记一律从正文剥离。
    let shortcutActionNote = "";
    // 实际执行过的快捷动作标记（原文+在剥离后正文中的位置）：随 outbox 带回
    // 小手机，在原始位置落一对 tool_call/tool_notice——上下文里是标记原文，
    // 角色下一轮才知道自己传过什么参数（否则「换一首歌」会换出同一首）
    let executedShortcutMarker: { text: string; insertAt: number; name: string } | null = null;
    let deferredShortcutCommandId = "";
    let deferredShortcutActionName = "";
    type DeferredShortcutEmail = {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    };
    let deferredShortcutEmail: DeferredShortcutEmail | null = null;
    // 送达失败要让用户看得见：shortcutActionNote 只进任务日志（result_note），
    // 而角色已经说了"我去看一眼"。把失败摘要挂进 outbox meta 带回客户端，
    // 由客户端写进现实桥动态。成功则保持空串，不打扰。
    let shortcutDeliveryError = "";
    const noteShortcutDelivery = (actionName: string, note: string): string => {
      // 按「成功」反向判断，别去枚举失败关键词——投递路径的文案有中有英，
      // 加一句新的失败文案就会从关键词表里漏出去，静默丢掉本该给用户的提示。
      // 这里只在真正投递出去时收到含 delivered 的 note。
      if (!/delivered/.test(note)) {
        shortcutDeliveryError = `快捷动作「${actionName}」未能送达：${note.replace(/^, /, "")}`.slice(0, 300);
      }
      return note;
    };
    /**
     * 邮件模式的触发信请站点代发。个人云自己发不了信——RESEND_API_KEY 和
     * REALITY_BRIDGE_EMAIL_FROM 是站点的环境变量，用户的 Supabase 边缘函数里
     * 没有也不该有。命令行、结果回传、续跑快照全部留在本项目，站点只发那封信。
     * 失败一律只回一句 note：邮件没发出去不该让整个生成任务失败。
     */
    const deliverShortcutEmailViaSite = async (input: {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    }): Promise<string> => {
      if (!siteOrigin) return ", shortcut email skipped: site origin unknown";
      if (!input.commandId || !input.resultUrl) return ", shortcut email skipped: command incomplete";
      try {
        const tokenResponse = await rest(
          `push_bridge_config?user_id=eq.${encodeURIComponent(input.userId)}&select=site_bridge_token&limit=1`,
        );
        const tokenRows = tokenResponse.ok
          ? await tokenResponse.json() as { site_bridge_token?: string | null }[]
          : [];
        const siteBridgeToken = String(tokenRows[0]?.site_bridge_token || "");
        // 令牌没同步上来，绝大多数是个人云还没跑过新版 schema（site_bridge_token
        // 是后加的列）。这句会经 outbox meta 显示给用户，所以要写成可操作的。
        if (!siteBridgeToken) {
          return ", 站点代发未启用：请到「设置 → 云服务部署」重新部署个人云";
        }

        const response = await fetch(`${siteOrigin}/api/push/shortcut-commands/deliver-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: siteBridgeToken,
            actionId: input.actionId,
            actionName: input.actionName,
            commandId: input.commandId,
            resultUrl: input.resultUrl,
            arguments: input.args,
          }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
        return response.ok && data.ok === true
          ? ", shortcut email delivered by site"
          : `, shortcut email failed: ${String(data.error || response.status).slice(0, 80)}`;
      } catch (error) {
        return `, shortcut email failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`;
      }
    };
    /**
     * 快捷动作投递失败时单独落一条诊断行，而不是往角色那条消息的 meta 上补写。
     *
     * 补写会输给一个竞态：消息行落库并推送之后，用户点开通知，客户端可能在服务端
     * PATCH 之前就把那行读走并 ACK 掉——恰好在"投递失败 + 用户立刻点通知"这种
     * 情况下丢掉错误。诊断行是在投递之后才创建的，不存在赶不上的问题。
     *
     * trigger_key 必须留空：客户端按 trigger_key 去重，跟消息行同键会被当成重复
     * 直接消费掉，根本走不到写动态那段。raw_text 只是占位（列是 NOT NULL），
     * 客户端认 meta.kind 后就短路了，不会生成聊天消息。
     */
    const writeShortcutDeliveryDiagnostic = async () => {
      if (!shortcutDeliveryError) return;
      await rest("push_outbox", {
        method: "POST",
        body: JSON.stringify([{
          id: `out_${crypto.randomUUID()}`,
          user_id: job.user_id,
          job_id: job.id,
          session_id: payload.merge?.sessionId ?? null,
          trigger_key: null,
          raw_text: shortcutDeliveryError,
          meta: { kind: "shortcut_delivery_error", shortcutDeliveryError },
        }]),
      }).catch(() => undefined);
    };

    const deliverDeferredShortcut = async () => {
      // 邮件命令绝不能落到下面的 shortcut-deliver：本网关只发 Web Push，
      // 邮件模式在那边是 409。这里改请站点代发。
      if (deferredShortcutEmail) {
        const pending = deferredShortcutEmail;
        deferredShortcutEmail = null;
        shortcutActionNote += noteShortcutDelivery(pending.actionName, await deliverShortcutEmailViaSite(pending));
        await progress(shortcutActionNote);
        return;
      }
      if (!deferredShortcutCommandId) return;
      const commandId = deferredShortcutCommandId;
      const actionName = deferredShortcutActionName || "快捷动作";
      deferredShortcutCommandId = "";
      deferredShortcutActionName = "";
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ai-phone-service-key": serviceKey,
            "x-ai-phone-origin": siteOrigin,
          },
          body: JSON.stringify({ commandId }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; delivered?: boolean; error?: string };
        const delivered = response.ok && data.ok === true && data.delivered === true;
        shortcutActionNote += delivered
          ? ", shortcut delivered after first reply"
          : noteShortcutDelivery(actionName, `, shortcut delivery failed: ${String(data.error || response.status).slice(0, 80)}`);
        await progress(shortcutActionNote);
      } catch (error) {
        shortcutActionNote += noteShortcutDelivery(actionName, `, shortcut delivery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`);
        await progress(shortcutActionNote);
      }
    };
    // shortcut_resume 已经是一次动作结果后的第二轮，禁止它再次解析动作标记，
    // 避免模型不守“不要重复执行”提示时形成递归快捷动作。
    if (!payload.shortcut) {
      const markerMatch = rawText.match(SHORTCUT_MARKER_RE);
      if (markerMatch) {
        const markerText = markerMatch[0];
        // 标记在剥离后正文中的原始位置：对前缀做同一套清洗后取长度（尾部 trim 不影响前缀）
        const cleanedPrefix = rawText.slice(0, markerMatch.index ?? 0)
          .replace(SHORTCUT_MARKER_STRIP_RE, "")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/^\s+/, "");
        rawText = rawText.replace(SHORTCUT_MARKER_STRIP_RE, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!rawText) rawText = "……";
        const markerInsertAt = Math.min(cleanedPrefix.length, rawText.length);
        const wanted = markerMatch[1].trim();
        const wantedArgs = parseShortcutMarkerArgs(markerMatch[2]);
        try {
          const catalogResponse = await rest(
            `push_bridge_config?user_id=eq.${encodeURIComponent(job.user_id)}&select=shortcut_actions&limit=1`,
          );
          const catalogRows = catalogResponse.ok ? await catalogResponse.json() as { shortcut_actions?: unknown }[] : [];
          const catalog = Array.isArray(catalogRows[0]?.shortcut_actions)
            ? catalogRows[0].shortcut_actions as Array<Record<string, unknown>>
            : [];
          const action = catalog.find(entry => String(entry.name ?? "") === wanted);
          if (action) {
            const resultMode = String(action.resultMode ?? "none");
            // 目录里没有 deliveryMode 的是同步过来的老快照（该字段是后加的）。
            // 退回推送仍然能用（只是要对方点一下通知，而不是自动执行），比不投递好；
            // 但要在任务日志里留痕，否则「提示词说自动执行、实际弹了通知」查不出原因。
            // 用户改动作或下一轮桥同步时目录会补上这个字段，属自愈。
            const catalogHasDeliveryMode = typeof action.deliveryMode === "string";
            const deliveryMode = String(action.deliveryMode ?? "push") === "email" ? "email" : "push";
            if (!catalogHasDeliveryMode) shortcutActionNote += ", catalog missing deliveryMode (fell back to push)";
            const continuation = payload.shortcutContinuation;
            const canContinue = resultMode !== "none"
              && Boolean(continuation?.request && continuation.replyMarker && continuation.resultMarker);
            const createResponse = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-create`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-ai-phone-service-key": serviceKey,
                "x-ai-phone-origin": siteOrigin,
              },
              body: JSON.stringify({
                actionId: String(action.actionId ?? ""),
                actionName: String(action.name ?? ""),
                shortcutName: String(action.shortcutName ?? ""),
                arguments: wantedArgs,
                resultMode,
                deliveryMode,
                expiresInSeconds: Number(action.expiresInSeconds) || undefined,
                deferDelivery: canContinue,
              }),
            });
            const createData = await createResponse.json().catch(() => ({})) as {
              ok?: boolean;
              command?: { id?: string };
              resultUrl?: string;
            };
            shortcutActionNote = createResponse.ok && createData.ok
              ? `shortcut sent: ${wanted}`
              : `shortcut failed: http ${createResponse.status}`;
            if (createResponse.ok && createData.ok) {
              executedShortcutMarker = { text: markerText, insertAt: markerInsertAt, name: wanted };
            }

            // 邮件模式：个人云没有发信服务（RESEND_API_KEY 是站点的环境变量），
            // 请站点凭 site_bridge_token 代发那封信。命令行与结果回传仍留在本项目。
            // 有续跑的动作等续跑任务挂稳、首条回复送达之后再发（与推送模式同序），
            // 见下方 armed.ok 分支；这里只处理不回传结果、可以立刻触发的动作。
            const emailDelivery: DeferredShortcutEmail = {
              userId: job.user_id,
              commandId: String(createData.command?.id || ""),
              resultUrl: String(createData.resultUrl || ""),
              actionId: String(action.actionId ?? ""),
              actionName: String(action.name ?? ""),
              args: wantedArgs,
            };
            if (createResponse.ok && createData.ok && deliveryMode === "email" && !canContinue) {
              shortcutActionNote += noteShortcutDelivery(
                emailDelivery.actionName,
                await deliverShortcutEmailViaSite(emailDelivery),
              );
            }

            // 需回传结果的动作：武装 shortcut_resume 续跑任务——把刚生成的
            // 回复代入续跑快照的回复占位；结果回传后由本函数把结果代入生成下一轮。
            const commandId = String(createData.command?.id || "");
            if (createResponse.ok && createData.ok && canContinue && commandId && continuation) {
              try {
                const contRequest = JSON.parse(JSON.stringify(continuation.request)) as JobPayload["request"];
                replaceMarker(contRequest.body, continuation.replyMarker, rawText);
                const isImage = resultMode === "image";
                // 识图关着就不送图：送了轻则被模型忽略，重则接口直接 400 让整个
                // 第二轮失败（角色说了"我去看一眼"然后没有下文）。图片位改放一句
                // 说明，OCR 之类的附带文字仍照常经 resultMarker 抵达。
                const canSendImage = isImage && continuation.visionEnabled !== false;
                if (!canSendImage && continuation.imageMarker) {
                  replaceMarker(
                    contRequest.body,
                    continuation.imageMarker,
                    isImage ? SHORTCUT_VISION_OFF_NOTE : "（该动作没有图片回传）",
                  );
                }
                const expiresIn = Math.max(30, Math.min(900, Number(action.expiresInSeconds) || 120));
                const contPayload = {
                  request: contRequest,
                  shortcut: {
                    commandId,
                    actionName: String(action.name ?? "快捷动作"),
                    resultMode,
                    resultMarker: continuation.resultMarker,
                    ...(canSendImage && continuation.imageMarker ? { imageMarker: continuation.imageMarker } : {}),
                    style: "text",
                  },
                  notify: payload.notify,
                  merge: { ...(payload.merge ?? {}), shortcutCommandId: commandId },
                };
                const triggerKey = `shortcut:${commandId}`;
                await rest(
                  `push_jobs?user_id=eq.${encodeURIComponent(job.user_id)}&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
                  { method: "DELETE" },
                ).catch(() => undefined);
                const armed = await rest("push_jobs", {
                  method: "POST",
                  body: JSON.stringify([{
                    id: `job_${crypto.randomUUID()}`,
                    user_id: job.user_id,
                    trigger_key: triggerKey,
                    kind: "shortcut_resume",
                    execute_at: new Date(Date.now() + (expiresIn + 90) * 1000).toISOString(),
                    status: "pending",
                    result_note: "cloud_shortcut_resume",
                    payload: await encryptJobPayload(JSON.stringify(contPayload), payloadKey),
                  }]),
                });
                await armed.text().catch(() => "");
                // 挂载成功与否都要把命令投递出去——命令已经以 deferDelivery 建好，
                // 不投递它就只会静默过期：角色说了"我去看一下"，用户手机什么都收不到。
                // 挂载失败时降级为"没有第二轮"，动作照跑，只是结果不会自动交回角色。
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += armed.ok
                  ? ", continuation armed"
                  : ", continuation arm failed (degraded to one-shot)";
              } catch {
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += ", continuation arm failed (degraded to one-shot)";
              }
            }
          } else {
            shortcutActionNote = `shortcut unknown: ${wanted}`;
          }
        } catch {
          shortcutActionNote = "shortcut catalog unavailable";
        }
      }
    } else {
      // 结果续跑即使被模型诱导再次输出动作标记，也只剥离控制文本，不执行。
      rawText = rawText.replace(/【快捷动作[：:][^】\n]{1,60}】/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!rawText) rawText = "……";
    }
    if (shortcutActionNote) await progress(shortcutActionNote);

    // ── 离线改送微信：普通任务由 AI 首行【发到微信】选择；真实微信快捷动作
    // 的结果续跑使用 force，保证第二轮无需模型再次决定渠道也回到同一 bot。 ──
    const WEIXIN_MARKER = "【发到微信】";
    let deliveredViaWeixin = false;
    {
      const head = rawText.slice(0, 200);
      const markerAt = head.indexOf(WEIXIN_MARKER);
      const forceWeixin = payload.weixin?.force === true;
      if (markerAt >= 0 || forceWeixin) {
        if (markerAt >= 0) {
          rawText = (rawText.slice(0, markerAt) + rawText.slice(markerAt + WEIXIN_MARKER.length)).trim();
          if (!rawText) rawText = "……";
          // 微信标记被剥掉后，快捷动作标记的还原位置要跟着前移（消费端还会钳位兜底）
          if (executedShortcutMarker && markerAt < executedShortcutMarker.insertAt) {
            executedShortcutMarker.insertAt = Math.max(0, executedShortcutMarker.insertAt - WEIXIN_MARKER.length);
          }
        }
        const weixinBotId = typeof payload.weixin?.botId === "string" ? payload.weixin.botId : "";
        if (!weixinBotId) await progress(`${forceWeixin ? "forced weixin" : "weixin marker"} but no bot in snapshot`);
        if (weixinBotId) {
          try {
            const secretResponse = await fetch(
              `${supabaseUrl}/storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
            );
            const secret = secretResponse.ok
              ? String(((await secretResponse.json().catch(() => ({}))) as { token?: unknown }).token || "")
              : "";
            if (secret) {
              const sendResponse = await fetch(`${supabaseUrl}/functions/v1/weixin-assistant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "send-text",
                  token: secret,
                  bot: weixinBotId,
                  text: rawText,
                  ...(typeof payload.merge?.replyAfterLocalMessageId === "string"
                    && typeof payload.merge?.replyAfterCreatedAt === "string"
                    ? {
                        replyAfterLocalMessageId: payload.merge.replyAfterLocalMessageId,
                        replyAfterCreatedAt: payload.merge.replyAfterCreatedAt,
                      }
                    : {}),
                }),
              });
              const sendData = await sendResponse.json().catch(() => ({})) as { ok?: boolean; error?: string };
              deliveredViaWeixin = sendResponse.ok && sendData.ok === true;
              await progress(deliveredViaWeixin
                ? "delivered via weixin"
                : `weixin send failed: ${String(sendData.error || sendResponse.status).slice(0, 120)}`);
            } else {
              await progress("weixin secret missing");
            }
          } catch (err) {
            await progress(`weixin send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
          }
        }
      }
    }
    if (deliveredViaWeixin) {
      if (shortcutStoragePath) {
        await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => undefined);
      }
      await deliverDeferredShortcut();
      await writeShortcutDeliveryDiagnostic();
      await finish("done", `sent via weixin${shortcutActionNote ? `, ${shortcutActionNote}` : ""}`);
      return;
    }

    await progress(`llm ok, ${rawText.length} chars${deliverAsCall ? ", call" : ""}`);
    const outboxResponse = await rest("push_outbox", {
      method: "POST",
      body: JSON.stringify([{
        id: `out_${crypto.randomUUID()}`,
        user_id: job.user_id,
        job_id: job.id,
        session_id: payload.merge?.sessionId ?? null,
        trigger_key: job.trigger_key,
        raw_text: rawText,
        meta: {
          ...(payload.merge ?? {}),
          pushGenerated: true,
          ...(executedShortcutMarker ? { shortcutMarker: executedShortcutMarker } : {}),
        },
      }]),
    });
    if (!outboxResponse.ok) {
      const detail = await outboxResponse.text().catch(() => "");
      await finish("failed", `outbox write failed: ${detail.slice(0, 180) || outboxResponse.status}`);
      return;
    }
    await progress("outbox written, pushing");

    if (shortcutStoragePath) {
      await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => undefined);
    }

    const vapidResponse = await rest("push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key&limit=1");
    const vapidRows = vapidResponse.ok ? await vapidResponse.json() as { vapid_public_key: string; vapid_private_key: string }[] : [];
    const vapidRow = vapidRows[0];
    let pushed = 0;
    const pushErrors: string[] = [];
    // 安卓壳（FloatShell App）的合成订阅（endpoint 以 shell: 开头）不走 Web Push，
    // 改由 Supabase Realtime 广播送达壳内长连接。
    const webSubs = subs.filter(sub => !sub.endpoint.startsWith("shell:"));
    const hasShellSub = webSubs.length < subs.length;
    const vapid = vapidRow
      ? { publicKey: vapidRow.vapid_public_key, privateKey: vapidRow.vapid_private_key, subject: siteOrigin || "mailto:push@ai-phone.local" }
      : null;
    if (!vapid && webSubs.length > 0) pushErrors.push("no vapid config");
    const title = payload.notify?.title || "小手机";
    const callSessionId = typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
    // 来电：单条推送（不分段），点开带 ring 参数直达振铃；正文照常进 outbox
    const targetUrl = deliverAsCall && callSessionId
      ? `/?ring=${encodeURIComponent(callSessionId)}&rt=${Date.now()}`
      : (payload.notify?.url || "/");
    let parts = deliverAsCall
      ? ["来电话了…"]
      : splitResponseForPushPreview(rawText).slice(0, 6);
    if (parts.length === 0) parts = ["发来一条消息"];

    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) await sleep(500);
      const partBody = parts[index].slice(0, 80);
      const message = JSON.stringify({
        type: deliverAsCall ? "incoming_call" : "chat_outbox",
        title: deliverAsCall ? `📞 ${title}` : title,
        body: partBody,
        tag: `${job.id}-${index}`,
        url: targetUrl,
        // SW 用它取本地缓存的角色头像当通知 icon；老 SW 不认识则忽略
        ...(payload.notify?.characterId ? { characterId: payload.notify.characterId } : {}),
        ...(deliverAsCall ? { sessionId: callSessionId, callTs: Date.now() } : {}),
      });
      if (vapid) {
        for (const sub of webSubs) {
          try {
            const status = await sendWebPushRaw(sub, message, vapid, 3600);
            if (status === 404 || status === 410) {
              await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
            } else if (status >= 400) {
              pushErrors.push(`http ${status}`);
            } else {
              pushed += 1;
            }
          } catch (err) {
            pushErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 80));
          }
        }
      }
      if (hasShellSub) {
        try {
          const response = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
            method: "POST",
            headers: restHeaders,
            body: JSON.stringify({
              messages: [{
                topic: `shellpush:${job.user_id}`,
                event: "notify",
                payload: {
                  title: deliverAsCall ? `📞 ${title}` : title,
                  body: partBody,
                  url: targetUrl,
                  // 老壳不认识这些字段 → 照常显示普通通知，自然向下兼容
                  ...(deliverAsCall ? { kind: "call", characterName: title, sessionId: callSessionId, callTs: Date.now() } : {}),
                },
              }],
            }),
          });
          await response.text().catch(() => undefined);
          if (response.ok) pushed += 1;
          else pushErrors.push(`shell http ${response.status}`);
        } catch (err) {
          pushErrors.push(`shell ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
        }
      }
      await progress(`pushed ${index + 1}/${parts.length}${pushErrors.length ? `, errors: ${pushErrors[0]}` : ""}`);
    }

    // 第一轮正文已经落库并完成推送后，再发“运行快捷指令”通知。用户看到的
    // 顺序稳定为：角色先说话 → 运行动作 → 结果回来后角色再说话。
    await deliverDeferredShortcut();

    await writeShortcutDeliveryDiagnostic();

    // 冷场重连的下一发：连发上限内自动排队（用户回来后客户端会撤销并按新周期重挂）
    const idleRepeat = payload.merge?.idleRepeat as
      | { intervalMs?: number; remaining?: number; quietWin?: { startMin: number; endMin: number; tzOffsetMin: number } | null }
      | undefined;
    if (idleRepeat && Number(idleRepeat.remaining) > 0 && Number(idleRepeat.intervalMs) > 0) {
      const intervalMs = Number(idleRepeat.intervalMs);
      let nextFire = Date.now() + intervalMs;
      // 落在安静时段内则顺延到时段结束
      const quiet = idleRepeat.quietWin;
      if (quiet && Number.isFinite(quiet.startMin) && Number.isFinite(quiet.endMin)) {
        const localMinutes = (Math.floor(nextFire / 60000) + quiet.tzOffsetMin) % 1440;
        const inQuiet = quiet.startMin < quiet.endMin
          ? localMinutes >= quiet.startMin && localMinutes < quiet.endMin
          : localMinutes >= quiet.startMin || localMinutes < quiet.endMin;
        if (inQuiet) {
          const untilEnd = (quiet.endMin - localMinutes + 1440) % 1440;
          nextFire += untilEnd * 60000;
        }
      }
      const nextMerge = {
        ...payload.merge,
        armAt: new Date(nextFire).toISOString(),
        idleReconnect: { ...(payload.merge?.idleReconnect as Record<string, unknown> ?? {}), firedAt: nextFire },
        idleRepeat: Number(idleRepeat.remaining) - 1 > 0
          ? { ...idleRepeat, remaining: Number(idleRepeat.remaining) - 1 }
          : undefined,
      };
      const nextPayload = { ...payload, merge: nextMerge };
      await rest("push_jobs", {
        method: "POST",
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: job.user_id,
          trigger_key: `${job.trigger_key}+`,
          kind: "timed_task",
          execute_at: new Date(nextFire + 15_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify(nextPayload), payloadKey),
        }]),
      }).catch(() => undefined);
    }

    await finish("done", `generated, pushed ${pushed}${shortcutActionNote ? `, ${shortcutActionNote}` : ""}${pushErrors.length ? `, errors: ${pushErrors.slice(0, 3).join(" | ")}` : ""}`);
  } catch (err) {
    await finish("failed", err instanceof Error ? err.message : String(err));
  }
  };

  const work = runJob();
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});
