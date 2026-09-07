import { readDeferredReply, writeDeferredReply, readEffectiveReplyGate, listDeferredReplySessions, type DeferredReply } from "./chat-reply-gate";
import { isPersonalPushCloudActive, personalPushFetch, loadPersonalPushCloudState } from "./personal-push-cloud";
import { hasAccountPushSubscription } from "./push-client";
import { buildChatPromptMessages } from "./chat-engine";
import { loadChatMessages, loadChatSessions, CHAT_MESSAGE_PUSHED_EVENT } from "./chat-storage";
import { buildProviderRequest, toLlmRequestMessages } from "./llm-provider-adapter";
import { maybeAppendShortcutCapability } from "./offline-shortcut-capability";
import { getChatPluginRuntime } from "./chat-plugin-runtime";
import type { CloudReplyTiming } from "./deferred-reply-timing";

const STATUS_EVENT = "deferred-reply-cloud-status";
const locks = new Set<string>();
const notify = (sessionId: string, message: string) => window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: { sessionId, message } }));
export { STATUS_EVENT as DEFERRED_REPLY_CLOUD_STATUS_EVENT };

export function freezeDeferredReplyTiming(rec: DeferredReply): CloudReplyTiming {
    const gate = rec.characterId ? readEffectiveReplyGate(rec.characterId) : null;
    const busy = gate?.busy;
    const now = new Date();
    const dateAt = (date: string, hm: string) => new Date(`${date}T${hm}:00`).getTime();
    const sleeps: CloudReplyTiming["sleeps"] = [];
    if (gate?.sleep) {
        for (let day = -1; day < 8; day++) {
            const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
            const to = new Date(from);
            const [bh, bm] = gate.sleep.bed.split(":").map(Number);
            const [wh, wm] = gate.sleep.wake.split(":").map(Number);
            from.setHours(bh, bm, 0, 0);
            if (gate.sleep.bed > gate.sleep.wake) to.setDate(to.getDate() + 1);
            to.setHours(wh, wm, 0, 0);
            sleeps.push({ from: from.getTime(), to: to.getTime() });
        }
    }
    return {
        disabled: !gate, expiresAt: gate?.expiresAt, nextAt: gate ? rec.until : Date.now(), reason: rec.reason, windowKey: rec.busyWindowKey,
        availableUntil: rec.busyAvailableUntil, check: rec.busyCheck, note: rec.note,
        peekMin: busy?.peekMin ?? 0, adaptive: busy?.adaptive === true, probability: busy?.focusedPeekProb ?? 0,
        sleepBufferMin: gate?.sleep?.bufferMin ?? 0, sleeps,
        sleepWakeProbability: gate?.sleep?.mode === 2 ? gate.sleep.wakeProb : 0,
        windows: (busy?.windows ?? []).map(win => ({
            from: gate?.startsAt ?? dateAt(busy!.date, win.from), to: gate?.expiresAt ?? dateAt(busy!.date, win.to), title: win.title,
            key: JSON.stringify([busy!.date, busy!.adaptive === true, busy!.peekMin, busy!.focusedPeekProb ?? 0, win, gate?.startsAt, gate?.expiresAt]),
            focused: win.focused ?? /开会|会议|例会|晨会|周会|月会|上课|课堂|考试|测验|开车|驾驶|手术|面试|汇报|训练|排练|实验|演出|上台/.test(win.title),
            breaks: (win.breaks ?? []).map(p => ({ from: dateAt(busy!.date, p.from), to: dateAt(busy!.date, p.to) })),
        })),
    };
}

type Receipt = { ok?: boolean; supported?: boolean; policySupported?: boolean; silenceSupported?: boolean; status?: string; executeAt?: string; resultNote?: string; error?: string };
async function request(method: string, key?: string, payload?: unknown): Promise<Receipt> {
    const response = await personalPushFetch("deferred-reply", {
        method, ...(payload ? { body: JSON.stringify({ payload }) } : {}), signal: AbortSignal.timeout(20_000),
    }, key ? { key } : undefined);
    const result = await response.json().catch(() => null) as Receipt | null;
    if (!response.ok || !result?.ok) throw new Error(result?.error || "离线等待未同步，请检查网络和云函数版本");
    return result;
}

