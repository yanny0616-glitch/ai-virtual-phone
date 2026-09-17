import { requestXhsApi } from "./xhs-api";
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

const accountCommands: Record<string,string> = {
    get_xiaohongshu_recommendations:"list-feeds",get_xiaohongshu_profile:"user-profile",
    like_xiaohongshu_note:"like-feed",favorite_xiaohongshu_note:"favorite-feed",
    post_xiaohongshu_comment:"post-comment",reply_xiaohongshu_comment:"reply-comment",publish_xiaohongshu_note:"publish",
};
function validateAccountArgs(name: string, args: Record<string,unknown>) {
    const tool=XHS_MCP_TOOLS.find(tool=>tool.name===name);
    const definition=tool?.inputSchema as {required?:string[];properties?:Record<string,{type?:string}>};
    for(const key of definition.required || []) if(args[key]===undefined || args[key]==="")throw new Error(`缺少参数：${key}`);
    for(const [key,value] of Object.entries(args)) {
        const type=definition.properties?.[key]?.type;
        if(!type)throw new Error(`未知参数：${key}`);
        if(type==="array" ? !Array.isArray(value) || value.some(v=>typeof v!=="string") : type==="integer" ? !Number.isInteger(value) : typeof value!==type)throw new Error(`参数格式不正确：${key}`);
        if(typeof value==="string" && value.length>5000)throw new Error(`参数过长：${key}`);
    }
    for(const key of ["feed_id","user_id","comment_id"]) if(args[key]!==undefined && !/^[a-f0-9]{24}$/i.test(String(args[key])))throw new Error(`${key}需为24位笔记/用户/评论ID`);
    if(args.limit!==undefined && (Number(args.limit)<1 || Number(args.limit)>10))throw new Error("limit需为1–10");
    if(args.images) {
        const images=args.images as string[];
        if(!images.length || images.length>9 || images.some(raw=>{try {const u=new URL(raw);return u.protocol!=="https:" || Boolean(u.username||u.password);}catch{return true;}}))throw new Error("请提供1–9个有效HTTPS图片URL");
    }
    if(args.visibility!==undefined && !["public","private"].includes(String(args.visibility)))throw new Error("visibility需为public或private");
}
function noteCandidates(data: Record<string,unknown>, limit=5) {
    return ((Array.isArray(data.feeds)?data.feeds:[]) as Array<Record<string,unknown>>).slice(0,limit).flatMap(item=>{
        const id=String(item.id||item.note_id||"");if(!/^[a-f0-9]{24}$/i.test(id))return [];
        const token=String(item.xsecToken||item.xsec_token||"");
        return [{id,title:String(item.title||item.display_title||""),author:String((item.user as {nickname?:string})?.nickname||""),url:`https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search`,xsec_token:token}];
    });
}
let searching = false;
export async function callXhsMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (name === "check_xiaohongshu_login") return {content:[{type:"text",text:JSON.stringify(await requestXhsApi("status",{refresh:true},signal))}]};
    if (accountCommands[name]) {
        validateAccountArgs(name,args);
        const data=await requestXhsApi("call",{command:accountCommands[name],args},signal);
        if(name==="get_xiaohongshu_recommendations" || name==="get_xiaohongshu_profile") {
            const search={version:1,keyword:name==="get_xiaohongshu_profile"?"用户主页":"首页推荐",notes:noteCandidates(data,Number(args.limit)||5),notice:name==="get_xiaohongshu_profile" ? `主页信息：${JSON.stringify(data.basic_info||{}).slice(0,2000)}；主页状态：${String(data.profile_status||"")}；笔记状态：${String(data.notes_status||"")}` : "推荐摘要，请读取正文后再分享。",cursor_score:data.cursor_score};
            return {content:[{type:"text",text:JSON.stringify(search)}],structuredContent:{floatXhsSearch:search}};
        }
        return {content:[{type:"text",text:JSON.stringify(data).slice(0,18000)}]};
    }
    if (name === "search_xiaohongshu_notes") {
        const keyword=typeof args.keyword==="string"?args.keyword.trim():"";
        if(!keyword || keyword.length>80)throw new Error("搜索关键词需为1–80字");
        if(searching)throw new Error("已有小红书搜索正在执行，请稍后再试");
        searching=true;
        try {
            const data=await requestXhsApi("call",{command:"search",args:{keyword}},signal);
            const search={version:1,keyword,notes:noteCandidates(data,Math.max(1,Math.min(10,Number(args.limit)||5))),notice:"这是搜索摘要。读取正文后再挑选分享，评论按需读取。"};
            return {content:[{type:"text",text:JSON.stringify(search)}],structuredContent:{floatXhsSearch:search}};
        } finally {searching=false;}
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
