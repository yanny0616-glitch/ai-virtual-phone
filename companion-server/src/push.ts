// Web Push：用个人云里的同一对 VAPID 密钥和订阅，手机不需要重新订阅。
// 404/410 的失效订阅顺手删掉（与 push-generate / lib/server/push-service 一致）。
// shell: 开头的是安卓壳的合成订阅：不走 Web Push，改发 Realtime 广播 shellpush:<userId>，壳内长连接收（与 push-generate 一致）。

import webpush from "web-push";

import { restJson, type Cloud, type Rest, type SubscriptionRow, type VapidRow } from "./supabase.ts";

export type PushMessage = { title: string; body: string; tag?: string; url?: string; type?: string; characterId?: string; sessionId?: string; callTs?: number };

export type PushResult = { sent: number; total: number; removed: number; skippedShell: number; errors: string[] };

type Sender = (sub: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;

/** 依次推送多条（一条回复按段拆成几条通知），段与段之间隔 gapMs */
export async function sendPushMessages(
  rest: Rest,
  userId: string,
  messages: PushMessage[],
  send: Sender = webpush.sendNotification,
  gapMs = 500,
  cloud?: Cloud,
): Promise<PushResult> {
  const [vapid] = await restJson<VapidRow[]>(rest, "push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,site_origin&limit=1");
  if (!vapid?.vapid_public_key || !vapid.vapid_private_key) throw new Error("个人云里没有 VAPID 密钥");
  const all = await restJson<SubscriptionRow[]>(rest, `push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,user_id,p256dh,auth`);

  const result: PushResult = { sent: 0, total: all.length, removed: 0, skippedShell: 0, errors: [] };
  const options: webpush.RequestOptions = {
    TTL: 3600,
    vapidDetails: {
      subject: vapid.site_origin || "mailto:push@ai-phone.local",
      publicKey: vapid.vapid_public_key,
      privateKey: vapid.vapid_private_key,
    },
  };
  let subs = all.filter(sub => !sub.endpoint.startsWith("shell:"));
  const hasShell = subs.length < all.length;
  if (!cloud) result.skippedShell = all.length - subs.length;

  for (let index = 0; index < messages.length; index += 1) {
    if (index > 0 && gapMs > 0) await new Promise(resolve => setTimeout(resolve, gapMs));
    const payload = JSON.stringify(messages[index]);
    const alive: SubscriptionRow[] = [];
    for (const sub of subs) {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, options);
        result.sent += 1;
        alive.push(sub);
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
          method: "PATCH", body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }),
        }).catch(() => undefined);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
          result.removed += 1;
        } else {
          alive.push(sub);
          result.errors.push(status ? `http ${status}` : (err instanceof Error ? err.message : String(err)).slice(0, 80));
        }
      }
    }
    subs = alive;
    if (hasShell && cloud) {
      const m = messages[index];
      const call = m.type === "incoming_call";
      try {
        const response = await cloud("realtime/v1/api/broadcast", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ topic: `shellpush:${userId}`, event: "notify", payload: {
            title: m.title, body: m.body, url: m.url || "/",
            // 老壳不认识这些字段就照常弹普通通知
            ...(call ? { kind: "call", characterName: m.title.replace(/^📞\s*/, ""), sessionId: m.sessionId, callTs: m.callTs } : {}),
          } }] }),
        });
        await response.text().catch(() => undefined);
        if (response.ok) result.sent += 1;
        else result.errors.push(`shell http ${response.status}`);
      } catch (err) {
        result.errors.push(`shell ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
      }
    }
  }
  return result;
}

export function sendPushToUser(rest: Rest, userId: string, message: PushMessage, send: Sender = webpush.sendNotification): Promise<PushResult> {
  return sendPushMessages(rest, userId, [message], send);
}
