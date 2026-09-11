"use client";

// 官方自定义 APP：仓库 custom-apps/ 随宿主发布到 /custom-apps/（见 scripts/build-custom-apps-dist.mjs）。
// 已装的官方 APP 在启动和打开时对照 index.json，落后就提示一键升级，不必再下载 zip 手动导入。
// 与市场更新（custom-app-market-update.ts）的区别：按 manifest.id 匹配、保留本机运行时 id，数据与设置原地保留。

import { applyCustomAppRegistrationsAsync, type CustomAppRegistrationSummary, removeCustomAppRegistrationsAsync } from "./custom-app-registration";
import { compareCustomAppVersions } from "./custom-app-market-update";
import { installCustomAppAsync, loadCustomAppPackage } from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

export type OfficialCustomAppEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  file: string;
};

export type OfficialCustomAppUpdateResult = {
  entry: OfficialCustomAppEntry;
  installed: InstalledCustomApp;
  registration: CustomAppRegistrationSummary;
  previousVersion: string;
};

const INDEX_URL = "/custom-apps/index.json";
let indexCache: { at: number; entries: OfficialCustomAppEntry[] } | null = null;
const INDEX_TTL_MS = 5 * 60_000;

export async function fetchOfficialCustomAppIndex(): Promise<OfficialCustomAppEntry[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.entries;
  try {
    const res = await fetch(INDEX_URL, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) return [];
    const entries = data.filter((x): x is OfficialCustomAppEntry =>
      !!x && typeof x === "object"
      && typeof (x as OfficialCustomAppEntry).id === "string"
      && typeof (x as OfficialCustomAppEntry).version === "string"
      && typeof (x as OfficialCustomAppEntry).file === "string");
    indexCache = { at: Date.now(), entries };
    return entries;
  } catch {
    return [];
  }
}

export function isOfficialCustomAppNewerThanInstalled(app: InstalledCustomApp, entry: OfficialCustomAppEntry): boolean {
  if (entry.id !== app.manifest?.id) return false;
  const compare = compareCustomAppVersions(entry.version, app.version);
  return compare === null ? entry.version.trim() !== app.version.trim() : compare > 0;
}

/** 已装 APP 里有官方新版的那些，按 index 顺序 */
export async function findOfficialCustomAppUpdates(apps: InstalledCustomApp[]): Promise<Array<{ app: InstalledCustomApp; entry: OfficialCustomAppEntry }>> {
  if (apps.length === 0) return [];
  const index = await fetchOfficialCustomAppIndex();
  const updates: Array<{ app: InstalledCustomApp; entry: OfficialCustomAppEntry }> = [];
  for (const entry of index) {
    const app = apps.find(item => item.manifest?.id === entry.id);
    if (app && isOfficialCustomAppNewerThanInstalled(app, entry)) updates.push({ app, entry });
  }
  return updates;
}

export async function findOfficialCustomAppUpdate(app: InstalledCustomApp): Promise<OfficialCustomAppEntry | null> {
  const updates = await findOfficialCustomAppUpdates([app]);
  return updates[0]?.entry ?? null;
}

async function loadOfficialCustomAppPackage(entry: OfficialCustomAppEntry): Promise<InstalledCustomApp> {
  const res = await fetch(`/custom-apps/${entry.file}?v=${encodeURIComponent(entry.version)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`下载安装包失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  const file = new File([blob], entry.file, { type: blob.type || "application/zip" });
  const app = await loadCustomAppPackage(file);
  if (app.manifest?.id !== entry.id) throw new Error("安装包里的 APP 标识与官方目录不符。");
  if (app.version !== entry.version) throw new Error("安装包版本与官方目录不符，请刷新后重试。");
  return app;
}

export async function updateInstalledCustomAppFromOfficial(app: InstalledCustomApp, entry: OfficialCustomAppEntry): Promise<OfficialCustomAppUpdateResult> {
  const nextApp = await loadOfficialCustomAppPackage(entry);
  let removedOldRegistrations = false;
  try {
    await removeCustomAppRegistrationsAsync(app.id, { deleteResources: true });
    removedOldRegistrations = true;
    const installed = await installCustomAppAsync({
      ...nextApp,
      id: app.id,
      marketItemId: app.marketItemId,
      installedAt: app.installedAt,
      updatedAt: new Date().toISOString(),
    });
    const registration = await applyCustomAppRegistrationsAsync(installed);
    return { entry, installed, registration, previousVersion: app.version };
  } catch (err) {
    if (removedOldRegistrations) {
      try {
        await installCustomAppAsync(app);
        await applyCustomAppRegistrationsAsync(app);
      } catch { /* 回滚失败时保留原错误 */ }
    }
    throw err;
  }
}
