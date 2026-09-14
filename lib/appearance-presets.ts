// 外观预设：把当前整套外观（主题档案 + 桌面布局/组件/dock/文件夹/DIY 模板）存成多份，一键切换。
// 素材（壁纸/图标皮/字体）只存 id 引用，复用 ai_phone_theme_db_v1，绝不复制 dataURL。
// 预设 JSON 存在 KV 里：media-maintenance 扫 KV 字符串认领 assetId，引用着的素材不会被当孤儿清掉；
// 主动删除素材的几处（恢复默认、壁纸/图标/字体/dock 删除）另外用 isThemeAssetReferencedByPresets 拦。
import { kvGet, kvSet } from "./kv-db";
import { normalizeThemeProfile, type ThemeProfile } from "./theme-types";
import { collectThemeAssetIds } from "./theme-storage";
import {
    loadDesktopFolders,
    loadDockLayout,
    normalizeDesktopFolders,
    normalizeDesktopIconLayout,
    normalizeDock,
    type DesktopFolderMap,
    type DesktopIconLayout,
} from "./desktop-layout-storage";
import type { DesktopIconId } from "./desktop-config";
import { loadDIYTemplates } from "./widget-storage";
import type { DIYWidgetTemplate, WidgetInstance } from "./widget-types";

export const APPEARANCE_PRESETS_KEY = "ai_phone_appearance_presets_v1";
export const APPEARANCE_PRESET_MAX = 30;

export type AppearancePreset = {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    themeProfile: ThemeProfile;
    desktop: {
        iconLayout: DesktopIconLayout;
        widgets: WidgetInstance[];
        diyTemplates: DIYWidgetTemplate[];
        dock: DesktopIconId[];
        folders: DesktopFolderMap;
    };
};

function makeId(): string {
    return `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePreset(raw: unknown): AppearancePreset | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Partial<AppearancePreset> & { desktop?: Partial<AppearancePreset["desktop"]> };
    if (typeof item.id !== "string" || !item.id || typeof item.name !== "string") return null;
    if (!item.themeProfile || typeof item.themeProfile !== "object") return null;
    const desktop: Partial<AppearancePreset["desktop"]> = item.desktop ?? {};
    const folders = normalizeDesktopFolders(desktop.folders);
    return {
        id: item.id,
        name: item.name.trim() || "未命名预设",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
        themeProfile: normalizeThemeProfile(item.themeProfile),
        desktop: {
            iconLayout: normalizeDesktopIconLayout(desktop.iconLayout, new Set(Object.keys(folders))),
            widgets: Array.isArray(desktop.widgets) ? (desktop.widgets as WidgetInstance[]) : [],
            diyTemplates: Array.isArray(desktop.diyTemplates) ? (desktop.diyTemplates as DIYWidgetTemplate[]) : [],
            dock: normalizeDock(desktop.dock),
            folders,
        },
    };
}

export function loadAppearancePresets(): AppearancePreset[] {
    try {
        const parsed = JSON.parse(kvGet(APPEARANCE_PRESETS_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizePreset).filter((p): p is AppearancePreset => p !== null);
    } catch {
        return [];
    }
}

function persist(presets: AppearancePreset[]): void {
    kvSet(APPEARANCE_PRESETS_KEY, JSON.stringify(presets));
}

export type AppearanceSnapshot = {
    themeProfile: ThemeProfile;
    iconLayout: DesktopIconLayout;
    widgets: WidgetInstance[];
};

/** 用当前外观拍一份快照：主题档案与布局/组件由外观页传入（那是已落地的状态），其余从存储读 */
export function captureAppearanceSnapshot(input: AppearanceSnapshot): AppearancePreset["desktop"] & { themeProfile: ThemeProfile } {
    return {
        themeProfile: normalizeThemeProfile(input.themeProfile),
        iconLayout: input.iconLayout,
        widgets: input.widgets,
        diyTemplates: loadDIYTemplates(),
        dock: loadDockLayout(),
        folders: loadDesktopFolders(),
    };
}

export function saveAppearancePreset(name: string, snapshot: AppearanceSnapshot): AppearancePreset {
    const presets = loadAppearancePresets();
    if (presets.length >= APPEARANCE_PRESET_MAX) throw new Error(`最多保存 ${APPEARANCE_PRESET_MAX} 套外观预设，先删几套再存。`);
    const { themeProfile, ...desktop } = captureAppearanceSnapshot(snapshot);
    const now = Date.now();
    const preset: AppearancePreset = { id: makeId(), name: name.trim() || `预设 ${presets.length + 1}`, createdAt: now, updatedAt: now, themeProfile, desktop };
    persist([preset, ...presets]);
    return preset;
}

/** 用当前外观覆盖一套已有预设的内容，名字不变 */
export function overwriteAppearancePreset(id: string, snapshot: AppearanceSnapshot): AppearancePreset | null {
    const presets = loadAppearancePresets();
    const index = presets.findIndex((p) => p.id === id);
    if (index < 0) return null;
    const { themeProfile, ...desktop } = captureAppearanceSnapshot(snapshot);
    const next = { ...presets[index], themeProfile, desktop, updatedAt: Date.now() };
    presets[index] = next;
    persist(presets);
    return next;
}

export function renameAppearancePreset(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    persist(loadAppearancePresets().map((p) => (p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p)));
}

export function deleteAppearancePreset(id: string): void {
    persist(loadAppearancePresets().filter((p) => p.id !== id));
}

/** 任一预设还引用着这个素材：删素材的地方要跳过真删，只解除当前引用 */
export function isThemeAssetReferencedByPresets(assetId: string): boolean {
    if (!assetId) return false;
    return loadAppearancePresets().some((preset) =>
        collectThemeAssetIds(preset.themeProfile).includes(assetId)
        || preset.desktop.diyTemplates.some((template) => JSON.stringify(template).includes(assetId)),
    );
}

export function describeAppearancePreset(preset: AppearancePreset): string {
    const parts: string[] = [];
    if (preset.themeProfile.wallpaperAssetId) parts.push("壁纸");
    const skinCount = Object.values(preset.themeProfile.iconSkins).filter(Boolean).length;
    if (skinCount) parts.push(`${skinCount} 个图标皮`);
    if (preset.themeProfile.fontAssetId || preset.themeProfile.cssOverrides["--app-font-family"]) parts.push("字体");
    if (preset.desktop.widgets.length) parts.push(`${preset.desktop.widgets.length} 个组件`);
    if (Object.keys(preset.desktop.folders).length) parts.push(`${Object.keys(preset.desktop.folders).length} 个文件夹`);
    return parts.length ? parts.join(" · ") : "默认外观";
}
