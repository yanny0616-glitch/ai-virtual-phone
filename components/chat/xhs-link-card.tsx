"use client";

import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, Heart, ImageIcon, MessageCircle, RotateCcw, Star } from "lucide-react";
import type { ChatMessage } from "@/lib/chat-storage";
import { loadMediaBlob } from "@/lib/media-cache-storage";
import { retryXhsNote } from "@/lib/xhs-note-client";

export function XhsLinkCard({ message }: { message: ChatMessage }) {
    const snapshot = message.mediaData?.xhsNote;
    const note = snapshot?.note;
    const coverRef = note?.images[0]?.ref;
    const [coverImage, setCover] = useState({ ref: "", url: "" });
    const cover = coverImage.ref === coverRef ? coverImage.url : "";
    useEffect(() => {
        let live = true;
        let url = "";
        if (coverRef) void loadMediaBlob(coverRef).then(result => {
            if (!live || !result) return;
            url = URL.createObjectURL(result.blob);
            setCover({ ref: coverRef, url });
        });
        return () => { live = false; if (url) URL.revokeObjectURL(url); };
    }, [coverRef]);
    if (!snapshot) return null;
    const loading = snapshot.status === "loading";
    const failed = snapshot.status === "failed" || snapshot.status === "partial";
    return (
        <div className="w-[260px] max-w-full overflow-hidden rounded-2xl border border-rose-200/70 bg-[var(--chat-bubble-ai,#fff)] text-[var(--foreground,#292524)] shadow-sm">
            <a href={note?.url || snapshot.sourceUrl} target="_blank" rel="noopener noreferrer" className="block text-inherit no-underline" aria-label={`打开小红书笔记：${note?.title || "加载中的笔记"}`}>
                <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-rose-50/70">
                    {cover ? /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={cover} alt={note?.title || "笔记封面"} className="h-full w-full object-cover" />
                        : <ImageIcon aria-hidden className={`h-8 w-8 text-rose-200 ${loading ? "animate-pulse motion-reduce:animate-none" : ""}`} />}
                    {Boolean(note?.imageCount) && <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white"><ImageIcon size={11} />{note?.imageCount}</span>}
                </div>
                <div className="px-3 py-2.5">
                    <div className="mb-1.5 flex items-center justify-between text-[10px] text-rose-500"><span className="flex items-center gap-1"><BookOpen size={12} />小红书</span><ExternalLink size={12} /></div>
                    <div className="line-clamp-2 text-[13px] font-semibold leading-5">{note?.title || (failed ? "暂时无法读取这条笔记" : "正在读取笔记…")}</div>
                    {note?.desc && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-[1.6] opacity-65">{note.desc}</p>}
                    {note && <><div className="mt-2 truncate text-[10px] opacity-65">{note.author}</div><div className="mt-2 flex items-center gap-3 text-[10px] opacity-55"><span className="flex items-center gap-1"><Heart size={11} />{note.likedCount}</span><span className="flex items-center gap-1"><MessageCircle size={11} />{note.commentCount}</span><span className="flex items-center gap-1"><Star size={11} />{note.collectedCount}</span></div></>}
                </div>
            </a>
            {loading && <div role="status" aria-live="polite" className="border-t border-rose-100 px-3 py-2 text-[10px] text-rose-500 motion-safe:animate-pulse">{snapshot.stage || "正在读取笔记…"}</div>}
            {failed && <div className="border-t border-rose-100 px-3 py-2"><p role="status" className="text-[10px] leading-4 text-rose-600">{snapshot.error}</p><button type="button" onClick={() => retryXhsNote(message)} className="mt-1 inline-flex min-h-9 items-center gap-1 text-[11px] text-rose-600"><RotateCcw size={12} />重新读取</button></div>}
            {note && !loading && <div className="border-t border-rose-100 px-3 py-1.5 text-[9px] opacity-50">{note.commentsRead === false ? "评论按需读取" : `已读取 ${note.comments.length} 条公开评论`} · 正文图 {note.images.filter(i => i.ref && i.commentIndex === undefined).length}/{note.imageCount} · 评论图 {note.images.filter(i => i.ref && i.commentIndex !== undefined).length}/{note.commentImageCount ?? 0}{note.noteType === "video" ? " · 视频仅含封面" : ""}</div>}
        </div>
    );
}
