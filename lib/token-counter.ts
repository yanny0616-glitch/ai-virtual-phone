// lib/token-counter.ts
// Lightweight token estimation — zero external dependencies.
// CJK characters ~ 1.5 char/token, Latin ~ 4 char/token, +4 overhead per message.

const CJK_RANGE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkMatches = text.match(CJK_RANGE);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const latinCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 1.5 + latinCount / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content) + 4; // per-message overhead
    }
    return total + 2; // conversation overhead
}

export function remainingTokenBudget(
    maxContext: number,
    currentTokens: number,
    reserveForGeneration: number = 500
): number {
    return Math.max(0, maxContext - currentTokens - reserveForGeneration);
}

// ── 按模型校准 ──
// 上面的公式对所有模型都按 1.5 字/token 估，实际差别很大（Claude 对中文约 1.1 字/token）。
// 每次请求拿「估算值 ÷ 接口返回的 prompt_tokens」更新一个比例，按模型分开存（存取在 token-calibration.ts）。

export type TokenCalibration = { ratio: number; samples: number; updatedAt: string };

/** 太短的请求、离谱的比例（工具定义、图片没算进估算时会偏）不拿来校准 */
export function tokenCalibrationSample(estimate: number, actual: number): number | null {
    if (!(estimate >= 500) || !(actual > 0)) return null;
    const ratio = actual / estimate;
    return ratio >= 0.3 && ratio <= 4 ? ratio : null;
}

/** 前几次取平均，之后按 0.2 的权重滑动，模型换了分词器也能跟上 */
export function updateTokenCalibration(prev: TokenCalibration | undefined, sample: number, now: string): TokenCalibration {
    if (!prev || !(prev.ratio > 0)) return { ratio: sample, samples: 1, updatedAt: now };
    const weight = Math.max(0.2, 1 / (prev.samples + 1));
    return { ratio: prev.ratio + (sample - prev.ratio) * weight, samples: prev.samples + 1, updatedAt: now };
}