/** Synchronously reserve ownership before any async work; the local timer must not race the upload. */
export function queueDeferredReplyCloud(sessionId: string): void {
    const rec = readDeferredReply(sessionId);
    if (!rec || rec.firedAt || !isPersonalPushCloudActive()) return;
    const cloud = rec.cloud ?? { key: `deferred:${crypto.randomUUID()}`, projectUrl: loadPersonalPushCloudState()?.url ?? "", revision: 0, syncedRevision: 0, attempted: false, state: "syncing" as const };
    writeDeferredReply(sessionId, { ...rec, cloud: { ...cloud, revision: Math.max(Date.now(), cloud.revision + 1), state: "syncing" } });
    void sync(sessionId);
}

async function sync(sessionId: string): Promise<void> {
    if (locks.has(sessionId) || !isPersonalPushCloudActive()) return;
    let rec = readDeferredReply(sessionId);
    if (!rec?.cloud || rec.firedAt) return;
    if (rec.cloud.projectUrl !== loadPersonalPushCloudState()?.url) {
        if (rec.cloud.state !== "error") notify(sessionId, "个人云项目已切换，旧等待未转移；请先在原项目处理旧任务，避免重复回复");
        writeDeferredReply(sessionId, { ...rec, cloud: { ...rec.cloud, state: "error" } });
        return;
    }
    locks.add(sessionId);
    const key = rec.cloud.key;
    const current = () => {
        const value = readDeferredReply(sessionId);
        return value?.cloud?.key === key && !value.firedAt ? value : null;
    };
    try {
        await getChatPluginRuntime().ensureReady();
        if (rec.cloud.cancelRequested) {
            const receipt = await request("DELETE", key);
            if (receipt.status === "cancelled" || receipt.status === "missing") {
                const latest = current();
                if (latest) writeDeferredReply(sessionId, { ...latest, firedAt: Date.now(), note: "", cloud: { ...latest.cloud!, state: "cancelled" } });
                notify(sessionId, "云端等待已取消，可以再次触发回复");
            }
            return;
        }
        if (!rec.cloud.attempted) {
            const subscription = await hasAccountPushSubscription();
            const capability = subscription ? await request("GET") : null;
            if (!subscription || !capability?.supported || !capability?.policySupported) {
                const latest = current();
                if (latest && !latest.cloud!.attempted) writeDeferredReply(sessionId, { ...latest, cloud: undefined });
                notify(sessionId, subscription ? "云函数尚不支持延后回复，请更新网关和 push-generate；本轮暂由小手机等待" : "未启用离线通知，本轮暂由小手机等待");
                return;
            }
        }
        rec = current();
        if (!rec?.cloud) return;
        let receipt: Receipt;
        const revision = rec.cloud.revision;
        const updating = revision > rec.cloud.syncedRevision;
        if (updating) {
            if (rec.cloud.attempted && !(await request("GET")).policySupported) throw new Error("个人云尚不支持插件回复规则，请更新网关和 push-generate");
            const session = loadChatSessions().find(s => s.id === sessionId && !s.isGroup);
            if (!session) throw new Error("聊天会话不存在，离线等待未同步");
            const history = loadChatMessages(sessionId);
            const { llmMessages, character, config, preset, regexes, userIdentity, allowSilence } = await buildChatPromptMessages(session, history, { appTags: ["chat", "text"] });
            if (allowSilence && !(await request("GET")).silenceSupported) throw new Error("请更新支持沉默结果的个人云网关和 push-generate");
            maybeAppendShortcutCapability(llmMessages, { continuationAvailable: false });
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
            const latest = current();
            if (!latest?.cloud || latest.cloud.cancelRequested) return;
            // Mark before POST: a lost response must never cause a second local generation.
            writeDeferredReply(sessionId, { ...latest, cloud: { ...latest.cloud, attempted: true } });
            const lastUser = [...history].reverse().find(m => m.role === "user");
            receipt = await request("POST", key, {
                request: { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind },
                deferredReply: { revision, timing: freezeDeferredReplyTiming(latest) },
                allowSilence,
                silenceThinkingTag: preset?.online_thinking_tag,
                notify: { title: character.name, url: "/", characterId: character.id },
                merge: { sessionId, prevCount: 0, regexes, characterName: character.name, userName: userIdentity?.name ?? "用户",
                    appId: "chat", appTags: ["chat", "text"], armAt: new Date().toISOString(),
                    ...(lastUser ? { replyAfterLocalMessageId: lastUser.id, replyAfterCreatedAt: lastUser.createdAt } : {}) },
            });
        } else receipt = await request("GET", key);
        const latest = current();
        if (!latest?.cloud) return;
        if (receipt.status === "missing") {
            // Keep ownership until an idempotent retry confirms the cloud state.
            writeDeferredReply(sessionId, { ...latest, cloud: { ...latest.cloud, syncedRevision: 0, state: "syncing" } });
            return;
        }
        if (["done", "failed", "cancelled"].includes(receipt.status ?? "")) {
            writeDeferredReply(sessionId, { ...latest, firedAt: Date.now(), note: "", cloud: { ...latest.cloud, state: receipt.status as "done" | "failed" | "cancelled" } });
            if (receipt.status === "failed") notify(sessionId, "云端延后回复失败，可重新触发回复；详情见云端任务日志");
            else if (updating && receipt.status === "done" && receipt.resultNote !== "reply silenced") notify(sessionId, "上一轮已生成，刚补充的内容未合并；可再次触发回复");
            return;
        }
        const synced = receipt.status === "pending" && updating;
        writeDeferredReply(sessionId, { ...latest, until: Date.parse(receipt.executeAt ?? "") || latest.until,
            cloud: { ...latest.cloud, syncedRevision: synced ? revision : latest.cloud.syncedRevision,
                state: receipt.status === "running" ? "running" : "active" } });
        if (synced && latest.cloud.revision === revision && !latest.cloud.cancelRequested) notify(sessionId, "等待已同步云端，关闭小手机后仍会继续；补充消息和 API 配置已更新");
    } catch {
        const latest = current();
        if (latest?.cloud) {
            if (!latest.cloud.attempted) {
                writeDeferredReply(sessionId, { ...latest, cloud: undefined });
                notify(sessionId, "尚未建立云端等待，本轮仍需保持小手机开启；请检查云部署和网络");
                return;
            }
            const firstError = latest.cloud.state !== "error";
            writeDeferredReply(sessionId, { ...latest, cloud: { ...latest.cloud, state: "error" } });
            if (firstError) notify(sessionId, "离线等待同步未确认，请检查网络和云函数版本并保持小手机开启以重试；暂不另发，避免重复回复");
        }
    } finally { locks.delete(sessionId); }
    const latest = current();
    if (latest?.cloud?.state === "active" && latest.cloud.revision > latest.cloud.syncedRevision) void sync(sessionId);
}

