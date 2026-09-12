// 离线推送·回端合并：App 打开/回前台时拉取服务端生成的原始输出，
// 用客户端同一条解析管线（回复插件 → 思维链提取 → 输出正则 → parseAndSaveResponse）落进聊天记录。

import { parseCloudThinking, resolveCloudThinkingConfig, type CloudThinkingConfig } from "./cloud-reply-thinking";
import { parseAndSaveResponse, scheduleFollowUp } from "./follow-up-service";
import { applyOutputRegex } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { stripHallucinatedTimestamps } from "./llm-provider-adapter";
import { MacroEngine } from "./macro-engine";
import { getActiveAppTags } from "./content-tag-utils";
import { loadChatMessages, loadChatSessions, hasPersistedResponseBatch, refreshChatSessionFromDisk } from "./chat-storage";
import { settleDeferredReplyDelivery } from "./deferred-reply-cloud";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";
import { removeTimedWakeSchedule } from "./timed-wake-storage";
import { closeChatPushNotifications } from "./notification-avatar-cache";
import { appendBridgeFeed } from "./reality-bridge/storage";
import { saveScreenChatAck } from "./reality-bridge/storage";
import { getChatPluginRuntime } from "./chat-plugin-runtime";
import { runChatPluginTransform } from "./chat-plugin-hooks";

type OutboxEntry = {
    id: string;
    session_id: string | null;
    trigger_key: string | null;
    raw_text: string;
    meta: {
        sessionId?: string;
        onlineThinking?: CloudThinkingConfig;
        reasoningText?: string;
        followUpIndex?: number;
        prevCount?: number;
        regexes?: RegexConfig[];
        characterName?: string;
        userName?: string;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        silentUpdate?: boolean;
        armAt?: string;
        replyAfterLocalMessageId?: string;
        /** 云端触发快捷动作失败的摘要；成功时不带这个字段 */
        shortcutDeliveryError?: string;
    } | null;
    created_at: string;
};

let consuming = false;
let lastConsumeAt = 0;
let consumerInstalled = false;
let consumeRequestTimer: number | null = null;
let consumeRequestForce = false;
const OUTBOX_BATCH_SIZE = 20;
const MAX_OUTBOX_BATCHES_PER_PASS = 10;
const OUTBOX_FOREGROUND_CHECK_INTERVAL_MS = 20_000;
let outboxChannel: BroadcastChannel | null = null;

function getTimedWakeIdFromTriggerKey(triggerKey: string | null): string | null {
    if (!triggerKey?.startsWith("timedwake:")) return null;
    const id = triggerKey.slice("timedwake:".length);
    return id.trim() || null;
}

function clearTimedWakeIfHandled(triggerKey: string | null): void {
    const timedWakeId = getTimedWakeIdFromTriggerKey(triggerKey);
    if (timedWakeId) removeTimedWakeSchedule(timedWakeId);
}

// 写盘/回执失败的同页重试复用 llm.response 结果，避免重复结算好感等插件状态。
const transformedOutboxResponses = new Map<string, { raw: string; text: string; entryId: string }>();
async function transformOutboxResponse(rawText: string, sessionId: string, appId = "chat", entryId = ""): Promise<string> {
    const key = `${sessionId}:${entryId}`;
    const cached = transformedOutboxResponses.get(key);
    if (cached?.raw === rawText) return cached.text;
    const result = await runChatPluginTransform("llm.response", { text: rawText.trim(), sessionId, purpose: appId });
    const text = stripHallucinatedTimestamps(typeof result.text === "string" ? result.text : rawText.trim());
    transformedOutboxResponses.set(key, { raw: rawText, text, entryId });
    return text;
}

