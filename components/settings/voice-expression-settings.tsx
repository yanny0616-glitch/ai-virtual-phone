"use client";

import type { VoiceApiConfig } from "@/lib/settings-types";
import { DEFAULT_VOICE_EXPRESSION_PROMPT, supportsVoiceSoundTags } from "@/lib/voice-expression";
import { Textarea, Toggle } from "@/components/ui/form";

export function VoiceExpressionSettings({ config, onChange }: {
    config: VoiceApiConfig;
    onChange: (patch: Partial<VoiceApiConfig>) => void;
}) {
    const enabled = config.speechExpressionEnabled === true;
    const promptId = `voice-expression-prompt-${config.id}`;
    return (
        <div className="flex flex-col gap-3">
            <div className="ui-toggle-row">
                <div className="menu-label-group">
                    <span className="menu-label font-medium">自然语音表达</span>
                    <span className="menu-desc">聊天语音与通话，跟随语境调整情绪和停顿</span>
                </div>
                <Toggle
                    aria-label="自然语音表达"
                    checked={enabled}
                    onChange={value => onChange({ speechExpressionEnabled: value })}
                />
            </div>
            {enabled && (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 px-1">
                        <label htmlFor={promptId} className="menu-desc">表达提示词</label>
                        <button type="button" className="ui-link-btn py-2" onClick={() => onChange({ speechExpressionPrompt: undefined })}>恢复默认</button>
                    </div>
                    <Textarea
                        id={promptId}
                        rows={4}
                        maxLength={2000}
                        value={config.speechExpressionPrompt ?? DEFAULT_VOICE_EXPRESSION_PROMPT}
                        placeholder={DEFAULT_VOICE_EXPRESSION_PROMPT}
                        onChange={event => onChange({ speechExpressionPrompt: event.target.value })}
                    />
                    <span className="menu-desc ml-1">留空使用默认提示词，仅对新语音生效。试听使用固定示例。</span>
                    {!supportsVoiceSoundTags(config) && (
                        <span className="menu-desc ml-1">当前模型仅支持情绪与停顿；笑声、换气需使用 2.8 模型。</span>
                    )}
                </div>
            )}
        </div>
    );
}