/** Urgent messages can bypass waiting only after cloud cancellation is confirmed. */
export async function cancelDeferredReplyCloud(sessionId: string): Promise<boolean> {
    const rec = readDeferredReply(sessionId);
    if (!rec?.cloud) return true;
    if (rec.cloud.projectUrl !== loadPersonalPushCloudState()?.url) {
        notify(sessionId, "请切回原个人云项目确认取消旧等待");
        return false;
    }
    writeDeferredReply(sessionId, { ...rec, cloud: { ...rec.cloud, cancelRequested: true } });
    try {
        const receipt = await request("DELETE", rec.cloud.key);
        if (!["cancelled", "missing", "done", "failed"].includes(receipt.status ?? "")) {
            notify(sessionId, "云端已开始处理本轮，等这次回复完成后再发送");
            return false;
        }
        const latest = readDeferredReply(sessionId);
        if (latest?.cloud?.key === rec.cloud.key) writeDeferredReply(sessionId, null);
        return true;
    } catch { notify(sessionId, "尚未确认取消云端等待，请联网后再触发，避免两边重复回复"); return false; }
}

let installed = false;
export function installDeferredReplyCloudSync(): void {
    if (installed) return;
    installed = true;
    const tick = () => { for (const id of listDeferredReplySessions()) void sync(id); };
    const refresh = () => {
        for (const id of listDeferredReplySessions()) {
            const rec = readDeferredReply(id);
            if (rec && !rec.firedAt && rec.characterId && !readEffectiveReplyGate(rec.characterId)) {
                writeDeferredReply(id, { ...rec, until: Date.now() });
            }
            queueDeferredReplyCloud(id);
        }
    };
    for (const event of ["settings-api-configs-updated", "settings-bindings-updated", "settings-presets-updated", "reply-gate-updated", "reply-policy-updated"]) window.addEventListener(event, refresh);
    window.addEventListener("chat-plugin-vars-changed", event => {
        const data = (event as CustomEvent<{ name?: string }>).detail;
        if (data?.name === "presenceOverride") refresh();
    });
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, event => {
        const message = (event as CustomEvent<{ message?: { role: string; sessionId: string } }>).detail?.message;
        if (message?.role === "user") queueDeferredReplyCloud(message.sessionId);
    });
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", tick);
    window.setInterval(tick, 20_000);
    void getChatPluginRuntime().ensureReady().then(refresh);
}
