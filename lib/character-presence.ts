// lib/character-presence.ts
// 角色在线状态：像 QQ 那样的一个点 + 一句话。数据不归宿主生产，来自聊天插件变量池
// （scope character）：
//   presence          挂念这类 APP 写的此刻快照 { asleep, busy, doing, label, at }
//   presenceOverride  用户在插件面板里锁定的 { state, label }，优先于快照
// 两者都没有 = 在线。快照太久没刷新（APP 没开）不敢说在线，算「离开」。

import { useSyncExternalStore } from "react";
import { getChatPluginVar, CHAT_PLUGIN_VARS_CHANGED_EVENT } from "./chat-plugin-storage";

export type PresenceState = "online" | "busy" | "sleep" | "away" | "hidden";

export type CharacterPresence = {
    state: PresenceState;
    /** 显示在名字下面的小字；空串就只有点 */
    label: string;
};

export const PRESENCE_LABELS: Record<PresenceState, string> = {
    online: "在线",
    busy: "忙碌",
    sleep: "睡觉中",
    away: "离开",
    hidden: "隐身",
};

const STALE_MS = 6 * 3600_000;
const ONLINE: CharacterPresence = { state: "online", label: "" };

function asState(v: unknown): PresenceState | null {
    return v === "online" || v === "busy" || v === "sleep" || v === "away" || v === "hidden" ? v : null;
}

export function readCharacterPresence(characterId: string, nowMs = Date.now()): CharacterPresence {
    if (!characterId) return ONLINE;
    const ov = getChatPluginVar("presenceOverride", "character", characterId);
    if (ov && typeof ov === "object") {
        const state = asState((ov as { state?: unknown }).state);
        if (state) {
            const label = String((ov as { label?: unknown }).label ?? "").trim();
            return { state, label: label || (state === "online" ? "" : PRESENCE_LABELS[state]) };
        }
    }
    const pr = getChatPluginVar("presence", "character", characterId);
    if (!pr || typeof pr !== "object") return ONLINE;
    const p = pr as { asleep?: unknown; busy?: unknown; doing?: unknown; label?: unknown; at?: unknown; state?: unknown };
    const at = Number(p.at) || 0;
    if (at && nowMs - at > STALE_MS) return { state: "away", label: PRESENCE_LABELS.away };
    const explicit = asState(p.state);
    const state: PresenceState = explicit ?? (p.asleep ? "sleep" : p.busy ? "busy" : "online");
    const custom = String(p.label ?? "").trim();
    const doing = String(p.doing ?? "").trim();
    if (state === "online") return { state, label: custom };
    return { state, label: custom || (doing ? `${PRESENCE_LABELS[state]} · ${doing}` : PRESENCE_LABELS[state]) };
}

const cache = new Map<string, { key: string; value: CharacterPresence }>();
function snapshot(characterId: string): CharacterPresence {
    const value = readCharacterPresence(characterId);
    const key = value.state + "|" + value.label;
    const hit = cache.get(characterId);
    if (hit && hit.key === key) return hit.value;
    cache.set(characterId, { key, value });
    return value;
}
function subscribe(cb: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, cb);
    // 「离开」是按快照年龄算的，没人写变量它也会变；每分钟看一眼
    const timer = window.setInterval(cb, 60_000);
    return () => { window.removeEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, cb); window.clearInterval(timer); };
}
export function useCharacterPresence(characterId: string | null | undefined): CharacterPresence {
    const id = characterId || "";
    return useSyncExternalStore(subscribe, () => (id ? snapshot(id) : ONLINE), () => ONLINE);
}
