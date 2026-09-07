// Shared by the browser and personal-cloud worker; no storage or clock access.
export const CHAT_SILENCE_TOKEN = "[本轮不回复]";

function silenceThinkingTags(thinkingTag?: string): string {
    return ["think", "thinking", ...(thinkingTag && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(thinkingTag) ? [thinkingTag] : [])].join("|");
}

function stripSilenceThinking(text: string, thinkingTag?: string): string {
    return text.replace(new RegExp(`<(${silenceThinkingTags(thinkingTag)})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
}

/** Only a whole response is a decision. Quoting the token in prose is ordinary text. */
export function isChatSilenceResponse(text: string, thinkingTag?: string): boolean {
    return stripSilenceThinking(text, thinkingTag).trim() === CHAT_SILENCE_TOKEN;
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
            if (!candidate || CHAT_SILENCE_TOKEN.startsWith(candidate.trimEnd())
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
