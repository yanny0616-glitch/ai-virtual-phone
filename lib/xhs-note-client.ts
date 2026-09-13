import { loadMcpServers } from "./tool-storage";
import { isXhsMcpServer } from "./xhs-mcp-config";
import { loadChatMessages, updateChatMessage, type ChatMessage } from "./chat-storage";
import { deleteMediaRef } from "./media-cache-storage";
import { extractXhsMcpPresentation } from "./xhs-mcp-result";
import type { XhsNote, XhsNoteSnapshot } from "./xhs-note";

export const XHS_NOTE_UPDATED = "float-xhs-note-updated";
const active = new Map<string, Promise<void>>();

export function hasPendingXhsNotes(messages: ChatMessage[]): boolean {
    return messages.some(message => !message.isRetracted && message.mediaData?.xhsNote?.status === "loading");
}

async function readViaMcp(url: string): Promise<unknown> {
    const server = loadMcpServers().find(isXhsMcpServer);
    if (!server || !server.enabled) throw new Error("请在设置 → 聊天工具箱开启小红书 MCP 后重试");
    const { callConfiguredMcpTool } = await import("./tool-executor");
    const result = await callConfiguredMcpTool(server, "read_xiaohongshu_note", { url }, AbortSignal.timeout(115000));
    const envelope = result as { isError?: boolean; content?: Array<{ text?: string }> };
    if (envelope?.isError) throw new Error(envelope.content?.map(item => item.text || "").join("\n") || "MCP 读取失败");
    return result;
}

export function hydrateXhsNote(message: ChatMessage): Promise<void> {
    const snapshot = message.mediaData?.xhsNote;
    if (!snapshot || snapshot.status !== "loading") return Promise.resolve();
    const running = active.get(message.id);
    if (running) return running;
    const run = async () => {
        const current = () => loadChatMessages(message.sessionId).find(m => m.id === message.id && !m.isRetracted);
        const patch = (value: XhsNoteSnapshot): boolean => {
            const existing = current();
            if (!existing) return false;
            const updated = updateChatMessage(message.id, { mediaData: { ...existing.mediaData, xhsNote: value } });
            if (updated) window.dispatchEvent(new CustomEvent(XHS_NOTE_UPDATED, { detail: { sessionId: message.sessionId } }));
            return Boolean(updated);
        };
        let note: XhsNote | undefined;
        try {
            // Same MCP read tool as characters. Persist only this existing user card.
            const result = await readViaMcp(snapshot.sourceUrl);
            if (!current()) return;
            const presentation = await extractXhsMcpPresentation(result, undefined, true);
            const loaded = presentation?.snapshot;
            if (!loaded?.note) throw new Error("MCP 未返回可读取的笔记");
            note = loaded.note;
            if (!patch({ ...loaded, sourceUrl: snapshot.sourceUrl })) {
                await Promise.all(note.images.map(image => deleteMediaRef(image.ref)));
                return;
            }
            await Promise.all((snapshot.note?.images || []).map(image => deleteMediaRef(image.ref)));
        } catch (error) {
            patch({ sourceUrl: snapshot.sourceUrl, status: note ? "partial" : "failed", note, error: error instanceof Error ? error.message : "笔记读取失败" });
        }
    };
    const promise = run().finally(() => active.delete(message.id));
    active.set(message.id, promise);
    return promise;
}

export function retryXhsNote(message: ChatMessage): void {
    if (active.has(message.id) || !message.mediaData?.xhsNote) return;
    const old = message.mediaData.xhsNote;
    void Promise.all((old.note?.images || []).map(image => deleteMediaRef(image.ref)));
    const updated = updateChatMessage(message.id, { mediaData: { ...message.mediaData, xhsNote: { sourceUrl: old.sourceUrl, status: "loading", stage: "正在读取笔记…" } } });
    if (updated) {
        window.dispatchEvent(new CustomEvent(XHS_NOTE_UPDATED, { detail: { sessionId: message.sessionId } }));
        void hydrateXhsNote(updated);
    }
}
