"use client";

// 朋友圈里点头像进来的个人主页：封面 + 头像 + 名字 + 签名，下面只列这个人的动态。
// 布局和「动态」页顶部那块一样；你自己的主页读的是动态页原来那份封面/签名。
import { useEffect, useMemo, useRef, useState } from "react";
import type { MomentComment, MomentPost } from "@/lib/moments-types";
import { getAllPosts } from "@/lib/moments-storage";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { CHAT_PLUGIN_VARS_CHANGED_EVENT } from "@/lib/chat-plugin-storage";
import { readCharacterCoverAssetId, readCharacterProfile, writeCharacterCoverAssetId, writeCharacterSignature } from "@/lib/moments-profile";
import { PageShell } from "@/components/ui/page-shell";
import { MomentPostCard } from "./moment-post-card";

const USER_COVER_KEY = "moments_cover_asset_id";
const USER_SIGNATURE_KEY = "moments_signature";
const USER_SIGNATURE_DEFAULT = "make every day count (●ˇ∀ˇ●)";

type Props = {
    authorType: "user" | "character";
    authorId: string;
    onBack: () => void;
    onUpdate: () => void;
    onRequestDelete: (postId: string) => void;
    onOpenCommentComposer: (post: MomentPost) => void;
    onOpenReplyComposer: (post: MomentPost, comment: MomentComment, replyName: string) => void;
};

/** 把图片缩到 800 以内存进 IndexedDB，和动态页换封面同一套 */
function storeCover(file: File): Promise<string | null> {
    return new Promise(resolve => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            const maxSize = 800;
            let w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
                if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                else { w = Math.round(w * maxSize / h); h = maxSize; }
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(objectUrl);
            canvas.toBlob(blob => {
                if (!blob) { resolve(null); return; }
                saveChatImageToIndexedDB(blob).then(resolve, () => resolve(null));
            }, "image/jpeg", 0.85);
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
        img.src = objectUrl;
    });
}

