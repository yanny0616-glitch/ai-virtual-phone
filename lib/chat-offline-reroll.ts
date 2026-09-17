import { kvGet, kvSet } from "./kv-db";
import type { ChatOfflineTurn } from "./chat-offline-storage";

// 线下「重试以下」的回复版本。和线上一样：被重试掉的那一截存成一版，可以换回来。
// 线下一轮 = 用户输入 + 正文 + 摘要，换版本时摘要跟着换（挂念等读的是摘要）。
const VERSIONS_KEY = "ai_phone_chat_offline_reply_versions_v1";
const MAX_VERSIONS = 8;

type OfflineReplyVersion = { createdAt: string; turns: ChatOfflineTurn[] | null };
export type OfflineReplyVersionSet = {
    anchorId: string | null;
    versions: OfflineReplyVersion[];
    active: number;
    /** 正在用的那版现在存储里的轮次 id；和存储对不上说明用户又聊了或删改过，版本作废 */
    activeIds: string[];
};
export type OfflineReplyVersionView = { index: number; createdAt: string; lines: string[]; active: boolean };

function loadStore(): Record<string, OfflineReplyVersionSet> {
    try {
        const raw = kvGet(VERSIONS_KEY);
        const store = raw ? JSON.parse(raw) as unknown : null;
        return store && typeof store === "object" && !Array.isArray(store) ? store as Record<string, OfflineReplyVersionSet> : {};
    } catch {
        return {};
    }
}

function writeSet(sessionId: string, set: OfflineReplyVersionSet | null): void {
    const store = loadStore();
    if (set) store[sessionId] = set;
    else if (store[sessionId]) delete store[sessionId];
    else return;
    kvSet(VERSIONS_KEY, JSON.stringify(store));
}

function tailAfterAnchor(turns: ChatOfflineTurn[], anchorId: string | null): ChatOfflineTurn[] | null {
    if (anchorId === null) return turns;
    const index = turns.findIndex(turn => turn.id === anchorId);
    return index < 0 ? null : turns.slice(index + 1);
}

function sameIds(turns: ChatOfflineTurn[], ids: string[]): boolean {
    return turns.length === ids.length && turns.every((turn, i) => turn.id === ids[i]);
}

/** turns 须为会话全量且已排序；之后又聊了、删了或锚点没了返回 null。 */
export function getLiveOfflineReplyVersions(sessionId: string, turns: ChatOfflineTurn[]): { set: OfflineReplyVersionSet; tail: ChatOfflineTurn[] } | null {
    const set = loadStore()[sessionId];
    if (!set || !Array.isArray(set.versions) || set.versions.length < 2 || !Array.isArray(set.activeIds)) return null;
    const tail = tailAfterAnchor(turns, set.anchorId);
    if (!tail || tail.length === 0 || !sameIds(tail, set.activeIds)) return null;
    return { set, tail };
}

/** 重试删除前调用：被删的一截存成一版，新生成占住「正在用」（成功后 finish 记下新轮次）。返回失败时用的回滚。 */
export function recordOfflineReplyVersionBeforeRetry(sessionId: string, turns: ChatOfflineTurn[], targetIndex: number): { finish: (saved: ChatOfflineTurn) => void; rollback: () => void } {
    const before = loadStore()[sessionId] ?? null;
    const removed = turns.slice(targetIndex);
    const anchorId = targetIndex > 0 ? turns[targetIndex - 1].id : null;
    const now = new Date().toISOString();
    const live = getLiveOfflineReplyVersions(sessionId, turns);
    let set: OfflineReplyVersionSet;
    if (live && live.set.anchorId === anchorId) {
        const versions = live.set.versions.map((v, i) => (i === live.set.active ? { ...v, turns: removed } : v));
        versions.push({ createdAt: now, turns: null });
        set = { anchorId, versions, active: versions.length - 1, activeIds: [] };
    } else {
        set = { anchorId, versions: [{ createdAt: removed[0]?.createdAt ?? now, turns: removed }, { createdAt: now, turns: null }], active: 1, activeIds: [] };
    }
    while (set.versions.length > MAX_VERSIONS) {
        set.versions.shift();
        set.active -= 1;
    }
    writeSet(sessionId, set);
    return {
        finish: saved => {
            const current = loadStore()[sessionId];
            if (current && current.anchorId === anchorId) writeSet(sessionId, { ...current, activeIds: [saved.id] });
        },
        rollback: () => writeSet(sessionId, before),
    };
}

export function describeOfflineReplyVersions(live: { set: OfflineReplyVersionSet; tail: ChatOfflineTurn[] }): OfflineReplyVersionView[] {
    return live.set.versions.map((version, index) => ({
        index,
        createdAt: version.createdAt,
        lines: (version.turns ?? live.tail).map(turn => turn.assistantContent.trim()).filter(Boolean),
        active: index === live.set.active,
    }));
}

/** 换版本：返回换好后的全量轮次（调用方保存），并写入版本记录。 */
export function switchOfflineReplyVersion(sessionId: string, turns: ChatOfflineTurn[], target: number): ChatOfflineTurn[] | null {
    const live = getLiveOfflineReplyVersions(sessionId, turns);
    if (!live || target === live.set.active || !live.set.versions[target]) return null;
    const restore = live.set.versions[target].turns ?? [];
    const kept = turns.slice(0, turns.length - live.tail.length);
    const versions = live.set.versions.map((v, i) => {
        if (i === live.set.active) return { ...v, turns: live.tail };
        if (i === target) return { ...v, turns: null };
        return v;
    });
    writeSet(sessionId, { ...live.set, versions, active: target, activeIds: restore.map(turn => turn.id) });
    return [...kept, ...restore];
}
