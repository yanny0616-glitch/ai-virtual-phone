import { loadCharacters } from "./character-storage";
import {
    CHAT_REQUEST_REPLY_EVENT,
    loadChatMessages,
    loadChatSessions,
    pushChatMessage,
    saveChatSessions,
    type CharBlockState,
    type ChatMessage,
    type ChatSession,
} from "./chat-storage";
import { addFriendRequest, dispatchFriendRequestUpdated } from "./friend-request-storage";
import { resolveUserIdentity } from "./settings-storage";
import type { ContentAppId } from "./settings-types";

// 拉黑与删好友，两个方向：
//   角色 → 用户：AI 回复里写 [拉黑:理由] / [删除好友:理由]，记在 session.charBlock；
//               冷静期过后用户再发消息或打开聊天，角色单独想一次要不要解除 / 加回来。
//   用户 → 角色：session.isBlacklisted（自定义 APP 的 contacts.block 也写这个字段），
//               期间角色发来的消息在 chat-storage 写库处被截进 blockedInbox。

export const CHAT_BLOCK_CHANGED_EVENT = "chat-block-changed";
export const DEFAULT_BLOCK_COOLDOWN_MIN = 120;
export const BLOCK_COOLDOWN_CHOICES = [30, 120, 360, 1440];
export const VERIFY_RETRY_MS = 10 * 60 * 1000;

const BLOCK_LINE_RE = /^[ \t]*[\[【]\s*(拉黑|删除好友|删好友)\s*(?:[:：]\s*([^\]】\n]*?))?\s*[\]】][ \t]*$/m;

export function extractBlockLine(text: string): { text: string; action: { kind: CharBlockState["kind"]; reason: string } | null } {
    const match = text.match(BLOCK_LINE_RE);
    if (!match) return { text, action: null };
    return {
        text: text.replace(BLOCK_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim(),
        action: { kind: match[1] === "拉黑" ? "block" : "delete", reason: (match[2] ?? "").trim().slice(0, 80) },
    };
}

export type ChatBlockInfo = Pick<ChatSession, "charBlock" | "isBlacklisted" | "blacklistedAt" | "blockedInbox" | "lastBlacklist">;

export function readChatBlock(sessionId: string): ChatBlockInfo {
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session || session.isGroup) return {};
    return {
        charBlock: session.charBlock,
        isBlacklisted: session.isBlacklisted,
        blacklistedAt: session.blacklistedAt,
        blockedInbox: session.blockedInbox,
        lastBlacklist: session.lastBlacklist,
    };
}

function updateSession(sessionId: string, mutate: (session: ChatSession) => void): ChatSession | null {
    const sessions = loadChatSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    mutate(session);
    saveChatSessions(sessions);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHAT_BLOCK_CHANGED_EVENT, { detail: { sessionId } }));
    return session;
}

function namesFor(session: ChatSession): { charName: string; userName: string } {
    const character = loadCharacters().find(c => c.id === session.contactId);
    return {
        charName: character?.name ?? "对方",
        userName: resolveUserIdentity(session.contactId, "chat")?.name ?? "用户",
    };
}

function notice(sessionId: string, content: string, uiText: string): ChatMessage {
    const message = pushChatMessage({ sessionId, role: "system", content, uiText });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
    return message;
}

