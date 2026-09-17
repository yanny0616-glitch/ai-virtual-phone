// 发送分流：挂念到点成文后，按正文里的控制标记决定怎么送——打电话、发到真实微信、请对方 iPhone 跑快捷动作。
// 规则与文案逐段搬自 push-generate（离线来电 / 离线快捷动作 / 离线改送微信），标记一律从正文剥离。
// 快捷命令本身（建命令、推「运行快捷指令」通知、收结果）仍是个人云 ai-phone-push 的现实桥网关，后端只当调用方；
// 结果续跑由后端自己等结果、自己生成第二轮（见 shortcut-resume.ts），不再挂 shortcut_resume 云任务。

import type { Cloud, Rest } from "./supabase.ts";
import type { ModelRequest, ProviderKind } from "./types.ts";

// ─── 标记解析（纯函数）

const CALL_MARKERS = [
  /\[我向[^\]\r\n]{1,80}发起了语音通话\]/,
  /【我向[^】\r\n]{1,80}发起了语音通话】/,
  /\[我发起了语音通话\]/,
  /【我发起了语音通话】/,
  /【拨打电话】/,
];

/** 只认开头 200 字内的严格通话标签，普通叙述里的「发起了通话」不算 */
export function extractCall(text: string): { text: string; call: boolean } {
  const head = text.slice(0, 200);
  const hit = CALL_MARKERS.map(re => { const m = re.exec(head); return m ? { marker: m[0], index: m.index } : null; })
    .filter((x): x is { marker: string; index: number } => x !== null)
    .sort((a, b) => a.index - b.index)[0];
  if (!hit) return { text, call: false };
  const rest = (text.slice(0, hit.index) + text.slice(hit.index + hit.marker.length)).trim();
  return { text: rest || "……", call: true };
}

export const SHORTCUT_MARKER_RE = /【快捷动作[：:]\s*([^(（）)】\n]{1,60}?)\s*(?:[(（]([\s\S]{0,2000}?)[)）])?\s*】/;
const SHORTCUT_MARKER_STRIP_RE = new RegExp(SHORTCUT_MARKER_RE.source, "g");

export type ShortcutMarker = { text: string; insertAt: number; name: string; args: Record<string, unknown> };

/** 标记括号里的 JSON 参数。写坏了就当没带参数 */
export function parseShortcutArgs(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  for (const candidate of [text, text.replace(/[“”„‟]/g, '"').replace(/：/g, ":").replace(/，/g, ",")]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 下一个 */ }
  }
  return {};
}

/** 取第一个快捷动作标记并剥掉全部标记；insertAt 是标记在剥离后正文里的位置（补收时在原位置落 tool_call） */
export function extractShortcut(text: string): { text: string; marker: ShortcutMarker | null } {
  const m = text.match(SHORTCUT_MARKER_RE);
  if (!m) return { text, marker: null };
  const clean = (s: string) => s.replace(SHORTCUT_MARKER_STRIP_RE, "").replace(/\n{3,}/g, "\n\n");
  const prefix = clean(text.slice(0, m.index ?? 0)).replace(/^\s+/, "");
  const rest = clean(text).trim() || "……";
  return { text: rest, marker: { text: m[0], insertAt: Math.min(prefix.length, rest.length), name: m[1].trim(), args: parseShortcutArgs(m[2]) } };
}

/** 续跑第二轮：模型再输出动作标记也只剥掉，不执行，防止递归 */
export function stripShortcutMarkers(text: string): string {
  return text.replace(SHORTCUT_MARKER_STRIP_RE, "").replace(/\n{3,}/g, "\n\n").trim() || "……";
}

export const WEIXIN_MARKER = "【发到微信】";

export function extractWeixin(text: string, marker: ShortcutMarker | null): { text: string; weixin: boolean } {
  const at = text.slice(0, 200).indexOf(WEIXIN_MARKER);
  if (at < 0) return { text, weixin: false };
  if (marker && at < marker.insertAt) marker.insertAt = Math.max(0, marker.insertAt - WEIXIN_MARKER.length);
  return { text: (text.slice(0, at) + text.slice(at + WEIXIN_MARKER.length)).trim() || "……", weixin: true };
}

// ─── 来电能力：模板里留占位，到点按频控决定放不放说明

