import { CHAT_PLUGIN_TOAST_EVENT } from "./chat-plugin-runtime";
import { applyCharBlock, extractBlockLine } from "./chat-block";
import type { ChatSession } from "./chat-storage";
import { applyChatVarUpdates, describeChatVarChanges, extractChatVarLines } from "./chat-variables";
import { extractModeSwitch, switchChatMode } from "./reply-style";

/** AI 回复里写给宿主的指令行（[变量 …]、[拉黑:…]、[删除好友:…]、[切到线下]）：落库前从正文拿掉，
 *  整轮气泡都落完再生效，拉黑提示才会排在 TA 最后一句话后面。只认单聊。 */
export function takeChatDirectives(
    text: string,
    session: Pick<ChatSession, "id" | "isGroup" | "contactId" | "autoModeSwitch"> | null | undefined,
): { text: string; apply: () => void } {
    if (!session || session.isGroup) return { text, apply: () => {} };
    const vars = extractChatVarLines(text);
    const block = extractBlockLine(vars.text);
    const mode = extractModeSwitch(block.text);
    const toOffline = !!session.autoModeSwitch && mode.target === "offline";
    if (!vars.updates.length && !block.action && !mode.target) return { text, apply: () => {} };
    let done = false;
    return {
        text: mode.text,
        apply: () => {
            if (done) return;
            done = true;
            const applied = applyChatVarUpdates(session.id, session.contactId, vars.updates);
            if (applied.length && typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent(CHAT_PLUGIN_TOAST_EVENT, {
                    detail: { id: `chat-var-${Date.now()}`, text: describeChatVarChanges(applied), durationMs: 4000 },
                }));
            }
            if (block.action) applyCharBlock(session.id, block.action.kind, block.action.reason);
            else if (toOffline) switchChatMode(session, "offline", "char");
        },
    };
}
