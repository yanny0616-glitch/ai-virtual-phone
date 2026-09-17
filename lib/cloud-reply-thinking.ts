import { loadBindingConfig, loadPresets, resolveBinding } from "./settings-storage";
import { loadChatSessions } from "./chat-storage";

export type CloudThinkingConfig = { enabled: boolean; tag: string };

/** 新消息使用生成时配置；旧回传使用会话当前绑定预设，与普通聊天的默认预设一致。 */
export function resolveCloudThinkingConfig(sessionId: string, appId = "chat", frozen?: CloudThinkingConfig): CloudThinkingConfig {
    if (frozen && typeof frozen.enabled === "boolean") return frozen;
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session) return { enabled: false, tag: "thinking" };
    const binding = resolveBinding(loadBindingConfig(), session.contactId, appId);
    const presets = loadPresets();
    const preset = presets.find(p => p.id === binding.presetId) ?? presets.find(p => p.builtIn);
    return { enabled: preset?.online_thinking_enabled === true, tag: preset?.online_thinking_tag?.trim() || "thinking" };
}

/** 与线上预设一样仅提取配置标签；在输出正则与气泡拆分前执行。 */
export function parseCloudThinking(text: string, config: CloudThinkingConfig): { text: string; reasoningText?: string } {
    if (!config.enabled) return { text };
    const tag = (config.tag?.trim() || "thinking").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const thoughts: string[] = [];
    const visible = text.replace(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi"), (_block, thought: string) => {
        if (thought.trim()) thoughts.push(thought.trim());
        return "";
    }).trim();
    return { text: visible, reasoningText: thoughts.join("\n\n") || undefined };
}
