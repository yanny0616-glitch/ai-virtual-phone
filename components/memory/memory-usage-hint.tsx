"use client";

import { useState } from "react";
import { calibrateTokenEstimate } from "@/lib/token-calibration";
import { loadMemoryPromptUsage, MEMORY_USAGE_LAYER_LABELS } from "@/lib/memory-prompt-usage";

function formatTokens(value: number): string {
    return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : value.toLocaleString("zh-CN");
}

function ago(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (!(mins >= 1)) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

/** 记忆详情顶部：上次聊天请求里各层记忆占了多少 token，点开看条数和字数 */
export function MemoryUsageHint({ characterId }: { characterId: string }) {
    const [open, setOpen] = useState(false);
    const usage = loadMemoryPromptUsage(characterId);
    if (!usage) {
        return (
            <div className="g-card ts-12 text-secondary" style={{ padding: "10px 14px" }}>
                记忆占用：和 TA 聊一次后，这里会显示上次请求里各层记忆占了多少 token。
            </div>
        );
    }
    const layers = usage.layers.map(layer => ({ ...layer, ...calibrateTokenEstimate(layer.estimate, usage.model) }));
    const total = layers.reduce((sum, layer) => sum + layer.tokens, 0);
    const calibrated = layers[0]?.calibrated ?? false;
    const samples = layers[0]?.samples ?? 0;
    return (
        <button
            type="button"
            className="g-card w-full text-left"
            style={{ padding: "10px 14px" }}
            onClick={() => setOpen(value => !value)}
        >
            <div className="ts-13">上次请求记忆约 {formatTokens(total)} token</div>
            <div className="ts-12 text-secondary leading-[1.7]">
                {layers.map(layer => `${MEMORY_USAGE_LAYER_LABELS[layer.key]} ${formatTokens(layer.tokens)}`).join(" · ")}
            </div>
            {open && (
                <div className="ts-12 text-secondary leading-[1.7]" style={{ marginTop: 6 }}>
                    {layers.map(layer => (
                        <div key={layer.key}>{MEMORY_USAGE_LAYER_LABELS[layer.key]}：{layer.count} 条，{layer.chars.toLocaleString("zh-CN")} 字</div>
                    ))}
                </div>
            )}
            <div className="ts-11 text-secondary" style={{ marginTop: 4 }}>
                {usage.model || "未知模型"} · {calibrated ? `已按 ${samples} 次实际用量校准` : "估算（这个模型还没有实际用量可校准）"} · {ago(usage.at)}
            </div>
        </button>
    );
}
