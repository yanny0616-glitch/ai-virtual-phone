// 提示词模板：App（宿主）在 TA 每次回复后、小手机切到后台时把三份模板冻到个人云 push_jobs，
// 后端每轮看一眼 updated_at，有新的就解密存下。
//   capptpl:<挂念 appId>:<角色>:judge   判断
//   capptpl:<挂念 appId>:<角色>:daily   生成一天
//   capptpl:<挂念 appId>:<角色>:chat    聊天（聊天 APP 原样提示词 + 完整聊天记录，意图和时间留占位）

import { decryptPayload, type EncryptedPayload } from "./crypto.ts";
import type { ModelRequest } from "./types.ts";
import type { Snapshot, SnapshotPurpose, Store } from "./store.ts";
import { restJson, type Rest } from "./supabase.ts";

const PURPOSE: Record<string, SnapshotPurpose> = { judge: "judge", daily: "daily", chat: "chat" };

export async function syncTemplates(rest: Rest, store: Store, userId: string): Promise<string[]> {
  const characters = new Map(store.listCharacters().map(c => [c.characterId, c]));
  if (!characters.size) return [];
  const rows = await restJson<{ trigger_key: string; updated_at: string }[]>(rest,
    `push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=like.capptpl:*gua.nian*&select=trigger_key,updated_at&limit=200`);
  const fresh = rows.filter(row => {
    const m = /^capptpl:[^:]+:(.+):([a-z0-9_-]+)$/.exec(row.trigger_key);
    return m && characters.has(m[1]) && PURPOSE[m[2]] && store.getMeta("tpl:" + row.trigger_key) !== row.updated_at;
  });
  if (!fresh.length) return [];
  const [cfg] = await restJson<{ payload_key: string | null }[]>(rest, "push_server_config?id=eq.main&select=payload_key&limit=1");
  if (!cfg?.payload_key) return [];
  const updated: string[] = [];
  for (const row of fresh) {
    const [, characterId, key] = /^capptpl:[^:]+:(.+):([a-z0-9_-]+)$/.exec(row.trigger_key)!;
    const [job] = await restJson<{ payload: EncryptedPayload; updated_at: string }[]>(rest,
      `push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=eq.${encodeURIComponent(row.trigger_key)}&select=payload,updated_at&limit=1`);
    if (!job) continue;
    let payload: { request?: ModelRequest; notify?: { title?: string; url?: string }; merge?: Record<string, unknown> };
    try { payload = JSON.parse(await decryptPayload(job.payload, cfg.payload_key)); }
    catch { continue; }
    store.setMeta("tpl:" + row.trigger_key, row.updated_at);
    if (!payload?.request?.url) continue;
    const merge = payload.merge && typeof payload.merge === "object" ? payload.merge : {};
    const purpose = PURPOSE[key];
    const capturedAt = Date.parse(String(merge.snapshotAt || "")) || Date.parse(job.updated_at) || Date.now();
    const existing = store.getSnapshot(characterId, purpose);
    if (existing && existing.capturedAt >= capturedAt) continue;
    const c = characters.get(characterId)!;
    const snap: Snapshot = {
      characterId, purpose, sessionId: String(merge.sessionId || c.sessionId), capturedAt,
      request: payload.request, notify: { title: payload.notify?.title, url: payload.notify?.url }, merge,
    };
    store.saveSnapshot(snap);
    if (merge.sessionId && merge.sessionId !== c.sessionId) { c.sessionId = String(merge.sessionId); store.saveCharacter(c); }
    updated.push(`${c.name || characterId}:${purpose}`);
  }
  return updated;
}

const WEEKDAY = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function zoned(nowMs: number, zone: string | null, tzOffsetMin: number): string {
  let y: number, mo: number, d: number, h: string, mi: string, wd: number;
  try {
    if (!zone) throw new Error("no zone");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(new Date(nowMs)).map(p => [p.type, p.value]));
    y = +parts.year; mo = +parts.month; d = +parts.day; h = parts.hour; mi = parts.minute;
    wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  } catch {
    const t = new Date(nowMs + tzOffsetMin * 60_000);
    y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
    h = String(t.getUTCHours()).padStart(2, "0"); mi = String(t.getUTCMinutes()).padStart(2, "0"); wd = t.getUTCDay();
  }
  return `${y}年${mo}月${d}日${h}:${mi}` + (zone ? ` ${zone}` : "") + `，${WEEKDAY[wd] ?? ""}`;
}

/** 聊天模板到点填空：意图、「约 N 分钟前决定的」、冻结时烤进去的系统时间 / 角色本地时间 */
export function fillChatTemplate(template: ModelRequest, merge: Record<string, unknown>, fill: { intent: string; elapsedMin: number; nowMs: number }): ModelRequest {
  const placeholder = String(merge.intentPlaceholder || "");
  const mark = Number(merge.elapsedMark) || 0;
  const tz = Number.isFinite(Number(merge.tzOffsetMin)) ? Number(merge.tzOffsetMin) : 480;
  // JSON 里的字符串要转义后再塞回去
  const esc = (text: string) => JSON.stringify(text).slice(1, -1);
  let text = JSON.stringify(template.body);
  if (placeholder) text = text.split(placeholder).join(esc(fill.intent));
  if (mark) text = text.split(`约 ${mark} 分钟前`).join(`约 ${Math.max(1, Math.round(fill.elapsedMin))} 分钟前`);
  const time = "(\\d{4}年\\d{1,2}月\\d{1,2}日\\d{2}:\\d{2})(?: ([A-Za-z_]+(?:\\/[A-Za-z_+\\-0-9]+)*))?，星期.";
  text = text.replace(new RegExp("当前系统时间：" + time, "g"), (_m, _t, zone) => "当前系统时间：" + zoned(fill.nowMs, zone || null, tz));
  text = text.replace(new RegExp("角色本地时间：" + time, "g"), (_m, _t, zone) => "角色本地时间：" + zoned(fill.nowMs, zone || null, tz));
  return { ...template, body: JSON.parse(text) };
}
