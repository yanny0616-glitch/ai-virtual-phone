// lib/character-presence.ts
// 角色在线状态：像 QQ 那样的一个点 + 一句话。数据不归宿主生产，来自聊天插件变量池
// （scope character）：
//   presence          挂念这类 APP 写的此刻快照 { asleep, busy, doing, label, at }
//   presenceOverride  用户在插件面板里锁定的 { state, label }，优先于快照
// 快照只是 APP 同步那一刻的样子；真正的作息（睡眠窗 + 今天的忙时段）APP 已经用
// chat.setReplyGate 留在宿主里了，这里按当前时间实时算，APP 不开也能准时变色。
// 什么都没有 = 在线；只有一份过期快照 = 「离开」。

import { useSyncExternalStore } from "react";
import { getChatPluginVar, CHAT_PLUGIN_VARS_CHANGED_EVENT } from "./chat-plugin-storage";
import { readReplyGate } from "./chat-reply-gate";

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

function hm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 按宿主里存的作息实时判：睡着 / 忙着（带标题）/ 空着；没有作息返回 null */
function liveFromGate(characterId: string, nowMs: number): CharacterPresence | null {
    const gate = readReplyGate(characterId);
    if (!gate) return null;
    const now = new Date(nowMs);
    const cur = hm(now);
    const sleep = gate.sleep;
    if (sleep && sleep.bed !== sleep.wake) {
        const asleep = sleep.bed > sleep.wake ? (cur >= sleep.bed || cur < sleep.wake) : (cur >= sleep.bed && cur < sleep.wake);
        if (asleep) return { state: "sleep", label: PRESENCE_LABELS.sleep };
    }
    const busy = gate.busy;
    if (busy && busy.date === ymd(now)) {
        const win = busy.windows.find(w => cur >= w.from && cur < w.to);
        if (win) return { state: "busy", label: win.title ? `${PRESENCE_LABELS.busy} · ${win.title}` : PRESENCE_LABELS.busy };
    }
    return { state: "online", label: "" };
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
    const p = pr && typeof pr === "object" ? pr as { asleep?: unknown; busy?: unknown; doing?: unknown; label?: unknown; at?: unknown; state?: unknown } : null;
    const at = p ? Number(p.at) || 0 : 0;
    const fresh = !!p && (!at || nowMs - at <= STALE_MS);

    const live = liveFromGate(characterId, nowMs);
    if (live) {
        // 作息说空着、快照又新鲜，就把快照里「正在做什么」带上，光一个绿点太干
        if (live.state === "online" && fresh && p) {
            const custom = String(p.label ?? "").trim();
            const doing = String(p.doing ?? "").trim();
            return { state: "online", label: custom || (doing && !p.asleep ? doing : "") };
        }
        return live;
    }
    if (!p) return ONLINE;
    if (!fresh) return { state: "away", label: PRESENCE_LABELS.away };
    const explicit = asState(p.state);
    const state: PresenceState = explicit ?? (p.asleep ? "sleep" : p.busy ? "busy" : "online");
    const custom = String(p.label ?? "").trim();
    const doing = String(p.doing ?? "").trim();
    if (state === "online") return { state, label: custom || doing };
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
