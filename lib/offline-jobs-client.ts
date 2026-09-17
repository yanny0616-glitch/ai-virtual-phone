// 离线任务分流：回复兜底 / 追问 / 定时消息 / 经期关怀按「离线执行」开关寄到个人云或后端（companion-server /app/jobs）。
// 同一条任务（triggerKey）任何时刻只挂在一边，切换开关不重复发：
//   · 挂：先撤另一边的同名任务，确认撤掉了才挂到这边。另一边正在生成就不挂，让它发完。
//   · 撤 / 心跳：两边都发（后端从没用过就不打扰它）。
//   · 已经排着的任务不搬家；下次重挂（切后台、回消息）时自然换到新的一边。后端到点前还会再查一遍个人云（jobs.ts）。
// 模板、快捷动作续跑、挂念的旧本机预约仍只走个人云：它们依赖云端的计划和结果回传。
import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { companionServerUrl, loadOfflineExecutorConfig, personalCloudCredentials } from './offline-executor';
import { pushJobsFetch } from './personal-push-cloud';

const USED_KEY = 'offline_jobs_server_used_v1';
registerKvMigration(USED_KEY);
const ROUTED_KINDS = new Set(['reply_bailout', 'followup', 'timed_task']);

type JobBody = { triggerKey?: string; triggerPrefix?: string; excludeKey?: string; kind?: string; runNow?: boolean };

function parseBody(init: RequestInit): JobBody {
  try { return typeof init.body === 'string' ? JSON.parse(init.body) as JobBody : {}; } catch { return {}; }
}

/** 挂念交给后端前在本机挂的旧预约要留在云端，后端没有挂念的计划复核 */
function routable(body: JobBody): boolean {
  return ROUTED_KINDS.has(String(body.kind)) && !!body.triggerKey && !/^timedwake:timed_wake_capp_(?:app_)?gua\.nian_/.test(body.triggerKey);
}

function serverMode(): boolean {
  return loadOfflineExecutorConfig().mode === 'server';
}

function serverUsed(): boolean {
  return kvGet(USED_KEY) === '1';
}

function serverFetch(path: string, body: unknown): Promise<Response> {
  const { key } = personalCloudCredentials();
  if (!key) return Promise.reject(new Error('个人云没连上，后端认不了你'));
  return fetch(`${companionServerUrl()}/app/jobs${path}`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const okResponse = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ ok: true, ...extra }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 与 pushJobsFetch 同签名：push-bailout-client 里所有离线任务的挂、撤、心跳都从这里走 */
export async function offlineJobsFetch(init: RequestInit): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'GET') return pushJobsFetch(init);
  const body = parseBody(init);

  if (method === 'POST') {
    if (!routable(body)) return pushJobsFetch(init);
    if (serverMode()) {
      // 先撤云端同名的，确认后才挂后端；撤不掉就不挂，任务留在云端照常发
      const removed = await pushJobsFetch({ method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ triggerKey: body.triggerKey }) });
      if (!removed.ok) return removed;
      kvSet(USED_KEY, '1');
      const posted = await serverFetch('', JSON.parse(String(init.body)));
      // 后端同名任务正在生成：让它发完，不算失败
      return posted.status === 409 ? okResponse({ skipped: 'running on server' }) : posted;
    }
    if (serverUsed()) {
      const removed = await serverFetch('/cancel', { triggerKey: body.triggerKey }).catch(() => null);
      const data = removed?.ok ? await removed.json().catch(() => null) as { running?: number } | null : null;
      if (data && Number(data.running) > 0) return okResponse({ skipped: 'running on server' });
    }
    return pushJobsFetch(init);
  }

  // 撤销 / 心跳：两边都发
  const toServer = serverMode() || serverUsed();
  const serverCall = toServer
    ? serverFetch(method === 'DELETE' ? '/cancel' : '/delay', method === 'DELETE'
      ? { triggerKey: body.triggerKey, triggerPrefix: body.triggerPrefix, excludeKey: body.excludeKey }
      : { triggerKey: body.triggerKey, runNow: body.runNow === true }).catch(() => null)
    : Promise.resolve(null);
  const [cloud, server] = await Promise.all([pushJobsFetch(init).catch(() => null), serverCall]);
  const primary = serverMode() ? server || cloud : cloud || server;
  return primary || new Response(JSON.stringify({ ok: false, error: '离线任务接口都没连上' }), { status: 502 });
}
