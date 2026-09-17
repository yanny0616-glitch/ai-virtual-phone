// 按模型校准的 token 估算：pushApiLog 每记一次成功调用，就用请求文字的估算值和实际 prompt_tokens 更新该模型的比例。
// 目前只用于显示（记忆页占用提示）；预算截断仍用原公式，改预算会改变发给模型的内容，放到后续阶段做。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { estimateTokens, tokenCalibrationSample, updateTokenCalibration, type TokenCalibration } from "./token-counter";

const KEY = "ai_phone_token_calibration_v1";
const MAX_MODELS = 40;
registerKvMigration(KEY);

function modelKey(model?: string): string {
    return (model || "").trim().toLowerCase().slice(0, 120);
}

function load(): Record<string, TokenCalibration> {
    try {
        const parsed: unknown = JSON.parse(kvGet(KEY) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, TokenCalibration> : {};
    } catch { return {}; }
}

export function recordTokenCalibration(model: string | undefined, contents: string[], promptTokens: number | undefined): void {
    const key = modelKey(model);
    if (!key || !promptTokens) return;
    try {
        const estimate = contents.reduce((sum, text) => sum + estimateTokens(text) + 4, 0);
        const sample = tokenCalibrationSample(estimate, promptTokens);
        if (sample === null) return;
        const all = load();
        all[key] = updateTokenCalibration(all[key], sample, new Date().toISOString());
        const keys = Object.keys(all);
        if (keys.length > MAX_MODELS) {
            keys.sort((a, b) => String(all[a].updatedAt).localeCompare(String(all[b].updatedAt)));
            for (const old of keys.slice(0, keys.length - MAX_MODELS)) delete all[old];
        }
        kvSet(KEY, JSON.stringify(all));
    } catch { /* 校准失败不影响主流程 */ }
}

export function getTokenCalibration(model?: string): TokenCalibration | null {
    const key = modelKey(model);
    return key ? load()[key] ?? null : null;
}

/** 原公式估算值换算成这个模型的 token 数；没有样本时原样返回，calibrated=false */
export function calibrateTokenEstimate(estimate: number, model?: string): { tokens: number; calibrated: boolean; samples: number } {
    const calibration = getTokenCalibration(model);
    return calibration
        ? { tokens: Math.round(estimate * calibration.ratio), calibrated: true, samples: calibration.samples }
        : { tokens: estimate, calibrated: false, samples: 0 };
}
