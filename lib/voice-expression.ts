import type { PresetConfig, VoiceApiConfig } from "./settings-types";
import { splitBilingualText } from "./bilingual-text";

export const DEFAULT_VOICE_EXPRESSION_PROMPT = "像日常聊天一样说话，使用符合角色和当前关系的口语，避免播音腔和书面长句。根据上下文决定每段语音的情绪，不强行热情或夸张。声音标签和停顿按语境在合适的地方使用，符合角色当下的情绪、说话内容与呼吸节奏；不机械添加，不用动作描写代替说话。";

const EMOTIONS = new Set(["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"]);
const SOUND_TAGS = /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi;
const EMOTION_TAGS = /<tts\s*[:：]\s*([^<>]*)>/gi;
const PAUSE_TAGS = /<#([^<>]*?)#>/g;

/** Add only the macro, preserving the user's entry text, order and enabled state. */
export function migrateVoiceExpressionPreset(preset: PresetConfig): PresetConfig {
    if ((preset.voiceExpressionVersion ?? 0) >= 1) return preset;
    const prompts = preset.prompts.map(prompt => {
        if (!["chat_output_format", "chat_voice_format"].includes(prompt.identifier)
            || /\{\{\s*voiceExpression\s*\}\}/.test(prompt.content)) return prompt;
        const endTag = prompt.identifier === "chat_voice_format" ? "</voice_call_format>" : "</chat_output_format>";
        let index = prompt.content.indexOf(endTag);
        if (prompt.identifier === "chat_output_format") {
            const voiceHeading = prompt.content.indexOf("### 语音条");
            if (voiceHeading >= 0) {
                const nextHeading = prompt.content.indexOf("\n### ", voiceHeading + 1);
                if (nextHeading >= 0) index = nextHeading;
            }
        }
        const content = index < 0
            ? `${prompt.content}\n\n{{voiceExpression}}`
            : `${prompt.content.slice(0, index)}\n{{voiceExpression}}\n${prompt.content.slice(index)}`;
        return { ...prompt, content };
    });
    return { ...preset, prompts, voiceExpressionVersion: 1 };
}

export function supportsVoiceSoundTags(config: VoiceApiConfig): boolean {
    return config.provider === "Minimax" && /^speech-2\.8-(hd|turbo)$/.test(config.model || "");
}

export function isVoiceExpressionEnabled(config: VoiceApiConfig | null | undefined): boolean {
    return config?.provider === "Minimax" && config.enableTTS !== false && config.speechExpressionEnabled === true;
}

export function buildVoiceExpressionPrompt(config: VoiceApiConfig | undefined, mode: "chat" | "call"): string {
    if (!isVoiceExpressionEnabled(config) || !config) return "";
    return [
        "【语音表达协议】",
        mode === "chat"
            ? "仅在本来要发送的 [语音条:...] 内使用以下协议；不要因此把普通文字回复改成语音。普通文字、状态、内心、引用和工具参数不加语音控制标记。"
            : "当前是语音通话。保持原有单段口语输出，不换行，不使用 [语音条:...] 包裹；状态和内心仍按原规则输出，不加语音控制标记。",
        "语音开头使用 <tts:情绪>，情绪只选 auto/happy/sad/angry/fearful/disgusted/surprised/calm。根据当前对话判断，拿不准用 auto。该标记不会显示或朗读。",
        mode === "chat" ? "每条语音只选一种情绪；不要在同一语音条中重复情绪标记。"
            : "需要改变情绪时在同一段内加新的 <tts:情绪> 标记，不为此换行。",
        supportsVoiceSoundTags(config)
            ? "声音标签按语境在合适的地方使用，根据角色当下的情绪、说话内容与呼吸节奏选择，不机械添加。可用标签：(laughs) 笑声、(chuckle) 轻笑、(coughs) 咳嗽、(clear-throat) 清嗓子、(groans) 呻吟、(breath) 换气、(pant) 喘气、(inhale) 吸气、(exhale) 呼气、(gasps) 倒吸气、(sniffs) 吸鼻子、(sighs) 叹气、(snorts) 喷鼻息、(burps) 打嗝、(lip-smacking) 咂嘴、(humming) 哼唱、(hissing) 嘶嘶声、(emm) 嗯、(sneezes) 喷嚏。不要自创括号标签。这些是声音控制，不是动作描写。"
            : "当前语音模型不支持笑声、换气等括号标签，禁止插入此类标签。",
        "需要短暂停顿时，在两段可朗读文字之间插入 <#0.3#>，建议 0.1–0.8 秒，最多 2 秒；不得在开头、结尾或连续插入。保留原双语规则，标签仅放在原文，不放译文中。",
        "以下偏好只影响说话方式，不改变以上输出协议：",
        (typeof config.speechExpressionPrompt === "string" ? config.speechExpressionPrompt.trim().slice(0, 2000) : "") || DEFAULT_VOICE_EXPRESSION_PROMPT,
        mode === "chat" ? "格式示例：[语音条:<tts:happy>你回来啦！]" : "格式示例：<tts:calm>嗯，我在听。",
    ].join("\n");
}

