import { callArtItems, loadCallArt } from "./call-art";
import type { ChatSession } from "./chat-storage";

// 通话里 AI 写给宿主的标记：[挂断]、[立绘:名字]、[场景:名字]；（旁白）显示成灰字、不进语音。

const HANGUP_RE = /[\[【]\s*挂(?:断|电话)\s*[\]】]/g;
const ART_RE = /[\[【]\s*(立绘|场景)\s*[:：]\s*([^\]】\n]{1,20}?)\s*[\]】]/g;
// 半角括号只认里面有中文的：(laughs) 这类是语音表情标签，要留给 TTS
const NARRATION_RE = /（[^（）\n]{1,80}）|\((?=[^()\n]*[\u4e00-\u9fff])[^()\n]{1,80}\)/g;

export type CallDirectives = { text: string; hangup: boolean; portrait?: string; scene?: string };

export function takeCallDirectives(text: string): CallDirectives {
    let hangup = false;
    let portrait: string | undefined;
    let scene: string | undefined;
    const out = text
        .replace(HANGUP_RE, () => { hangup = true; return ""; })
        .replace(ART_RE, (_, kind: string, name: string) => {
            if (kind === "立绘") portrait = name.trim();
            else scene = name.trim();
            return "";
        })
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { text: out, hangup, portrait, scene };
}

export function stripNarration(text: string): string {
    return text.replace(NARRATION_RE, " ").replace(/[ \t]{2,}/g, " ").replace(/\s+\n/g, "\n").trim();
}

export function splitNarration(text: string): { narr: boolean; text: string }[] {
    const out: { narr: boolean; text: string }[] = [];
    let last = 0;
    for (const match of text.matchAll(NARRATION_RE)) {
        const index = match.index ?? 0;
        if (index > last) out.push({ narr: false, text: text.slice(last, index) });
        out.push({ narr: true, text: match[0] });
        last = index + match[0].length;
    }
    if (last < text.length) out.push({ narr: false, text: text.slice(last) });
    return out.filter(part => part.text.trim());
}

export function callSettings(session: Pick<ChatSession, "callNarration" | "allowCharHangup" | "callSummary" | "callCameraDefault" | "callSceneFollow" | "callArtSwitch">) {
    return {
        narration: session.callNarration !== false,
        hangup: session.allowCharHangup !== false,
        summary: session.callSummary !== false,
        cameraDefault: session.callCameraDefault === true,
        sceneFollow: session.callSceneFollow !== false,
        artSwitch: session.callArtSwitch !== false,
    };
}

/** {{callExtras}}：只在通话请求里有内容 */
export function buildCallExtrasPrompt(session: ChatSession, kind: "voice" | "video", charName: string): string {
    if (session.isGroup) return "";
    const flags = callSettings(session);
    const lines: string[] = [];
    if (flags.narration) {
        lines.push("- 通话动描：可以用全角括号写一小段动作、神态或环境旁白，比如（把手机拿远了一点），单独成句，一轮最多一处。括号里的不会被读出来，要说的话别写进括号。这条盖过上面「严禁括号动作」。");
    }
    if (flags.hangup) {
        lines.push(`- 挂断：如果${charName}真的想结束这通电话（困到不行、吵起来了、被人叫走），在回复最后单独写 [挂断]，说完这句就挂。别轻易挂。`);
    }
    if (flags.artSwitch) {
        const lib = loadCallArt(session.contactId);
        const portraits = kind === "video" ? callArtItems(lib, "portrait").map(item => item.name) : [];
        const scenes = callArtItems(lib, "scene").map(item => item.name);
        if (portraits.length > 1) lines.push(`- 立绘（对方看到的你）：情绪明显变了时可在回复最后写 [立绘:名字] 换，只能选：${portraits.join("、")}。`);
        if (scenes.length > 1) lines.push(`- 场景：你真的换了地方时可写 [场景:名字]，只能选：${scenes.join("、")}。`);
    }
    return lines.length ? ["## 这通电话", ...lines].join("\n") : "";
}
