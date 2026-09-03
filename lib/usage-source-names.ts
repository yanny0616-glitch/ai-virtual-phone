// lib/usage-source-names.ts
// 用量统计里的 source 就是发起方的 appId。APP 端不该自己维护一张 id→中文名的表：
// 新增内置 APP 或用户装了自定义 APP，表没跟上就只能显示英文 id。名字宿主全都有，
// 这里统一解析，随 usage.readDaily / readLogs 一起发给 APP。

import { ICONS, type IconId } from "./desktop-config";
import { loadInstalledCustomApps } from "./custom-app-storage";

/** 不对应桌面图标的来源：后台功能与工坊没有 APP 入口，查手机的子页面共用一个图标 */
const EXTRA_LABELS: Record<string, string> = {
    background: "后台功能",
    qa: "工坊",
    // 查手机的子页面：引擎侧带 checkphone_ 前缀，页面侧直接用裸 id，两条路都要认
    weibo: "查手机 · 微博",
    douban: "查手机 · 豆瓣",
    bilibili: "查手机 · 哔哩哔哩",
    douyin: "查手机 · 抖音",
    x: "查手机 · X",
    telegram: "查手机 · Telegram",
    instagram: "查手机 · Instagram",
    reddit: "查手机 · Reddit",
    steam: "查手机 · Steam",
    youtube: "查手机 · YouTube",
    takeout: "查手机 · 外卖",
    messages: "查手机 · 短信",
    phone: "查手机 · 通话",
    notes: "查手机 · 备忘录",
    photos: "查手机 · 相册",
    email: "查手机 · 邮件",
    browser: "查手机 · 浏览器",
    assets: "查手机 · 文件",
    manifest: "查手机 · 概览",
    shopping_search: "购物 · 搜索",
    add_friend: "加好友",
};

function builtinLabel(id: string): string | null {
    const meta = (ICONS as Record<string, { label?: string }>)[id as IconId];
    return meta?.label || null;
}

/** 把一个 source 解析成给人看的名字；实在认不出就原样返回 id，不猜 */
export function resolveUsageSourceName(source: string): string {
    const id = source || "chat";
    if (EXTRA_LABELS[id]) return EXTRA_LABELS[id];
    const builtin = builtinLabel(id);
    if (builtin) return builtin;
    if (id.startsWith("checkphone_")) {
        const sub = id.slice("checkphone_".length);
        return EXTRA_LABELS[sub] || `查手机 · ${builtinLabel(sub) || sub}`;
    }
    if (id.startsWith("custom_app:")) {
        const appId = id.slice("custom_app:".length);
        const app = loadInstalledCustomApps().find(item => item.id === appId);
        return app?.name || `APP · ${appId}`;
    }
    return id;
}

/** 给一批 source 生成 id→名字 的字典，随用量数据一起下发 */
export function resolveUsageSourceNames(sources: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const source of sources) {
        const id = source || "chat";
        if (!out[id]) out[id] = resolveUsageSourceName(id);
    }
    return out;
}