export const CALL_INVITE_PLACEHOLDER = "__GUANIAN_CALL_INVITE__";
export const CALL_INVITE_WINDOW_MS = 20 * 3600_000;
export const CALL_INVITE_INSTRUCTION = "（可选能力：如果你此刻更想直接给对方打语音电话——想念、着急、有情绪、"
  + "或者事情几句话说不清——就在回复的第一行使用你已有的小手机通话格式：[我向当前聊天对象发起了语音通话]，"
  + "其中聊天对象按当前用户填写；从第二行开始写你接通后要说的话。"
  + "不适合打电话就正常发消息。无论选哪种，都不要提及本条说明。）";
const CALL_INVITE_OFF = "（这一条照常发消息，不打电话，也不要提及本条说明。）";

/** 把请求里的来电占位换成说明或「照常发消息」；返回有没有占位 */
export function fillCallInvite(request: ModelRequest, allow: boolean): { request: ModelRequest; present: boolean } {
  const text = JSON.stringify(request.body);
  if (!text.includes(CALL_INVITE_PLACEHOLDER)) return { request, present: false };
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  return { request: { ...request, body: JSON.parse(text.split(CALL_INVITE_PLACEHOLDER).join(esc(allow ? CALL_INVITE_INSTRUCTION : CALL_INVITE_OFF))) }, present: true };
}

// ─── 快捷动作续跑占位（与 lib/offline-shortcut-capability.ts 同一套整值替换契约）

export type ShortcutContinuation = {
  request: ModelRequest; replyMarker: string; resultMarker: string; imageMarker?: string; visionEnabled?: boolean;
};

export const SHORTCUT_VISION_OFF_NOTE = "（系统记录：未配置或未启用图像识别，本轮回传的图片没有交给你；请结合上一条的文字内容回应。）";

export function replaceMarker(value: unknown, marker: string, replacement: string): boolean {
  if (!value || typeof value !== "object") return false;
  let replaced = false;
  const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  for (const [key, item] of entries) {
    if (item === marker) { (value as Record<string | number, unknown>)[key] = replacement; replaced = true; }
    else if (replaceMarker(item, marker, replacement)) replaced = true;
  }
  return replaced;
}

export type ShortcutCommandRow = {
  id: string; status: "pending" | "claimed" | "succeeded" | "failed" | "expired" | "cancelled";
  action_name: string; result_mode: "none" | "text" | "image"; result: Record<string, unknown> | null; error: string | null; expires_at: string;
};

function shortcutResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text ?? (value as Record<string, unknown>).message ?? (value as Record<string, unknown>).value;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ""); }
}

