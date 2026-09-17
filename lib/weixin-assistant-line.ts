// 微信自动回复跑在哪边：跟「离线执行」开关走。
//   · cloud：个人云的 weixin-assistant 云函数（pg_cron 每分钟触发）
//   · server：companion-server 自己轮询（/app/weixin，核心逻辑同一份）
// 「自动回复开着」仍记在 loadWeixinCloudScheduled（原来的云端轮询开关），开关只决定由哪边跑。
// 切换时先开新的一边、再关旧的：两边共用桶里的自动回复锁，短暂同时开着也不会重复回复。
import { loadWeixinCloudScheduled, saveWeixinCloudScheduled } from './cloud-deploy-status';
import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { companionServerUrl, loadOfflineExecutorConfig, OFFLINE_EXECUTOR_CHANGED_EVENT, personalCloudCredentials, type OfflineExecutorMode } from './offline-executor';
import { setWeixinCloudAssistantScheduled, type WeixinCloudAssistantHeartbeat } from './weixin-cloud-sync';

const USED_KEY = 'weixin_server_used_v1';
/** 最近一次确认生效的一边；没记过就是原来的云端 */
const LINE_KEY = 'weixin_assistant_line_v1';
registerKvMigration(USED_KEY);
registerKvMigration(LINE_KEY);

export type WeixinServerState = { enabled: boolean; heartbeat: WeixinCloudAssistantHeartbeat };

async function serverCall(path: '' | '/run', body?: unknown): Promise<WeixinServerState> {
  const { key } = personalCloudCredentials();
  if (!key) throw new Error('先在「云服务部署」里连上个人云');
  let res: Response;
  try {
    res = await fetch(`${companionServerUrl()}/app/weixin${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(path === '/run' ? 240_000 : 20_000),
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('连不上后端，请检查「离线执行」里的后端地址');
  }
  const data = await res.json().catch(() => null) as ({ ok?: boolean; error?: string } & Partial<WeixinServerState>) | null;
  if (res.status === 404) throw new Error('后端版本太旧，还不支持微信助手');
  if (!res.ok || !data?.ok) throw new Error(data?.error || `后端返回 HTTP ${res.status}`);
  return { enabled: data.enabled === true, heartbeat: data.heartbeat || {} };
}

export const fetchWeixinServerState = () => serverCall('');
export const runWeixinServerOnce = () => serverCall('/run', {});

async function setServer(enabled: boolean): Promise<void> {
  if (enabled) kvSet(USED_KEY, '1');
  await serverCall('', { enabled });
}

/**
 * 按开关把自动回复放到对应的一边。on 省略时沿用当前「自动回复开着」的状态。
 * 主要那边失败会抛错（状态不改）；关旧的一边失败只在返回的提示里说。
 */
export async function applyWeixinAssistantLine(on = loadWeixinCloudScheduled(), mode: OfflineExecutorMode = loadOfflineExecutorConfig().mode): Promise<string> {
  const serverUsed = kvGet(USED_KEY) === '1';
  const notes: string[] = [];
  if (on && mode === 'server') {
    await setServer(true);
    await setWeixinCloudAssistantScheduled(false).catch(() => notes.push('云端轮询没关掉（云函数没部署或连不上），两边共用回复锁，不会重复回'));
  } else if (on) {
    await setWeixinCloudAssistantScheduled(true);
    if (serverUsed) await setServer(false).catch(() => notes.push('后端轮询没关掉，两边共用回复锁，不会重复回'));
  } else if (mode === 'server') {
    await setServer(false);
    // 选后端时云端本来就该是关的，没部署云函数也正常
    await setWeixinCloudAssistantScheduled(false).catch(() => undefined);
  } else {
    await setWeixinCloudAssistantScheduled(false);
    if (serverUsed) await setServer(false).catch(() => notes.push('后端轮询没关掉'));
  }
  saveWeixinCloudScheduled(on);
  kvSet(LINE_KEY, mode);
  return notes.join('；');
}

let following = false;
let lastTry = 0;
/** 自动回复开着、但实际跑的一边和开关不一致时交接过去。启动、切开关时各看一次，失败每 5 分钟再试。 */
async function follow(force = false): Promise<void> {
  const mode = loadOfflineExecutorConfig().mode;
  if (following || !loadWeixinCloudScheduled() || (kvGet(LINE_KEY) || 'cloud') === mode) return;
  if (!force && Date.now() - lastTry < 5 * 60_000) return;
  following = true;
  lastTry = Date.now();
  try {
    await applyWeixinAssistantLine(true, mode);
  } catch (error) {
    console.warn('[weixin] 自动回复交接失败：', error);
  } finally {
    following = false;
  }
}

let installed = false;
export function installWeixinAssistantLineFollower(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(OFFLINE_EXECUTOR_CHANGED_EVENT, () => void follow(true));
  window.setInterval(() => void follow(), 60_000);
  void follow(true);
}