function spanText(ms: number): string {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `${min} 分钟`;
    const hours = Math.round(min / 60);
    return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function virtualNote(sessionId: string, content: string): ChatMessage {
    return { id: `virtual_block_${Date.now()}`, sessionId, role: "system", content, status: "sent", createdAt: new Date().toISOString() };
}

async function generateDecision(session: ChatSession, messages: ChatMessage[], appId: string): Promise<string> {
    const { generateChatCompletion, flattenCompletionResult } = await import("./chat-engine");
    return flattenCompletionResult(await generateChatCompletion(session, messages, { appId: appId as ContentAppId }));
}

async function sayAsCharacter(sessionId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const { parseAndSaveResponse } = await import("./follow-up-service");
    await parseAndSaveResponse(text, sessionId, 0, undefined, []);
}

const cleanLine = (text: string) => text
    .replace(/\[\/?(?:解除拉黑|添加好友|通过)\]/g, "")
    .replace(/【指令】/g, "")
    .replace(/\[内心\][\s\S]*?\[\/内心\]/g, "")
    .trim()
    .slice(0, 300);

// ── 角色 → 用户 ──

export function applyCharBlock(sessionId: string, kind: CharBlockState["kind"], reason: string): void {
    const updated = updateSession(sessionId, session => {
        if (session.isGroup) return;
        session.charBlock = {
            kind,
            at: new Date().toISOString(),
            reason: reason || undefined,
            cooldownMin: session.charBlock?.cooldownMin ?? DEFAULT_BLOCK_COOLDOWN_MIN,
        };
    });
    if (!updated || updated.isGroup) return;
    const { charName, userName } = namesFor(updated);
    if (kind === "block") notice(sessionId, `${charName}把${userName}拉黑了`, `你已被 ${charName} 拉黑`);
    else notice(sessionId, `${charName}删除了${userName}的好友`, `你已被 ${charName} 删除好友`);
}

export function setCharBlockCooldown(sessionId: string, minutes: number): void {
    updateSession(sessionId, session => { if (session.charBlock) session.charBlock.cooldownMin = minutes; });
}

/** 上帝视角：直接恢复，角色不会知道 */
export function clearCharBlock(sessionId: string): void {
    updateSession(sessionId, session => { delete session.charBlock; });
}

const reconsidering = new Set<string>();

/** 冷静期过了才问；没到期、正在问、会话不是单聊都直接跳过 */
export async function maybeReconsiderCharBlock(sessionId: string): Promise<void> {
    if (reconsidering.has(sessionId)) return;
    const session = loadChatSessions().find(s => s.id === sessionId);
    const block = session?.charBlock;
    if (!session || !block || session.isGroup) return;
    const lastCheck = Date.parse(block.checkedAt || block.at);
    if (Date.now() - lastCheck < block.cooldownMin * 60000) return;
    reconsidering.add(sessionId);
    try {
        updateSession(sessionId, s => { if (s.charBlock) s.charBlock.checkedAt = new Date().toISOString(); });
        const { charName, userName } = namesFor(session);
        const since = Date.parse(block.at);
        const history = loadChatMessages(sessionId);
        const rejected = history.filter(m => m.rejectedBy && Date.parse(m.createdAt) >= since).length;
        const why = block.reason ? `（当时的理由：${block.reason}）` : "";
        const situation = block.kind === "block"
            ? `你在${spanText(Date.now() - since)}前把${userName}拉黑了${why}。这期间${userName}给你发了 ${rejected} 条消息，都被拒收了，你没看到内容。`
            : `你在${spanText(Date.now() - since)}前删了${userName}的好友${why}。这期间${userName}给你发了 ${rejected} 条消息，都没发出去。`;
        const reply = await generateDecision(session, [...history.filter(m => !m.rejectedBy), virtualNote(sessionId, situation)], "block_reconsider");
        const current = loadChatSessions().find(s => s.id === sessionId)?.charBlock;
        if (!current || current.at !== block.at) return;
        const yes = reply.match(/\[(?:解除拉黑|添加好友)\]([\s\S]*)/);
        if (!yes) return;
        const message = cleanLine(yes[1]);
        if (block.kind === "block") {
            updateSession(sessionId, s => { delete s.charBlock; });
            notice(sessionId, `${charName}把${userName}移出了黑名单`, `${charName} 已将你移出黑名单`);
            await sayAsCharacter(sessionId, message);
        } else {
            const note = message || "……";
            notice(sessionId, `${charName}向${userName}发起了好友申请，备注：${note}`, `${charName} 想重新加你为朋友：「${note}」· 去「通讯录 › 新的朋友」通过`);
            addFriendRequest(session.contactId, note, 1);
            dispatchFriendRequestUpdated();
        }
    } catch (error) {
        console.warn("[ChatBlock] 冷静期重新考虑失败", error);
    } finally {
        reconsidering.delete(sessionId);
    }
}

export type VerifyResult = { ok: false; reason: string } | { ok: true; passed: boolean };

export async function sendFriendVerification(sessionId: string, text: string): Promise<VerifyResult> {
    const session = loadChatSessions().find(s => s.id === sessionId);
    const block = session?.charBlock;
    if (!session || !block || block.kind !== "delete") return { ok: false, reason: "TA 没有删你" };
    if (block.verifyRejectedAt) {
        const wait = VERIFY_RETRY_MS - (Date.now() - Date.parse(block.verifyRejectedAt));
        if (wait > 0) return { ok: false, reason: `刚被拒绝过，${Math.ceil(wait / 60000)} 分钟后再发` };
    }
    const { charName, userName } = namesFor(session);
    const note = text.trim().slice(0, 120) || "我是" + userName;
    notice(sessionId, `${userName}向${charName}发送了朋友验证：${note}`, `你已发送朋友验证：${note}`);
    try {
        const reply = await generateDecision(session, loadChatMessages(sessionId).filter(m => !m.rejectedBy), "friend_verify");
        const pass = reply.match(/\[通过\]([\s\S]*)/);
        const passed = !!pass || (!reply.includes("拒绝") && reply.includes("通过"));
        if (passed) {
            updateSession(sessionId, s => { delete s.charBlock; });
            notice(sessionId, `${charName}通过了${userName}的朋友验证`, `${charName} 通过了你的朋友验证，现在可以开始聊天了`);
            await sayAsCharacter(sessionId, pass ? cleanLine(pass[1]) : "");
        } else {
            updateSession(sessionId, s => { if (s.charBlock) s.charBlock.verifyRejectedAt = new Date().toISOString(); });
            notice(sessionId, `${charName}拒绝了${userName}的朋友验证`, `${charName} 拒绝了你的朋友验证 · 10 分钟后可以再发`);
        }
        return { ok: true, passed };
    } catch (error) {
        console.warn("[ChatBlock] 朋友验证失败", error);
        return { ok: false, reason: "这次没发出去，稍后再试" };
    }
}

// ── 用户 → 角色 ──

export function setUserBlacklist(sessionId: string, on: boolean): void {
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session || session.isGroup || !!session.isBlacklisted === on) return;
    const { charName, userName } = namesFor(session);
    const now = new Date().toISOString();
    if (on) {
        updateSession(sessionId, s => { s.isBlacklisted = true; s.blacklistedAt = now; s.blockedInbox = []; });
        notice(sessionId, `${userName}把${charName}拉黑了`, `你已将 ${charName} 拉黑`);
        return;
    }
    const count = session.blockedInbox?.length ?? 0;
    updateSession(sessionId, s => {
        s.isBlacklisted = false;
        s.lastBlacklist = { from: s.blacklistedAt ?? now, to: now, count };
        delete s.blacklistedAt;
    });
    notice(
        sessionId,
        count
            ? `${userName}把${charName}移出了黑名单。拉黑期间${charName}发的 ${count} 条消息都被拒收了，${userName}一条都没收到。`
            : `${userName}把${charName}移出了黑名单`,
        `你已将 ${charName} 移出黑名单`,
    );
    // TA 找过你才让 TA 回一句：没发过消息的 TA 根本不知道自己被拉黑过
    if (count && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail: { source: "chat_block", sessionId, handled: false } }));
    }
}
