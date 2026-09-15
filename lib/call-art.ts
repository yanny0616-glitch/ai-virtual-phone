import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// 通话立绘和场景：按角色存，所有和 TA 的通话共用。图片本身存在聊天图片库里，这里只记 id。
const KEY = "call_art_v1";
registerKvMigration(KEY);

export const CALL_ART_CHANGED_EVENT = "call-art-changed";

export type CallArtKind = "portrait" | "scene";
export type CallArt = { id: string; name: string; category: string; image: string };
export type CallArtLibrary = { portraits: CallArt[]; scenes: CallArt[]; defaultPortrait?: string; defaultScene?: string };

const EMPTY: CallArtLibrary = { portraits: [], scenes: [] };

function loadAll(): Record<string, CallArtLibrary> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed as Record<string, CallArtLibrary> : {};
    } catch {
        return {};
    }
}

export function loadCallArt(characterId: string): CallArtLibrary {
    const lib = loadAll()[characterId];
    return lib ? { ...EMPTY, ...lib, portraits: lib.portraits ?? [], scenes: lib.scenes ?? [] } : { ...EMPTY };
}

export function saveCallArt(characterId: string, lib: CallArtLibrary): void {
    const all = loadAll();
    all[characterId] = lib;
    kvSet(KEY, JSON.stringify(all));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CALL_ART_CHANGED_EVENT, { detail: { characterId } }));
}

export const callArtItems = (lib: CallArtLibrary, kind: CallArtKind): CallArt[] => (kind === "portrait" ? lib.portraits : lib.scenes);

export function defaultCallArt(lib: CallArtLibrary, kind: CallArtKind): CallArt | null {
    const items = callArtItems(lib, kind);
    const id = kind === "portrait" ? lib.defaultPortrait : lib.defaultScene;
    return items.find(item => item.id === id) ?? items[0] ?? null;
}

/** 名字对不上时退一步用包含关系，「开心一点」也能找到「开心」 */
export function findCallArt(lib: CallArtLibrary, kind: CallArtKind, name: string): CallArt | null {
    const want = name.trim();
    if (!want) return null;
    const items = callArtItems(lib, kind);
    return items.find(item => item.name === want)
        ?? items.find(item => want.includes(item.name) || item.name.includes(want))
        ?? null;
}

/** 在线状态插件 / 挂念写的 presence：{ place, doing, step, label, ... }，哪段文字里出现了场景名就用哪个 */
export function sceneForPresence(lib: CallArtLibrary, presence: unknown): CallArt | null {
    if (!presence || typeof presence !== "object" || !lib.scenes.length) return null;
    const record = presence as Record<string, unknown>;
    const texts = ["place", "doing", "step", "label", "text", "activity"]
        .map(key => record[key])
        .filter((value): value is string => typeof value === "string" && !!value.trim());
    for (const text of texts) {
        const hit = lib.scenes.find(scene => scene.name && text.includes(scene.name));
        if (hit) return hit;
    }
    return null;
}
