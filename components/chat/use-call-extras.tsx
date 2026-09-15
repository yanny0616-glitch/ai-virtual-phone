"use client";

import { useCallback, useState } from "react";
import { BilingualTextBlock } from "./message-bubble";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { callSettings, splitNarration, type CallDirectives } from "@/lib/call-directives";
import { defaultCallArt, findCallArt, loadCallArt, sceneForPresence, type CallArt } from "@/lib/call-art";
import { CALL_CSS_SCOPE, CALL_HANGUP_GUARD_CSS } from "@/lib/call-css";
import { getChatPluginVar } from "@/lib/chat-plugin-storage";
import type { ChatSession } from "@/lib/chat-storage";
import { useChatImage } from "./use-chat-image";

/** 通话里的开关、立绘和场景；场景接通时按在线状态插件记的「TA 在哪」挑 */
export function useCallExtras(session: ChatSession, characterId: string, kind: "voice" | "video") {
    const [flags] = useState(() => callSettings(session));
    const [lib] = useState(() => loadCallArt(characterId));
    const [portrait, setPortrait] = useState<CallArt | null>(() => (kind === "video" ? defaultCallArt(lib, "portrait") : null));
    const [scene, setScene] = useState<CallArt | null>(() =>
        (flags.sceneFollow ? sceneForPresence(lib, getChatPluginVar("presence", "character", characterId)) : null) ?? defaultCallArt(lib, "scene"));

    const applyArt = useCallback((directives: CallDirectives) => {
        if (!flags.artSwitch) return;
        const nextPortrait = kind === "video" && directives.portrait ? findCallArt(lib, "portrait", directives.portrait) : null;
        const nextScene = directives.scene ? findCallArt(lib, "scene", directives.scene) : null;
        if (nextPortrait) setPortrait(nextPortrait);
        if (nextScene) setScene(nextScene);
    }, [flags.artSwitch, kind, lib]);

    const portraitUrl = useChatImage(portrait?.image);
    const sceneUrl = useChatImage(scene?.image);
    return { flags, applyArt, portraitUrl, sceneUrl };
}

/** 用户写的通话美化 CSS；写了才加挂断键保护 */
export function CallScreenStyle({ css }: { css?: string }) {
    if (!css?.trim()) return null;
    return (
        <>
            <SessionCustomCSS css={css} scope={CALL_CSS_SCOPE} />
            <style dangerouslySetInnerHTML={{ __html: CALL_HANGUP_GUARD_CSS }} />
        </>
    );
}

/** 字幕：（旁白）单独灰字，其余照旧走双语块 */
export function CallSubtitleText({ text, expanded }: { text: string; expanded: boolean }) {
    const parts = splitNarration(text);
    if (!parts.some(part => part.narr)) {
        return <BilingualTextBlock text={text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={expanded} />;
    }
    return (
        <>
            {parts.map((part, i) => (part.narr
                ? <span key={i} className="call-sub-narr">{part.text}</span>
                : <BilingualTextBlock key={i} text={part.text.trim()} mode="plain" className="call-subtitle-bilingual" defaultExpanded={expanded} />))}
        </>
    );
}
