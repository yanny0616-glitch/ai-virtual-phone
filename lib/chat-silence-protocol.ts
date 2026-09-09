// Shared by the browser and personal-cloud worker; no storage or clock access.
export const CHAT_SILENCE_TOKEN = "[本轮不回复]";

function silenceThinkingTags(thinkingTag?: string): string {
    return ["think", "thinking", ...(thinkingTag && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(thinkingTag) ? [thinkingTag] : [])].join("|");
}

function stripSilenceThinking(text: string, thinkingTag?: string): string {
    return text.replace(new RegExp(`<(${silenceThinkingTags(thinkingTag)})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
}

/** A dedicated first-line decision may be followed by normal metadata/update instructions. */
export function isChatSilenceResponse(text: string, thinkingTag?: string): boolean {
    const candidate = stripSilenceThinking(text, thinkingTag).trim();
    return candidate === CHAT_SILENCE_TOKEN || candidate.startsWith(`${CHAT_SILENCE_TOKEN}\n`)
        || candidate.startsWith(`${CHAT_SILENCE_TOKEN}\r\n`);
}

export function stripChatSilenceMarker(text: string, thinkingTag?: string): string {
    if (!isChatSilenceResponse(text, thinkingTag)) return text;
    return stripSilenceThinking(text, thinkingTag).trim().slice(CHAT_SILENCE_TOKEN.length).trim();
}

/** Hold only the possible protocol prefix; normal prose continues streaming immediately. */
export function createChatSilenceStreamFilter(emit: (text: string) => void | Promise<void>, thinkingTag?: string) {
    let pending = "";
    let released = false;
    return {
        async push(delta: string) {
            if (released) { await emit(delta); return; }
            pending += delta;
            const candidate = stripSilenceThinking(pending, thinkingTag).trimStart();
            if (!candidate || isChatSilenceResponse(pending, thinkingTag) || CHAT_SILENCE_TOKEN.startsWith(candidate.trimEnd())
                || new RegExp(`^(?:<(?:${silenceThinkingTags(thinkingTag)})>[\\s\\S]*|<\\/?[a-zA-Z0-9_-]*)$`, "i").test(candidate)) return;
            released = true;
            await emit(pending);
            pending = "";
        },
        async flush() {
            if (pending && !isChatSilenceResponse(pending, thinkingTag)) await emit(pending);
            pending = "";
        },
    };
}
