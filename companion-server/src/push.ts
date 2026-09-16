// Web Push：用个人云里的同一对 VAPID 密钥和订阅，手机不需要重新订阅。
// 404/410 的失效订阅顺手删掉（与 push-generate / lib/server/push-service 一致）。
// shell: 开头的是安卓壳的合成订阅，走 Realtime，阶段 1 不处理。

import webpush from "web-push";

import { restJson, type Rest, type SubscriptionRow, type VapidRow } from "./supabase.ts";

export type PushMessage = { title: string; body: string; tag?: string; url?: string; type?: string; characterId?: string };

export type PushResult = { sent: number; total: number; removed: number; skippedShell: number; errors: string[] };

type Sender = (sub: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;

export async function sendPushToUser(
  rest: Rest,
  userId: string,
  message: PushMessage,
  send: Sender = webpush.sendNotification,
): Promise<PushResult> {
  const [vapid] = await restJson<VapidRow[]>(rest, "push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,site_origin&limit=1");
  if (!vapid?.vapid_public_key || !vapid.vapid_private_key) throw new Error("个人云里没有 VAPID 密钥");
  const subs = await restJson<SubscriptionRow[]>(rest, `push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=endpoint,user_id,p256dh,auth`);

  const result: PushResult = { sent: 0, total: subs.length, removed: 0, skippedShell: 0, errors: [] };
  const payload = JSON.stringify(message);
  const options: webpush.RequestOptions = {
    TTL: 3600,
    vapidDetails: {
      subject: vapid.site_origin || "mailto:push@ai-phone.local",
      publicKey: vapid.vapid_public_key,
      privateKey: vapid.vapid_private_key,
    },
  };

  for (const sub of subs) {
    if (sub.endpoint.startsWith("shell:")) { result.skippedShell += 1; continue; }
    try {
      await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, options);
      result.sent += 1;
      await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
        method: "PATCH", body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }),
      }).catch(() => undefined);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
        result.removed += 1;
      } else {
        result.errors.push(status ? `http ${status}` : (err instanceof Error ? err.message : String(err)).slice(0, 80));
      }
    }
  }
  return result;
}