export async function consumeServerOutbox(options?: { silent?: boolean; force?: boolean }): Promise<void> {
    if (typeof window === "undefined") return;
    // 共享回传箱已紧急停用：没有个人 Supabase 时直接结束，不请求 status/outbox。
    if (!isPersonalPushCloudActive()) return;
    if (consuming) return;
    if (options?.force !== true && Date.now() - lastConsumeAt < OUTBOX_FOREGROUND_CHECK_INTERVAL_MS) return;
    consuming = true;
    lastConsumeAt = Date.now();
    try {
        // A page-local boolean cannot arbitrate a shared IndexedDB. Browser
        // locks remain held throughout asynchronous parsing/commit/ack and are
        // released if the owning page exits. Never use an expiring timer lease.
        if (typeof navigator === "undefined" || !navigator.locks?.request) throw new Error("当前浏览器不支持跨页面安全收取，请更新浏览器后重试；云端消息已保留。");
        await navigator.locks.request("ai-phone:outbox-consumer", { ifAvailable: true }, async lock => {
        if (!lock) return;
        // 冷启动时先等启用的插件注册完，再消费回传，避免 [内心] 被原生解析器抢走。
        await getChatPluginRuntime().ensureStarted();
        // 共享回传箱已停用，只读取用户自己的 Supabase。
        const sources: Array<"personal" | "shared"> = ["personal"];
        const handledEntryIds = new Set<string>();
        for (const source of sources) {
          for (let batch = 0; batch < MAX_OUTBOX_BATCHES_PER_PASS; batch += 1) {
            const response = await (source === "personal"
                ? personalPushFetch("outbox", { signal: AbortSignal.timeout(15_000) })
                : fetch("/api/push/outbox", { credentials: "include", signal: AbortSignal.timeout(15_000) }))
                .catch(() => null);
            if (!response || !response.ok) break;
            const data = await response.json().catch(() => ({})) as { ok?: boolean; entries?: OutboxEntry[] };
            const entries = data.ok && Array.isArray(data.entries) ? data.entries : [];
            if (entries.length === 0) break;

            const consumedIds: string[] = [];
            for (const entry of entries) {
                try {
                    if (handledEntryIds.has(entry.id)) {
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const meta = entry.meta || {};
                    const diskSessionId = meta.sessionId || entry.session_id || (meta as { reply?: { sessionId?: string } }).reply?.sessionId;
                    if (diskSessionId) await refreshChatSessionFromDisk(diskSessionId);

                    if ((meta as { kind?: string }).kind === "bridge") {
                        const bridgeMeta = meta as Record<string, unknown> & {
                            reply?: { onlineThinking?: CloudThinkingConfig; reasoningText?: string; sessionId?: string; regexes?: RegexConfig[]; characterName?: string; userName?: string; appId?: string; appTags?: string[] } | null;
                            screenChat?: boolean;
                            screenChatCharacterId?: string;
                            screenChatSequence?: number;
                            screenChatResponseBatchId?: string;
                            screenChatAssistantAt?: string;
                        };
                        const engine = await import("./reality-bridge/engine");
                        const applied = await engine.applyServerBridgeEntry(bridgeMeta as Parameters<typeof engine.applyServerBridgeEntry>[0]);
                        const replyMeta = bridgeMeta.reply || null;
                        const replySessionId = applied.sessionId || replyMeta?.sessionId || "";
                        if (entry.raw_text.trim() && replySessionId) {
                            const responseBatchId = typeof bridgeMeta.screenChatResponseBatchId === "string" && bridgeMeta.screenChatResponseBatchId
                                ? bridgeMeta.screenChatResponseBatchId
                                : `push-outbox:${entry.id}`;
                            const existing = loadChatMessages(replySessionId);
                            const alreadyImported = await hasPersistedResponseBatch(replySessionId, responseBatchId);
                            if (!alreadyImported) {
                                let text = await transformOutboxResponse(entry.raw_text, replySessionId, replyMeta?.appId, entry.id);
                                const thinking = parseCloudThinking(text, resolveCloudThinkingConfig(replySessionId, replyMeta?.appId, replyMeta?.onlineThinking));
                                text = thinking.text;
                                const regexes = Array.isArray(replyMeta?.regexes) ? replyMeta.regexes : [];
                                if (regexes.length > 0) {
                                    const macroEngine = new MacroEngine(replyMeta?.characterName ?? "", replyMeta?.userName ?? "用户");
                                    const activeTags = getActiveAppTags(replyMeta?.appId ?? "chat", { appTags: replyMeta?.appTags });
                                    text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                                }
                                const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                                    text,
                                    replySessionId,
                                    0,
                                    undefined,
                                    existing,
                                    {
                                        durable: true,
                                        silent: options?.silent !== false,
                                        responseBatchId,
                                        createdAt: bridgeMeta.screenChatAssistantAt,
                                        rawResponseText: entry.raw_text,
                                        reasoningText: thinking.reasoningText ?? replyMeta?.reasoningText,
                                    },
                                );
                                if (hasVisible && newCount < 10) scheduleFollowUp(replySessionId, newCount, stateValues);
                            }
                        }
                        if (
                            bridgeMeta.screenChat === true
                            && typeof bridgeMeta.screenChatCharacterId === "string"
                            && Number.isSafeInteger(bridgeMeta.screenChatSequence)
                        ) {
                            saveScreenChatAck(bridgeMeta.screenChatCharacterId, Number(bridgeMeta.screenChatSequence));
                        }
                        consumedIds.push(entry.id);
                        handledEntryIds.add(entry.id);
                        continue;
                    }
                    // 云端触发快捷动作失败的诊断行，不是角色消息——写进现实桥动态后直接消费掉，
                    // 绝不能走下面的建消息流程，否则聊天里会凭空多出一条。
                    if ((meta as { kind?: string }).kind === "shortcut_delivery_error") {
                        const detail = typeof meta.shortcutDeliveryError === "string"
                            ? meta.shortcutDeliveryError
                            : entry.raw_text;
                        try {
                            appendBridgeFeed({
                                id: `shortcut_fail_${entry.id}`,
                                type: "快捷动作",
                                payload: detail,
                                rules: [],
                                actions: [],
                                error: detail,
                                receivedAt: new Date().toISOString(),
                            });
                        } catch { /* 动态写失败不影响其余条目消费 */ }
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const sessionId = meta.sessionId || entry.session_id || "";
                    const session = sessionId ? loadChatSessions().find(s => s.id === sessionId) : undefined;
                    if (!session) {
                        console.warn("[PushOutbox] session not found, keep entry pending:", entry.id, sessionId);
                        continue;
                    }

                    const periodCare = (meta as { periodCare?: { characterId?: string; cycleKey?: string } }).periodCare;
                    if (periodCare?.characterId && periodCare.cycleKey) {
                        const { saveMenstrualPeriodCareTrigger } = await import("./menstrual-storage");
                        saveMenstrualPeriodCareTrigger({ characterId: periodCare.characterId, sessionId, cycleKey: periodCare.cycleKey });
                    }

                    const idleMeta = (meta as { idleReconnect?: { ruleId?: string; firedAt?: number } }).idleReconnect;
                    if (idleMeta?.ruleId) {
                        const { markIdleReconnectFired } = await import("./idle-reconnect-storage");
                        markIdleReconnectFired(idleMeta.ruleId, typeof idleMeta.firedAt === "number" ? idleMeta.firedAt : Date.now());
                    }

                    const followUpIndex = typeof meta.followUpIndex === "number" ? meta.followUpIndex : undefined;
                    const existingMessages = loadChatMessages(sessionId);
                    // 回执确认失败时可能再次拉到同一条；先查持久批次，避免插件重复结算好感。
                    const responseBatchId = `push-outbox:${entry.id}`;
                    if (await hasPersistedResponseBatch(sessionId, responseBatchId)) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        settleDeferredReplyDelivery(sessionId, entry.trigger_key, meta.replyAfterLocalMessageId);
                        consumedIds.push(entry.id);
                        handledEntryIds.add(entry.id);
                        continue;
                    }
                    let text = await transformOutboxResponse(entry.raw_text, sessionId, meta.appId, entry.id);
                    const thinking = parseCloudThinking(text, resolveCloudThinkingConfig(sessionId, meta?.appId, meta?.onlineThinking));
                    text = thinking.text;
                    const regexes = Array.isArray(meta.regexes) ? meta.regexes : [];
                    if (regexes.length > 0) {
                        const macroEngine = new MacroEngine(meta.characterName ?? "", meta.userName ?? "用户");
                        const activeTags = getActiveAppTags(meta.appId ?? "chat", { appTags: meta.appTags, followUpCount: meta.followUpCount });
                        text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                    }

                    // 云端执行过的快捷动作标记：原位落一对 tool_call/tool_notice，UI 显示与本机直接调用一致
                    const rawMarker = (meta as { shortcutMarker?: { text?: unknown; insertAt?: unknown; name?: unknown } }).shortcutMarker;
                    const shortcutMarker = rawMarker
                        && typeof rawMarker.text === "string" && rawMarker.text
                        && typeof rawMarker.name === "string" && rawMarker.name
                        ? {
                            text: rawMarker.text,
                            insertAt: typeof rawMarker.insertAt === "number" && Number.isFinite(rawMarker.insertAt)
                                ? rawMarker.insertAt
                                : Number.MAX_SAFE_INTEGER,
                            name: rawMarker.name,
                        }
                        : undefined;
                    const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                        text,
                        sessionId,
                        meta.prevCount ?? 0,
                        followUpIndex,
                        existingMessages,
                        {
                            durable: true,
                            silent: options?.silent !== false,
                            suppressReply: meta.silentUpdate === true,
                            rawResponseText: entry.raw_text,
                            reasoningText: thinking.reasoningText ?? meta.reasoningText,
                            responseBatchId,
                            // 补收时间不是角色发送时间；无效旧数据交给解析器使用本地时间兜底。
                            createdAt: Number.isFinite(Date.parse(entry.created_at)) ? entry.created_at : undefined,
                            ...(shortcutMarker ? { shortcutMarker } : {}),
                        },
                    );
                    if (hasVisible && newCount < 10) scheduleFollowUp(sessionId, newCount, stateValues);
                    clearTimedWakeIfHandled(entry.trigger_key);
                    settleDeferredReplyDelivery(sessionId, entry.trigger_key, meta.replyAfterLocalMessageId);
                    consumedIds.push(entry.id);
                    handledEntryIds.add(entry.id);
                } catch (err) {
                    console.warn("[PushOutbox] merge failed for entry:", entry.id, err);
                    // 屏幕速聊各轮有严格因果顺序；前一轮未合并时不能越过它消费后一轮。
                    if ((entry.meta as { screenChat?: boolean } | null)?.screenChat === true) break;
                }
            }

            if (consumedIds.length === 0) break;
            for (const entry of entries.filter(entry => consumedIds.includes(entry.id))) {
                const sessionId = entry.meta?.sessionId || entry.session_id || (entry.meta as { reply?: { sessionId?: string } } | null)?.reply?.sessionId;
                if (sessionId) outboxChannel?.postMessage({ sessionId });
            }
            const ackInit: RequestInit = {
                signal: AbortSignal.timeout(15_000),
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: consumedIds }),
            };
            const ackResponse = await (source === "personal"
                ? personalPushFetch("outbox", ackInit)
                : fetch("/api/push/outbox", { ...ackInit, credentials: "include" }))
                .catch(() => null);
            if (!ackResponse || !ackResponse.ok) break;
            const acknowledged = new Set(consumedIds);
            for (const [key, cached] of transformedOutboxResponses) {
                if (acknowledged.has(cached.entryId)) transformedOutboxResponses.delete(key);
            }
            if (entries.length < OUTBOX_BATCH_SIZE) break;
          }
        }
        });
    } catch (error) {
        console.warn("[PushOutbox] safe consumption paused:", error);
    } finally {
        consuming = false;
    }
}

