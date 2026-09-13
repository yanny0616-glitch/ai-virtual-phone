import { safeOutboundFetch } from "./safe-outbound-fetch";
import { isXhsNoteUrl, type XhsNote } from "../xhs-note";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max = 50000): string => typeof value === "string" || typeof value === "number" ? String(value).slice(0, max) : "";

export function normalizeXhsImageUrl(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    try {
        let value = raw.replace(/\\u002[fF]/g, "/");
        if (value.startsWith("//")) value = `https:${value}`;
        const url = new URL(value);
        if (url.protocol === "http:") url.protocol = "https:";
        if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
        if (!(url.hostname.endsWith(".xhscdn.com") || url.hostname === "ci.xiaohongshu.com")) return null;
        return url.href;
    } catch { return null; }
}

/** Parse data, never eval untrusted page JavaScript. Handles braces/undefined inside strings. */
export function extractXhsState(html: string): Record<string, unknown> {
    const match = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
    if (!match) throw new Error("页面没有公开笔记数据，可能需要登录、链接已失效或页面结构已改变");
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escape = false, end = -1;
    if (html[start] !== "{") throw new Error("笔记数据格式无法识别");
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (quoted) {
            if (escape) escape = false;
            else if (c === "\\") escape = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error("笔记数据不完整");
    const json = html.slice(start, end).replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g, token => token === "undefined" ? "null" : token);
    return object(JSON.parse(json));
}

export function parseXhsNote(html: string, url: string): XhsNote {
    const state = extractXhsState(html);
    const data = object(object(state.noteData).data);
    const preload = object(object(state.noteData).normalNotePreloadData);
    const detail = object(Object.values(object(object(state.note).noteDetailMap))[0]);
    const note = [object(data.noteData), object(preload.noteData), preload, object(detail.note)]
        .find(item => text(item.title) || text(item.desc));
    if (!note) throw new Error("页面没有可读取的笔记正文");
    const user = object(note.user);
    const interact = object(note.interactInfo);
    const imageList = list(note.imageList ?? note.imagesList);
    const images = imageList.map(item => {
        if (typeof item === "string") return normalizeXhsImageUrl(item);
        const image = object(item);
        const info = list(image.infoList).map(object);
        return normalizeXhsImageUrl(image.urlDefault ?? image.url ?? info.find(i => i.imageScene === "H5_DTL")?.url ?? info[0]?.url);
    }).filter((item): item is string => Boolean(item));
    const commentData = object(data.commentData);
    const rawComments = list(commentData.comments ?? commentData.list ?? detail.comments);
    const comments: XhsNote["comments"] = [];
    const commentImages: XhsNote["images"] = [];
    let commentImageCount = 0;
    for (const raw of rawComments) {
        for (const item of [raw, ...list(object(raw).subComments)]) {
            const c = object(item), u = object(c.user ?? c.userInfo);
            const pictures = list(c.pictures);
            if (!text(c.content) && !pictures.length) continue;
            const commentIndex = comments.length;
            comments.push({ user: text(u.nickname ?? u.nickName, 200) || "用户", content: text(c.content, 10000), ipLocation: text(c.ipLocation, 100) });
            commentImageCount += pictures.length;
            for (const picture of pictures) {
                const p = object(picture);
                const imageUrl = normalizeXhsImageUrl(p.originUrl) ?? normalizeXhsImageUrl(p.url);
                if (imageUrl && images.length + commentImages.length < 60) commentImages.push({ url: imageUrl, commentIndex });
            }
        }
    }
    const warnings: string[] = [];
    if (commentImages.length < commentImageCount) warnings.push("部分评论图片没有可用地址或超出单次 60 张附件上限，未全部读取。");
    if (text(note.type) === "video") warnings.push("这是视频笔记：目前读取正文和封面，不包含视频画面、音轨或完整转写。");
    if (images.length < imageList.length) warnings.push("部分配图没有可用的公开图片地址。");
    if (images.length > 30) throw new Error("笔记超过 30 张配图，本次未读取；请拆分分享，避免遗漏图片");
    return {
        url, title: text(note.title, 1000) || "小红书笔记", author: text(user.nickname ?? user.nickName, 200) || "未知作者",
        desc: text(note.desc), images: [...images.map(url => ({ url })), ...commentImages], imageCount: imageList.length, commentImageCount,
        likedCount: text(interact.likedCount, 50) || "—", commentCount: text(interact.commentCount ?? commentData.commentCount, 50) || "—",
        collectedCount: text(interact.collectedCount, 50) || "—", comments, noteType: text(note.type), warnings,
    };
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (!response.body) throw new Error("服务未返回内容");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error("远端内容过大，已停止读取");
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

export async function readXhsNote(url: string, signal?: AbortSignal): Promise<XhsNote> {
    if (!isXhsNoteUrl(url)) throw new Error("请提供有效的 HTTPS 小红书笔记或分享短链接");
    const response = await safeOutboundFetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error(`小红书暂时无法读取（HTTP ${response.status}），请在原链接确认笔记是否可见`);
    if (!isXhsNoteUrl(response.url)) { await response.body?.cancel(); throw new Error("分享链接未跳转到小红书笔记页面"); }
    const html = new TextDecoder().decode(await boundedBytes(response, 5_000_000));
    return parseXhsNote(html, response.url);
}

export async function readXhsImage(rawUrl: string, signal?: AbortSignal): Promise<{ base64: string; mime: string }> {
    const url = normalizeXhsImageUrl(rawUrl);
    if (!url) throw new Error("图片地址不属于小红书图片域名");
    const response = await safeOutboundFetch(url, { headers: { "User-Agent": UA, Referer: "https://www.xiaohongshu.com/" }, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error(`配图下载失败（HTTP ${response.status}）`);
    if (!normalizeXhsImageUrl(response.url)) { await response.body?.cancel(); throw new Error("配图跳转到了非图片域名"); }
    const bytes = await boundedBytes(response, 8_000_000);
    const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const prefix = new TextDecoder().decode(bytes.slice(0, 12));
    const mime = isPng ? "image/png" : isJpeg ? "image/jpeg" : prefix.startsWith("GIF8") ? "image/gif" : prefix.startsWith("RIFF") && prefix.endsWith("WEBP") ? "image/webp" : "";
    if (!mime) throw new Error("远端没有返回可识别的图片（可能被拦截）");
    return { base64: Buffer.from(bytes).toString("base64"), mime };
}
