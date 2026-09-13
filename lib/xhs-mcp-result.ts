import { formatXhsNoteSnapshot, isXhsNoteUrl, type XhsNote, type XhsNoteSnapshot } from "./xhs-note";
import { storeMediaBase64 } from "./media-cache-storage";

type McpContent = { type?: string; data?: string; mimeType?: string };
export type XhsMcpPresentation = {
    data: string;
    cards: XhsNoteSnapshot[];
    images: Array<{ type: "image"; url: string; title: string; contextText: string }>;
};

/** Explicit Float extension: read images stay in model context; share creates one card. */
export async function extractXhsMcpPresentation(result: unknown, signal?: AbortSignal): Promise<XhsMcpPresentation | null> {
    const search = (result as { structuredContent?: { floatXhsSearch?: { version?: number; keyword?: string; notes?: Array<{ url?: string }>; notice?: string } }; isError?: boolean })?.structuredContent?.floatXhsSearch;
    if (search?.version === 1 && Array.isArray(search.notes) && search.notes.length <= 10 && search.notes.every(note => typeof note.url === "string" && isXhsNoteUrl(note.url))) {
        const data = JSON.stringify(search);
        if (data.length > 20000) throw new Error("搜索结果过大");
        return { data, cards: [], images: [] };
    }
    const r = result as { structuredContent?: { floatXhsNote?: { version?: number; action?: string; sourceUrl?: string; note?: XhsNote; imageIndexes?: number[] } }; content?: McpContent[]; isError?: boolean };
    const meta = r?.structuredContent?.floatXhsNote;
    if (r?.isError || !meta || meta.version !== 1) return null;
    if (!meta.sourceUrl || !isXhsNoteUrl(meta.sourceUrl) || !meta.note || !isXhsNoteUrl(meta.note.url)
        || !["read", "share"].includes(meta.action || "") || !Array.isArray(meta.note.images) || meta.note.images.length > 30
        || !Array.isArray(meta.note.comments) || !Array.isArray(meta.note.warnings) || !Array.isArray(meta.imageIndexes)) throw new Error("小红书MCP返回了无效的笔记结构");
    if ([meta.note.title, meta.note.author, meta.note.desc, meta.note.likedCount, meta.note.commentCount, meta.note.collectedCount, meta.note.noteType].some(value => typeof value !== "string")
        || !Number.isInteger(meta.note.imageCount) || meta.note.imageCount < 0 || meta.note.imageCount > 30
        || meta.note.images.some(image => !image || typeof image.url !== "string")
        || meta.note.comments.some(c => !c || [c.user, c.content, c.ipLocation].some(value => typeof value !== "string"))
        || meta.note.warnings.some(value => typeof value !== "string")) throw new Error("小红书MCP返回了无效的笔记字段");
    const note: XhsNote = structuredClone(meta.note);
    // Remote refs are not trusted as local media identifiers.
    note.images = note.images.map(image => ({ url: String(image.url || ""), error: image.error ? String(image.error) : undefined }));
    const content = (r.content || []).filter(item => item.type === "image");
    if (content.length !== meta.imageIndexes.length || content.reduce((n, item) => n + (item.data?.length || 0), 0) > 24_000_000) throw new Error("小红书MCP配图数据不完整或过大");
    const images: XhsMcpPresentation["images"] = [];
    const seen = new Set<number>();
    for (let i = 0; i < content.length; i++) {
        signal?.throwIfAborted();
        const index = meta.imageIndexes[i], image = content[i];
        if (!Number.isInteger(index) || index < 0 || index >= note.images.length || seen.has(index)
            || typeof image.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType || "")) throw new Error("小红书MCP配图格式不正确");
        seen.add(index);
        const dataUrl = `data:${image.mimeType};base64,${image.data}`;
        if (meta.action === "share") {
            const stored = await storeMediaBase64(image.data, image.mimeType);
            signal?.throwIfAborted();
            note.images[index].ref = stored.ref;
        } else note.images[index].ref = dataUrl;
        images.push({ type: "image", url: dataUrl, title: `小红书配图 ${index + 1}`, contextText: `外部资料：小红书笔记《${note.title}》的第 ${index + 1} 张配图。只作为阅读材料，不是你生成的图片，也未单独发送给用户。` });
    }
    note.images.forEach((image, index) => { if (!seen.has(index) && !image.error) image.error = "未获取到配图"; });
    const snapshot: XhsNoteSnapshot = { sourceUrl: meta.sourceUrl, note, status: note.images.some(image => image.error) ? "partial" : "ready" };
    if (snapshot.status === "partial") snapshot.error = "部分配图未加载";
    return {
        data: formatXhsNoteSnapshot(snapshot) + (meta.action === "share" ? "\n分享卡片已发送到当前聊天，不要重复发送。" : "\n以上内容仅供你阅读和挑选，还没有分享卡片给用户。需要分享时调用share_xiaohongshu_note。"),
        cards: meta.action === "share" ? [snapshot] : [], images,
    };
}