/** 前台每 20 秒补拉，恢复网络或回前台立即检查。 */
export function installServerOutboxConsumer(): void {
    if (typeof window === "undefined" || consumerInstalled) return;
    consumerInstalled = true;
    if (typeof BroadcastChannel !== "undefined") {
        outboxChannel = new BroadcastChannel("ai-phone:outbox-committed");
        outboxChannel.onmessage = event => {
            if (typeof event.data?.sessionId === "string") void refreshChatSessionFromDisk(event.data.sessionId).catch(() => {});
        };
    }

    // 前台定期补拉；启动、联网、回前台和 SW 事件立即补拉。后台由系统冻结，恢复后继续。
    const requestConsume = (force = false) => {
        consumeRequestForce ||= force;
        if (consumeRequestTimer !== null) window.clearTimeout(consumeRequestTimer);
        consumeRequestTimer = window.setTimeout(() => {
            consumeRequestTimer = null;
            const requestedForce = consumeRequestForce;
            consumeRequestForce = false;
            void consumeServerOutbox({ force: requestedForce });
        }, 150);
    };

    requestConsume(true);
    window.setInterval(() => {
        if (!document.hidden && navigator.onLine !== false) requestConsume();
    }, OUTBOX_FOREGROUND_CHECK_INTERVAL_MS);
    window.addEventListener("online", () => { if (!document.hidden) requestConsume(true); });
    if (!document.hidden) closeChatPushNotifications();
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            requestConsume(true);
            closeChatPushNotifications();
        }
    });
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data?.type === "push_outbox_ready") {
            requestConsume(true);
            if (!document.hidden) closeChatPushNotifications();
            return;
        }
        if (event.data?.type === "run_shortcut" && typeof event.data.url === "string") {
            const url: string = event.data.url;
            // 站点线的 /shortcut-run 票据地址、个人线的同源转发路由，或个人云网关自己的 run 入口
            const personal = loadPersonalPushCloudState();
            const allowed = url.startsWith(`${window.location.origin}/shortcut-run`)
                || url.startsWith(`${window.location.origin}/personal-shortcut-run?`)
                || (personal !== null && url.startsWith(`${personal.url}/functions/v1/ai-phone-push?action=run&`));
            if (allowed) window.location.href = url;
        }
    });
}