export function formatShortcutResult(command: ShortcutCommandRow): string {
  const actionName = String(command.action_name || "快捷动作").replace(/"/g, "&quot;");
  const success = command.status === "succeeded";
  const detail = success
    ? shortcutResultText(command.result) || "快捷指令已执行成功。"
    : command.error || (command.status === "expired" ? "等待手机执行超时。" : `命令状态：${command.status}`);
  const tag = success
    ? `<action_result name="${actionName}">${detail}</action_result>`
    : `<action_result name="${actionName}" error="${detail.replace(/"/g, "&quot;")}"></action_result>`;
  return `以下是系统处理结果：\n${tag}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}

export function injectShortcutImage(body: Record<string, unknown>, kind: ProviderKind, marker: string, image: { mimeType: string; base64: string } | null): void {
  const text = image ? "系统记录：这是快捷指令刚刚回传的截图。" : "系统记录：快捷指令截图读取失败。";
  if (kind === "anthropic" || kind === "gemini") {
    const list = (kind === "anthropic" ? body.messages : body.contents) as { content?: unknown[]; parts?: unknown[] }[] | undefined;
    for (const message of Array.isArray(list) ? list : []) {
      const parts = kind === "anthropic" ? message.content : message.parts;
      if (!Array.isArray(parts)) continue;
      const index = parts.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      parts.splice(index, 1, ...(kind === "anthropic"
        ? [{ type: "text", text }, ...(image ? [{ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }] : [])]
        : [{ text }, ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : [])]));
      return;
    }
    return;
  }
  for (const message of Array.isArray(body.messages) ? body.messages as { content?: unknown }[] : []) {
    if (message.content !== marker) continue;
    message.content = image
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } }]
      : text;
    return;
  }
}

// ─── 调个人云（现实桥网关、微信云助手、站点代发邮件）

export type ShortcutCommand = {
  id: string; resultUrl: string; actionId: string; actionName: string; args: Record<string, unknown>;
  deliveryMode: "push" | "email"; resultMode: string; expiresInSeconds: number; continued: boolean;
};

/** key：个人云管理员密钥，ai-phone-push 用 x-ai-phone-service-key 核对 */
export type CloudCtx = { rest: Rest; cloud: Cloud; key: string; userId: string; beforeEffect?: () => Promise<void> };

async function siteOrigin(c: CloudCtx): Promise<string> {
  const r = await c.rest("push_server_config?id=eq.main&select=site_origin&limit=1").catch(() => null);
  const rows = r?.ok ? await r.json() as { site_origin?: string | null }[] : [];
  return String(rows[0]?.site_origin || "");
}

/** 建快捷命令，一律延后投递（先让角色第一句话落地、推送完，再弹「运行快捷指令」） */
export async function createShortcutCommand(c: CloudCtx, marker: ShortcutMarker, canContinue: boolean): Promise<{ command: ShortcutCommand | null; note: string }> {
  const r = await c.rest(`push_bridge_config?user_id=eq.${encodeURIComponent(c.userId)}&select=shortcut_actions&limit=1`).catch(() => null);
  if (!r?.ok) return { command: null, note: "快捷动作目录读不到" };
  const rows = await r.json() as { shortcut_actions?: unknown }[];
  const catalog = Array.isArray(rows[0]?.shortcut_actions) ? rows[0].shortcut_actions as Record<string, unknown>[] : [];
  const action = catalog.find(entry => String(entry.name ?? "") === marker.name);
  if (!action) return { command: null, note: `没有叫「${marker.name}」的快捷动作` };
  const resultMode = String(action.resultMode ?? "none");
  const deliveryMode = String(action.deliveryMode ?? "push") === "email" ? "email" : "push";
  const continued = canContinue && resultMode !== "none";
  const origin = await siteOrigin(c);
  await c.beforeEffect?.();
  const response = await c.cloud("functions/v1/ai-phone-push?action=shortcut-create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-phone-service-key": c.key, "x-ai-phone-origin": origin },
    body: JSON.stringify({
      actionId: String(action.actionId ?? ""), actionName: String(action.name ?? ""), shortcutName: String(action.shortcutName ?? ""),
      arguments: marker.args, resultMode, deliveryMode, expiresInSeconds: Number(action.expiresInSeconds) || undefined, deferDelivery: true,
    }),
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; command?: { id?: string }; resultUrl?: string; error?: string };
  if (!response.ok || !data.ok || !data.command?.id) return { command: null, note: `快捷动作「${marker.name}」没建成：${String(data.error || response.status).slice(0, 80)}` };
  return {
    command: {
      id: data.command.id, resultUrl: String(data.resultUrl || ""), actionId: String(action.actionId ?? ""), actionName: String(action.name ?? marker.name),
      args: marker.args, deliveryMode, resultMode, expiresInSeconds: Math.max(30, Math.min(900, Number(action.expiresInSeconds) || 120)), continued,
    },
    note: `快捷动作「${marker.name}」已建`,
  };
}

/** 投递快捷命令：推送模式请网关推「运行快捷指令」，邮件模式请站点代发触发信。返回失败说明，成功为空串 */
export async function deliverShortcutCommand(c: CloudCtx, command: ShortcutCommand): Promise<string> {
  if (command.deliveryMode === "email") {
    const origin = await siteOrigin(c);
    if (!origin) return `快捷动作「${command.actionName}」未能送达：站点地址未知`;
    const t = await c.rest(`push_bridge_config?user_id=eq.${encodeURIComponent(c.userId)}&select=site_bridge_token&limit=1`).catch(() => null);
    const token = String((t?.ok ? await t.json() as { site_bridge_token?: string | null }[] : [])[0]?.site_bridge_token || "");
    if (!token) return `快捷动作「${command.actionName}」未能送达：站点代发未启用：请到「设置 → 云服务部署」重新部署个人云`;
    await c.beforeEffect?.();
    try {
      const response = await fetch(`${origin}/api/push/shortcut-commands/deliver-email`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ token, actionId: command.actionId, actionName: command.actionName, commandId: command.id, resultUrl: command.resultUrl, arguments: command.args }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      return response.ok && data.ok === true ? "" : `快捷动作「${command.actionName}」未能送达：${String(data.error || response.status).slice(0, 80)}`;
    } catch (e) { return `快捷动作「${command.actionName}」未能送达：${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
  }
  // 新命令一律延后投递；网关按 notified_at 去重，邮件网关按 commandId 去重。
  const origin = await siteOrigin(c);
  await c.beforeEffect?.();
  try {
    const response = await c.cloud("functions/v1/ai-phone-push?action=shortcut-deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-phone-service-key": c.key, "x-ai-phone-origin": origin },
      body: JSON.stringify({ commandId: command.id }),
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; delivered?: boolean; error?: string };
    return response.ok && data.ok === true && data.delivered === true ? "" : `快捷动作「${command.actionName}」未能送达：${String(data.error || response.status).slice(0, 80)}`;
  } catch (e) { return `快捷动作「${command.actionName}」未能送达：${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
}

/** 送达失败单独落一条诊断行（trigger_key 留空，客户端认 meta.kind 写进现实桥动态，不生成聊天消息） */
export async function writeShortcutDiagnostic(c: CloudCtx, sessionId: string, error: string): Promise<void> {
  if (!error) return;
  await c.rest("push_outbox", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ id: `out_${crypto.randomUUID()}`, user_id: c.userId, job_id: null, session_id: sessionId, trigger_key: null, raw_text: error.slice(0, 300), meta: { kind: "shortcut_delivery_error", shortcutDeliveryError: error.slice(0, 300) } }]),
  }).catch(() => undefined);
}

export type WeixinResult = { status: "sent" | "failed" | "unknown"; error?: string };

/** 没发起发送是确定失败；发起后超时/5xx/坏回执无法证明未发送。 */
export async function sendWeixin(c: CloudCtx, botId: string, text: string, extra: Record<string, unknown> = {}): Promise<WeixinResult> {
  let secret: string;
  try {
    const response = await c.cloud("storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json");
    secret = response.ok ? String(((await response.json().catch(() => ({}))) as { token?: unknown }).token || "") : "";
    if (!secret) return { status: "failed", error: "微信云助手密钥读不到" };
  } catch { return { status: "failed", error: "微信云助手密钥读取失败，尚未发起发送" }; }
  // 守卫放在 catch 外；取消/丢租约不能被误记为微信发送失败并转投聊天。
  await c.beforeEffect?.();
  try {
    const response = await c.cloud("functions/v1/weixin-assistant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send-text", token: secret, bot: botId, text, ...extra }),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (response.ok && data?.ok === true) return { status: "sent" };
    const definite = (response.ok && data?.ok === false) || [400, 401, 403, 404, 413, 429].includes(response.status);
    return { status: definite ? "failed" : "unknown", error: `微信发送${definite ? "失败" : "结果未确认"}：${String(data?.error || response.status).slice(0, 120)}` };
  } catch (e) {
    return { status: "unknown", error: `微信发送回执丢失：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}

/** 读快捷命令回传的截图（只认本命令自己的存储路径） */
export async function readShortcutImage(c: CloudCtx, command: ShortcutCommandRow): Promise<{ image: { mimeType: string; base64: string } | null; path: string }> {
  const result = command.result && typeof command.result === "object" ? command.result : {};
  const raw = typeof result.storagePath === "string" ? result.storagePath : "";
  if (command.status !== "succeeded" || !raw.startsWith(`${c.userId}/${command.id}.`) || !/\.(?:jpg|png|webp)$/.test(raw)) return { image: null, path: "" };
  const path = raw.split("/").map(encodeURIComponent).join("/");
  const file = await c.cloud(`storage/v1/object/shortcut-command-media/${path}`).catch(() => null);
  if (!file?.ok) return { image: null, path: "" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return { image: null, path };
  return { image: { mimeType: file.headers.get("content-type") || String(result.mimeType || "image/jpeg"), base64: Buffer.from(bytes).toString("base64") }, path };
}

export async function deleteShortcutImage(c: CloudCtx, path: string): Promise<void> {
  if (path) await c.cloud(`storage/v1/object/shortcut-command-media/${path}`, { method: "DELETE" }).catch(() => undefined);
}
