import { timingSafeEqual } from "node:crypto";
import { formatXhsNoteSnapshot, isXhsNoteUrl } from "../xhs-note";
import { readXhsImage, readXhsNote } from "./xhs-reader";

import { XHS_MCP_TOOLS } from "../xhs-mcp-tools";
export { XHS_MCP_TOOLS };

export function hasXhsMcpAccess(authorization: string | null): boolean {
    const expected = process.env.XHS_MCP_ACCESS_TOKEN?.trim();
    if (!expected) return false;
    const supplied = Buffer.from(authorization || "");
    const wanted = Buffer.from(`Bearer ${expected}`);
    return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function browserRequest(path: "/login/status" | "/feeds/search", body?: unknown): Promise<Record<string, unknown>> {
    const token = process.env.XHS_BROWSER_TOKEN?.trim();
    if (!token) throw new Error("小红书搜索服务尚未配置");
    // Fixed host and allowlisted paths: callers cannot turn this into an internal-network proxy.
    const response = await fetch(`http://127.0.0.1:18060/api/v1${path}`, {
        method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(55000),
    });
    if (!response.ok) throw new Error(`小红书搜索暂时不可用（HTTP ${response.status}）`);
    const result = await response.json();
    if (!result.success) throw new Error("小红书搜索失败，请检查登录或稍后再试");
    return result.data || {};
}

let searching = false;
export async function callXhsMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (name === "search_xiaohongshu_notes") {
        const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
        if (!keyword || keyword.length > 80) throw new Error("搜索关键词需为1–80字");
        if (searching) throw new Error("已有小红书搜索正在执行，请稍后再试");
        searching = true;
        try {
            const login = await browserRequest("/login/status");
            if (!login.is_logged_in) throw new Error("小红书尚未登录或登录已失效，请用户完成服务端扫码登录；不要编造搜索结果");
            const result = await browserRequest("/feeds/search", { keyword });
            const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(10, Number(args.limit))) : 5;
            const feeds = Array.isArray(result.feeds) ? result.feeds : [];
            const notes = feeds.filter(feed => typeof feed?.id === "string" && /^[a-f\d]{24}$/i.test(feed.id) && typeof feed.xsecToken === "string")
                .slice(0, limit).map(feed => {
                    const card = feed.noteCard || {};
                    const url = new URL(`https://www.xiaohongshu.com/explore/${feed.id}`);
                    url.searchParams.set("xsec_token", feed.xsecToken);
                    url.searchParams.set("xsec_source", "pc_search");
                    return { title: String(card.displayTitle || "未命名笔记"), author: String(card.user?.nickname || card.user?.nickName || ""), type: String(card.type || ""), likedCount: String(card.interactInfo?.likedCount || ""), url: url.href };
                });
            const search = { version: 1, keyword, notes, notice: notes.length ? "这是搜索摘要。调用read_xiaohongshu_note读完后再挑选分享，不要仅凭标题推断正文。" : "没有获取到可用笔记，可能无匹配结果或页面受限；不要编造。" };
            return { content: [{ type: "text", text: JSON.stringify(search) }], structuredContent: { floatXhsSearch: search } };
        } finally { searching = false; }
    }
    if (!["read_xiaohongshu_note", "read_xiaohongshu_comments", "share_xiaohongshu_note"].includes(name)) throw new Error("未知工具");
    if (typeof args.url !== "string" || !isXhsNoteUrl(args.url)) throw new Error("需要完整的小红书HTTPS链接");
    const note = await readXhsNote(args.url, signal);
    if (name === "read_xiaohongshu_comments") {
        const offset = args.offset === undefined ? 0 : args.offset;
        const limit = args.limit === undefined ? 5 : args.limit;
        if (!Number.isInteger(offset) || Number(offset) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10) throw new Error("评论offset需为非负整数，limit需为1–10");
        const start = Number(offset), end = start + Number(limit), available = note.comments.length;
        note.comments = note.comments.slice(start, end);
        note.images = note.images.filter(image => image.commentIndex !== undefined && image.commentIndex >= start && image.commentIndex < end)
            .map(image => ({ ...image, commentIndex: image.commentIndex! - start }));
        note.desc = "本次只读取评论，正文请使用读取笔记工具。";
        note.imageCount = 0;
        note.commentImageCount = note.images.length;
        note.commentsRead = true;
        note.commentPage = { offset:start, returned:note.comments.length, available, nextOffset:end < available ? end : null };
    } else {
        note.images = note.images.filter(image => image.commentIndex === undefined);
        note.comments = [];
        note.commentImageCount = 0;
        note.commentsRead = false;
    }

    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
    const imageIndexes: number[] = [];
    let bytes = 0;
    const imageSignal = AbortSignal.any([AbortSignal.timeout(65000), ...(signal ? [signal] : [])]);
    for (let i = 0; i < note.images.length; i++) {
        try {
            if (bytes >= 24_000_000) throw new Error("配图数据总量超过本次读取上限");
            const image = await readXhsImage(note.images[i].url, imageSignal);
            if (bytes + image.base64.length > 24_000_000) throw new Error("配图数据总量超过本次读取上限");
            bytes += image.base64.length;
            imageIndexes.push(i);
            content.push({ type: "image", data: image.base64, mimeType: image.mime });
        } catch (error) { note.images[i].error = error instanceof Error ? error.message : "配图未加载"; }
    }
    const action = name === "share_xiaohongshu_note" ? "share" : "read";
    const status = (note.images.some(image => image.error) || note.images.length < note.imageCount + (note.commentImageCount ?? 0)) ? "partial" as const : "ready" as const;
    const promptNote = { ...note, images: note.images.map((image, index) => ({ ...image, ref: imageIndexes.includes(index) ? "attached" : undefined })) };
    content.unshift({ type: "text", text: formatXhsNoteSnapshot({ sourceUrl: args.url, status, note: promptNote }) });
    return { content, structuredContent: { floatXhsNote: { version: 1, action, sourceUrl: args.url, note, imageIndexes } } };
}
