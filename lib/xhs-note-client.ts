import { loadChatMessages, updateChatMessage, type ChatMessage } from "./chat-storage";
import { deleteMediaRef, storeMediaBase64 } from "./media-cache-storage";
import type { XhsNote, XhsNoteSnapshot } from "./xhs-note";

export const XHS_NOTE_UPDATED = "float-xhs-note-updated";
const active = new Map<string, Promise<void>>();

export function hasPendingXhsNotes(messages: ChatMessage[]): boolean {
    return messages.some(message => !message.isRetracted && message.mediaData?.xhsNote?.status === "loading");
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
    });
    if (response.status === 401) throw new Error("登录已过期，请重新登录后重试");
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "读取失败，请稍后重试");
    return data;
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
            // Refresh signed CDN URLs after reload/retry; do not reuse expired URLs.
            const data = await post("/api/xhs-card", { url: snapshot.sourceUrl });
            note = data.note as XhsNote;
            if (!patch({ ...snapshot, note, status: "loading", stage: `正在加载配图 0/${note.images.length}` })) return;
            await Promise.all((snapshot.note?.images || []).map(image => deleteMediaRef(image.ref)));
            let finished = 0;
            for (let offset = 0; offset < note.images.length; offset += 3) {
                if (!current()) return;
                const batch = note.images.slice(offset, offset + 3);
                try {
                    const result = await post("/api/xhs-images", { urls: batch.map(image => image.url) });
                    const images = result.images as Array<{ url: string; base64?: string; mime?: string; error?: string }>;
                    for (let i = 0; i < batch.length; i++) {
                        const image = images[i];
                        if (image?.base64 && image.mime) {
                            const stored = await storeMediaBase64(image.base64, image.mime);
                            if (!current()) { await deleteMediaRef(stored.ref); return; }
                            note.images[offset + i] = { url: batch[i].url, ref: stored.ref };
                        } else note.images[offset + i] = { url: batch[i].url, error: image?.error || "未返回图片" };
                        finished++;
                        if (!patch({ ...snapshot, note: { ...note, images: [...note.images] }, status: "loading", stage: `正在加载配图 ${finished}/${note.images.length}` })) return;
                    }
                } catch (error) {
                    for (let i = 0; i < batch.length; i++) {
                        note.images[offset + i] = { url: batch[i].url, error: error instanceof Error ? error.message : "下载失败" };
                    }
                    finished += batch.length;
                }
            }
            const missing = note.images.some(image => image.error) || note.images.length < note.imageCount;
            patch({ sourceUrl: snapshot.sourceUrl, status: missing ? "partial" : "ready", note, error: missing ? "部分配图未加载，角色只能看到成功加载的图片" : undefined });
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
