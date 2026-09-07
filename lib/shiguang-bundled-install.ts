"use client";
// 拾光随宿主发布：安装包放在 public/custom-apps/shiguang.zip，记忆库里点「打开拾光」
// 没装就装、版本旧就换包，用户不用自己拿 zip 去应用市场导入。

import { applyCustomAppRegistrationsAsync, removeCustomAppRegistrationsAsync } from "./custom-app-registration";
import { installCustomAppAsync, loadCustomAppPackage, loadInstalledCustomApps } from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

export const SHIGUANG_MANIFEST_ID = "float.shiguang";
export const SHIGUANG_BUNDLE_URL = "/custom-apps/shiguang.zip";
/** 装好后广播，桌面壳听到就摆图标。 */
export const CUSTOM_APP_INSTALLED_EVENT = "custom-app-installed";

export type ShiguangInstallResult = { app: InstalledCustomApp; action: "installed" | "updated" | "kept" };

function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

export function findInstalledShiguang(): InstalledCustomApp | undefined {
    return loadInstalledCustomApps().find(item => item.manifest.id === SHIGUANG_MANIFEST_ID);
}

export async function ensureShiguangInstalled(): Promise<ShiguangInstallResult> {
    const existing = findInstalledShiguang();
    const response = await fetch(SHIGUANG_BUNDLE_URL, { cache: "no-store" });
    if (!response.ok) {
        if (existing) return { app: existing, action: "kept" };
        throw new Error("宿主里没有拾光安装包，请更新宿主后再试。");
    }
    const file = new File([await response.blob()], "shiguang.zip", { type: "application/zip" });
    const next = await loadCustomAppPackage(file);
    if (existing && compareVersions(existing.version, next.version) >= 0) return { app: existing, action: "kept" };
    if (existing) {
        // 换包保留运行时 id，APP 自己的 db、桌面图标位置都跟着 id 走
        await removeCustomAppRegistrationsAsync(existing.id, { deleteResources: true });
        const installed = await installCustomAppAsync({ ...next, id: existing.id, installedAt: existing.installedAt, updatedAt: new Date().toISOString() });
        await applyCustomAppRegistrationsAsync(installed);
        return { app: installed, action: "updated" };
    }
    const installed = await installCustomAppAsync(next);
    await applyCustomAppRegistrationsAsync(installed);
    window.dispatchEvent(new CustomEvent(CUSTOM_APP_INSTALLED_EVENT, { detail: { app: installed } }));
    return { app: installed, action: "installed" };
}