export function MomentProfilePage({ authorType, authorId, onBack, onUpdate, onRequestDelete, onOpenCommentComposer, onOpenReplyComposer }: Props) {
    const isUser = authorType === "user";
    const character = useMemo(() => isUser ? null : loadCharacters().find(c => c.id === authorId) ?? null, [isUser, authorId]);
    const userIdentity = resolveUserIdentity(undefined, "chat");
    const name = isUser ? (userIdentity?.name ?? "我") : (character?.name ?? "TA");
    const avatar = isUser ? (userIdentity?.avatarUrl ?? null) : (character?.avatar ?? null);

    const [posts, setPosts] = useState<MomentPost[]>([]);
    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    const [signature, setSignature] = useState("");
    const [signatureBy, setSignatureBy] = useState<"self" | "user" | "">("");
    const [editing, setEditing] = useState(false);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [headerScrolled, setHeaderScrolled] = useState(false);

    useEffect(() => {
        const bodyEl = bodyRef.current;
        if (!bodyEl) return;
        const onScroll = () => setHeaderScrolled(bodyEl.scrollTop > 120);
        bodyEl.addEventListener("scroll", onScroll, { passive: true });
        return () => bodyEl.removeEventListener("scroll", onScroll);
    }, []);

    const refreshPosts = () => setPosts(getAllPosts().filter(p => p.authorType === authorType && p.authorId === authorId));
    const refreshSignature = () => {
        if (isUser) { setSignature(kvGet(USER_SIGNATURE_KEY) || USER_SIGNATURE_DEFAULT); setSignatureBy("user"); return; }
        const p = readCharacterProfile(authorId);
        setSignature(p?.signature ?? "");
        setSignatureBy(p?.by ?? "");
    };

    useEffect(() => {
        refreshPosts();
        refreshSignature();
        const assetId = isUser ? kvGet(USER_COVER_KEY) : readCharacterCoverAssetId(authorId);
        let cancelled = false;
        setCoverUrl(null);
        if (assetId) getChatImageFromIndexedDB(assetId).then(url => { if (!cancelled && url) setCoverUrl(url); });
        const onMoments = () => refreshPosts();
        const onVars = () => refreshSignature();
        window.addEventListener("moments-updated", onMoments);
        window.addEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, onVars);
        return () => {
            cancelled = true;
            window.removeEventListener("moments-updated", onMoments);
            window.removeEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT, onVars);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authorType, authorId]);

    const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const assetId = await storeCover(file);
        if (!assetId) return;
        if (isUser) kvSet(USER_COVER_KEY, assetId);
        else writeCharacterCoverAssetId(authorId, assetId);
        const url = await getChatImageFromIndexedDB(assetId);
        if (url) setCoverUrl(url);
    };

    const submitSignature = (value: string) => {
        const trimmed = value.trim();
        setEditing(false);
        if (isUser) {
            const next = trimmed || USER_SIGNATURE_DEFAULT;
            kvSet(USER_SIGNATURE_KEY, next);
            setSignature(next);
            return;
        }
        if (!trimmed || trimmed === signature) return;
        writeCharacterSignature(authorId, trimmed, "user");
        setSignature(trimmed);
        setSignatureBy("user");
    };

    const handleUpdate = () => { refreshPosts(); onUpdate(); };

    return (
        <PageShell title={name} onBack={onBack} bodyRef={bodyRef} className={`moments-feed-page moments-profile-page ${headerScrolled ? "is-scrolled" : ""}`}>
            <div className="feed-cover-shell w-full relative mb-4">
                <div
                    onClick={() => coverInputRef.current?.click()}
                    className="feed-cover-bg absolute inset-0 w-full h-full bg-[var(--c-input)] cursor-pointer z-0"
                    style={{
                        maskImage: "linear-gradient(to bottom, black 40%, transparent 100%)",
                        WebkitMaskImage: "linear-gradient(to bottom, black 40%, transparent 100%)",
                    }}
                >
                    {coverUrl ? (
                        <img src={coverUrl} alt="" className="feed-cover-image w-full h-full object-cover" />
                    ) : avatar ? (
                        // 没设封面就拿头像放大糊一层当底，主页不至于是一块空白
                        <img src={avatar} alt="" className="feed-cover-image w-full h-full object-cover" style={{ filter: "blur(18px) saturate(1.2)", transform: "scale(1.3)", opacity: 0.75 }} />
                    ) : null}
                </div>
                <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" />

                <div
                    className="feed-profile relative w-full px-5 pb-5 pointer-events-none"
                    style={{ paddingTop: "calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px) + 160px)" }}
                >
                    <div className="feed-profile-avatar w-[72px] h-[72px] rounded-full border-[3px] border-[var(--c-page-body-bg)] bg-[var(--c-input)] overflow-hidden flex items-center justify-center translate-x-[2px] pointer-events-auto">
                        {avatar ? (
                            <img src={avatar} alt="" className="feed-profile-avatar-image w-full h-full object-cover" />
                        ) : (
                            <span className="feed-profile-avatar-fallback ts-24 text-[var(--c-icon)] font-bold">{name[0]}</span>
                        )}
                    </div>
                    <div className="feed-profile-info flex flex-col gap-1 mt-3 ml-[6px] pointer-events-auto">
                        <span className="feed-profile-name ts-20 font-bold text-[var(--c-text-title)]">{name}</span>
                        <div className="feed-profile-stats flex gap-4 ts-13 text-[var(--c-icon)] font-medium mt-[2px]">
                            <span className="feed-profile-stat"><strong className="feed-profile-stat-value text-[var(--c-text-title)]">{posts.length}</strong> 条动态</span>
                        </div>
                        <div className="feed-profile-signature mt-[2px] text-left text-[var(--c-text)]">
                            {editing ? (
                                <input
                                    defaultValue={signature}
                                    autoFocus
                                    className="feed-profile-signature-input bg-transparent outline-none ts-14 text-[var(--c-text)] w-full border-b border-[var(--c-action-blue)] pb-1"
                                    onBlur={e => submitSignature(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") submitSignature((e.target as HTMLInputElement).value); }}
                                />
                            ) : (
                                <span
                                    className="feed-profile-signature-text cursor-pointer ts-14 opacity-90 leading-[1.6]"
                                    onClick={() => setEditing(true)}
                                    title={signatureBy === "self" ? "TA自己写的，点一下可以替TA改" : "点一下编辑"}
                                >
                                    {signature || (isUser ? "编写你的个性签名..." : "TA还没写签名")}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {posts.length === 0 ? (
                <div className="feed-empty-state py-10 text-center text-[var(--c-icon)] ts-14">
                    {isUser ? "你还没发过动态" : "TA还没发过动态"}
                </div>
            ) : (
                posts.map(post => (
                    <MomentPostCard
                        key={post.id}
                        post={post}
                        onUpdate={handleUpdate}
                        onRequestDelete={onRequestDelete}
                        onOpenCommentComposer={onOpenCommentComposer}
                        onOpenReplyComposer={onOpenReplyComposer}
                    />
                ))
            )}
        </PageShell>
    );
}