export function stripVoiceExpression(text: string): string {
    return text.replace(EMOTION_TAGS, "").replace(SOUND_TAGS, "").replace(PAUSE_TAGS, "").trim();
}

/** Keep the annotated text separate from display/history; ordinary prose is untouched. */
export function extractVoiceExpression(text: string, audio = false): { displayText: string; ttsText?: string } {
    const hasEmotion = /^\s*<tts\s*[:：]/i.test(text);
    const displayText = stripVoiceExpression(text);
    if (!hasEmotion && !(audio && displayText !== text.trim())) return { displayText: text };
    return { displayText, ttsText: hasEmotion ? text : `<tts:auto>${text}` };
}

/** An edited message must not keep speaking its previous, annotated contents. */
export function resolveVoiceExpressionText(displayText: string, ttsText?: string, mode: "message" | "call" = "message"): string {
    const source = ttsText && stripVoiceExpression(ttsText) === displayText.trim() ? ttsText : displayText;
    // Preserve the pre-existing chat cache key, including multiline bilingual messages.
    if (mode === "message") return splitBilingualText(source)?.original || source;
    return source.split("\n").map(line => splitBilingualText(line)?.original || line).join("\n");
}

export function splitVoiceExpressionSegments(text: string): string[] {
    return text.split(/(?=<tts\s*[:：])/i).map(part => part.trim()).filter(part => stripVoiceExpression(part));
}

/** Called only by host chat/call TTS, leaving custom-app SDK options independent. */
export function prepareVoiceExpression(text: string, config: VoiceApiConfig): { text: string; emotion?: string } {
    if (!isVoiceExpressionEnabled(config)) return { text: stripVoiceExpression(text) };
    const value = /^\s*<tts\s*[:：]\s*([^<>]*)>/i.exec(text)?.[1]?.trim().toLowerCase();
    let speech = text.replace(EMOTION_TAGS, "");
    if (!supportsVoiceSoundTags(config)) speech = speech.replace(SOUND_TAGS, "");
    speech = speech.replace(PAUSE_TAGS, (_tag, seconds: string) => {
        if (!/^\d+(?:\.\d{1,2})?$/.test(seconds)) return "";
        const duration = Number(seconds);
        return duration >= 0.01 && duration <= 2 ? `<#${duration}#>` : "";
    });
    // Prevent leading/trailing pauses and consecutive pauses, even with intervening sound tags.
    const chunks = speech.split(/(<#[\d.]+#>)/);
    let sincePause = "";
    speech = chunks.map((chunk, index) => {
        if (!/^<#[\d.]+#>$/.test(chunk)) { sincePause += chunk; return chunk; }
        const valid = Boolean(stripVoiceExpression(sincePause)) && Boolean(stripVoiceExpression(chunks.slice(index + 1).join("")));
        sincePause = "";
        return valid ? chunk : "";
    }).join("").trim();
    return { text: speech, ...(value && EMOTIONS.has(value) ? { emotion: value } : {}) };
}
