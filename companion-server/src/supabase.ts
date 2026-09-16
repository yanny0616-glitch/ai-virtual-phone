// 个人云（用户自己的 Supabase）只读/少量写的 REST 封装。
// 新版 sb_secret_ 密钥只放 apikey 头；旧版 JWT service_role 还要带 Authorization。

import type { Config } from "./config.ts";

export type Rest = (path: string, init?: RequestInit) => Promise<Response>;

export function createRest(config: Pick<Config, "personalUrl" | "personalKey">, fetchImpl: typeof fetch = fetch): Rest {
  const headers: Record<string, string> = { apikey: config.personalKey };
  if (config.personalKey.startsWith("eyJ")) headers.Authorization = `Bearer ${config.personalKey}`;
  return (path, init = {}) => fetchImpl(`${config.personalUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

export async function restJson<T>(rest: Rest, path: string): Promise<T> {
  const response = await rest(path);
  if (!response.ok) throw new Error(`个人云读取失败 ${response.status}：${path.split("?")[0]}`);
  return await response.json() as T;
}

export type MirrorRow = {
  id: string;
  session_id: string;
  character_id: string;
  role: "user" | "assistant";
  content: string;
  media_type: string | null;
  message_at: string;
};

export type SubscriptionRow = { endpoint: string; user_id: string; p256dh: string; auth: string };

export type VapidRow = { vapid_public_key: string; vapid_private_key: string; site_origin: string | null };

/** 单用户部署：优先用配置；否则要求订阅表里只有一个账号，避免推错人。 */
export async function resolveUserId(rest: Rest, configured: string): Promise<string> {
  if (configured) return configured;
  const rows = await restJson<{ user_id: string }[]>(rest, "push_subscriptions?select=user_id");
  const ids = [...new Set(rows.map(row => row.user_id))];
  if (ids.length !== 1) throw new Error(`无法自动确定账号（订阅表里有 ${ids.length} 个账号），请设置 COMPANION_USER_ID`);
  return ids[0];
}
