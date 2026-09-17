// 离线执行位置：浏览器关着时，角色的离线消息由谁来判断和生成。
//   · cloud：个人云（Supabase 云函数），原项目的做法
//   · server：自建的 companion-server 后端
// 这里是唯一的设置入口；挂念经 AiPhone.offline.getConfig() 读，按它切换自己，不再单独设开关。
// 后端认的钥匙就是个人云的 Secret key（后端拿去个人云核对），不另存。
import { isCloudBackupConfigured, loadCloudBackupConfig, normalizeBackupUrl } from './cloud-backup/config';
import { loadInstalledCustomApps, readCustomAppCollection } from './custom-app-storage';
import { kvGet, kvSet, registerKvMigration } from './kv-db';

export type OfflineExecutorMode = 'cloud' | 'server';
export type OfflineExecutorConfig = { mode: OfflineExecutorMode; serverUrl: string };

const KEY = 'offline_executor_v1';
registerKvMigration(KEY);
export const DEFAULT_COMPANION_SERVER_URL = 'https://float.yanny.top/companion';
export const OFFLINE_EXECUTOR_CHANGED_EVENT = 'offline-executor-changed';

const cleanUrl = (value: unknown) => String(value || '').trim().replace(/\/+$/, '');

function installedGuanianSettings(): Record<string, unknown>[] {
  try {
    return loadInstalledCustomApps()
      .filter(app => app.manifest.id === 'gua.nian')
      .map(app => readCustomAppCollection(app.id, 'settings')[0])
      .filter((s): s is Record<string, unknown> => !!s);
  } catch {
    return [];
  }
}

export function loadOfflineExecutorConfig(): OfflineExecutorConfig {
  try {
    const raw = kvGet(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<OfflineExecutorConfig>;
      return { mode: parsed.mode === 'server' ? 'server' : 'cloud', serverUrl: cleanUrl(parsed.serverUrl) };
    }
  } catch { /* 读坏了按没设过 */ }
  // 还没设过：挂念已经交给后端的，沿用它的选择，免得升级后被切回云端
  const guanian = installedGuanianSettings().find(s => s.serverBrain === true);
  return guanian ? { mode: 'server', serverUrl: cleanUrl(guanian.serverUrl) } : { mode: 'cloud', serverUrl: '' };
}

export function saveOfflineExecutorConfig(next: OfflineExecutorConfig): void {
  kvSet(KEY, JSON.stringify({ mode: next.mode, serverUrl: cleanUrl(next.serverUrl) }));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OFFLINE_EXECUTOR_CHANGED_EVENT));
}

export function companionServerUrl(config = loadOfflineExecutorConfig()): string {
  return config.serverUrl || DEFAULT_COMPANION_SERVER_URL;
}

/** 个人云地址和 Secret key，取自「云服务部署」；没配就是空串。 */
export function personalCloudCredentials(): { url: string; key: string } {
  const backup = loadCloudBackupConfig();
  return isCloudBackupConfigured(backup) ? { url: normalizeBackupUrl(backup.url), key: backup.key.trim() } : { url: '', key: '' };
}

/** 给挂念的：模式、后端地址、个人云地址和钥匙。 */
export function offlineConfigForApp() {
  const config = loadOfflineExecutorConfig();
  const cloud = personalCloudCredentials();
  return { mode: config.mode, serverUrl: companionServerUrl(config), cloudUrl: cloud.url, cloudKey: cloud.key };
}

/** 挂念实际停在哪边（它确认交接完才改 serverBrain），和全局选的不一样就说明还没切完。 */
export function guanianPendingSwitch(config = loadOfflineExecutorConfig()): boolean {
  const want = config.mode === 'server';
  return installedGuanianSettings().some(s => (s.serverBrain === true) !== want);
}

export async function testCompanionServer(url: string): Promise<string> {
  const { key } = personalCloudCredentials();
  if (!key) throw new Error('先在「云服务部署」里连上个人云');
  const base = cleanUrl(url) || DEFAULT_COMPANION_SERVER_URL;
  if (!/^https:\/\//.test(base)) throw new Error('后端地址要以 https:// 开头');
  const res = await fetch(`${base}/app/state?ids=`, { cache: 'no-store', headers: { Authorization: `Bearer ${key}` } });
  const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; mode?: string } | null;
  if (res.status === 401) throw new Error('后端不认这把密钥：个人云要和后端用的是同一个项目');
  if (!res.ok || !data?.ok) throw new Error(data?.error || `后端返回 HTTP ${res.status}`);
  return data.mode === 'live' ? '已连通 · 真发' : '已连通 · 影子模式';
}
