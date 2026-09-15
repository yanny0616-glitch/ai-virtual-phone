import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// 「+」面板的显示与顺序：全局一份，所有聊天通用。
const KEY = "chat_plus_menu_v1";
registerKvMigration(KEY);

export const CHAT_PLUS_MENU_CHANGED_EVENT = "chat-plus-menu-changed";

export type PlusMenuPrefs = {
    order: string[];
    hidden: string[];
    /** 首次打开面板时已有的 APP 按钮全记进来，之后装的新 APP 按钮不在这里就带小红点 */
    seen: string[];
};

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function loadPlusMenuPrefs(): PlusMenuPrefs | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PlusMenuPrefs>;
        return { order: strings(parsed.order), hidden: strings(parsed.hidden), seen: strings(parsed.seen) };
    } catch {
        return null;
    }
}

export function savePlusMenuPrefs(prefs: PlusMenuPrefs): void {
    kvSet(KEY, JSON.stringify(prefs));
    window.dispatchEvent(new CustomEvent(CHAT_PLUS_MENU_CHANGED_EVENT));
}

/** 没排过序的按钮（新功能、新装的 APP）按原顺序接在最后，默认显示 */
export function arrangePlusMenu<T extends { id: string }>(items: T[], prefs: PlusMenuPrefs | null): { visible: T[]; rest: T[] } {
    if (!prefs) return { visible: items, rest: [] };
    const rank = new Map(prefs.order.map((id, index) => [id, index]));
    const hidden = new Set(prefs.hidden);
    const sorted = items
        .map((item, index) => ({ item, key: rank.get(item.id) ?? prefs.order.length + index }))
        .sort((a, b) => a.key - b.key)
        .map(entry => entry.item);
    return { visible: sorted.filter(item => !hidden.has(item.id)), rest: sorted.filter(item => hidden.has(item.id)) };
}

export function isFreshPlusItem(id: string, prefs: PlusMenuPrefs | null): boolean {
    return !!prefs && id.startsWith("app:") && !prefs.seen.includes(id);
}
