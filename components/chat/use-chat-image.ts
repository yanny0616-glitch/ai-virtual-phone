"use client";

import { useEffect, useState } from "react";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";

const isDirect = (ref: string) => /^(?:data:|https?:|blob:)/.test(ref);

/** 聊天图片库里的 id 换成能直接放进 <img> 的地址；本来就是 URL 的原样返回 */
export function useChatImage(ref: string | null | undefined): string | null {
    const [resolved, setResolved] = useState<{ ref: string; url: string | null } | null>(null);
    useEffect(() => {
        if (!ref || isDirect(ref)) return;
        let live = true;
        void getChatImageFromIndexedDB(ref).then(url => { if (live) setResolved({ ref, url }); });
        return () => { live = false; };
    }, [ref]);
    if (!ref) return null;
    if (isDirect(ref)) return ref;
    return resolved?.ref === ref ? resolved.url : null;
}
