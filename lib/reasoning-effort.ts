// 推理深度：按模型名换写法。API 事实见 docs/fork-changes.md「推理深度」一节，
// 新模型上线时只改这里的 claudeFamily / planReasoning。
import type { ApiConfig } from "./settings-types";

export type ReasoningLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningWire = "anthropic" | "gemini" | "openai";

export const REASONING_LEVELS: ReadonlyArray<{ key: ReasoningLevel; label: string }> = [
    { key: "off", label: "关" },
    { key: "low", label: "低" },
    { key: "medium", label: "中" },
    { key: "high", label: "高" },
    { key: "xhigh", label: "更高" },
    { key: "max", label: "最高" },
];

export type ReasoningStep =
    | { ok: true; send: Record<string, unknown> | null; note?: string; budget?: number; thinking?: "adaptive" | "enabled" }
    | { ok: false; why: string };

export type ReasoningPlan = {
    family: string;
    where: "请求体" | "generationConfig 里";
    steps: Record<ReasoningLevel, ReasoningStep>;
};

const BUDGET: Record<"low" | "medium" | "high", number> = { low: 2048, medium: 8192, high: 16384 };
const GEMINI_BUDGET: Record<"low" | "medium" | "high", number> = { low: 1024, medium: 8192, high: 24576 };
// 自适应思考的 token 也算在 max_tokens 里，档位高时默认的 8192 会把正文挤没。
const ADAPTIVE_MIN_MAX_TOKENS: Partial<Record<ReasoningLevel, number>> = { high: 16000, xhigh: 32000, max: 64000 };
const RELAY_NOTE = "中转站得支持这个参数才有效；报错就打开「按服务商默认」";

type ClaudeFamily = {
    name: string;
    mode: "adaptive" | "budget" | "none";
    always?: boolean;
    defaultOn?: boolean;
    offCapped?: boolean;
    xhigh?: boolean;
    max?: boolean;
    effort?: boolean;
};

function claudeFamily(model: string): ClaudeFamily | null {
    const m = model.replace(/\./g, "-");
    if (!m.includes("claude")) return null;
    if (/claude-(fable|mythos)-5/.test(m)) return { name: "Claude Fable / Mythos 5", mode: "adaptive", always: true, xhigh: true, max: true };
    if (/claude-mythos-preview/.test(m)) return { name: "Claude Mythos Preview", mode: "adaptive", always: true, max: true };
    if (/claude-opus-5/.test(m)) return { name: "Claude Opus 5", mode: "adaptive", defaultOn: true, offCapped: true, xhigh: true, max: true };
    if (/claude-sonnet-5/.test(m)) return { name: "Claude Sonnet 5", mode: "adaptive", defaultOn: true, xhigh: true, max: true };
    if (/claude-opus-4-[78]/.test(m)) return { name: "Claude Opus 4.7 / 4.8", mode: "adaptive", xhigh: true, max: true };
    if (/claude-(opus|sonnet)-4-6/.test(m)) return { name: "Claude 4.6", mode: "adaptive", max: true };
    if (/claude-opus-4-5/.test(m)) return { name: "Claude Opus 4.5", mode: "budget", effort: true };
    if (/claude-(opus|sonnet|haiku)-4|claude-3-7/.test(m)) return { name: "Claude 4.5 及更早", mode: "budget" };
    return { name: "更早的 Claude", mode: "none" };
}

function allUnavailable(family: string, why: string, where: ReasoningPlan["where"] = "请求体"): ReasoningPlan {
    const steps = {} as Record<ReasoningLevel, ReasoningStep>;
    for (const { key } of REASONING_LEVELS) steps[key] = { ok: false, why };
    return { family, where, steps };
}

export function reasoningWireForConfig(config: Pick<ApiConfig, "provider">): ReasoningWire {
    if (config.provider === "Anthropic") return "anthropic";
    if (config.provider === "Google") return "gemini";
    return "openai";
}

export function planReasoning(wire: ReasoningWire, model: string, provider = ""): ReasoningPlan {
    const full = model.trim().toLowerCase();
    // OpenRouter 等会带厂商前缀：anthropic/claude-…、openai/gpt-5
    const m = full.replace(/^[a-z0-9_-]+\//, "");
    const claude = claudeFamily(m);
    const openRouter = provider === "OpenRouter";

    if (claude && wire === "anthropic") {
        const label = claude.name + (claude.mode === "adaptive" ? " · 自适应" : claude.mode === "budget" ? " · token 预算" : " · 不推理");
        if (claude.mode === "none") return allUnavailable(label, "这个模型不会推理");
        const steps = {} as Record<ReasoningLevel, ReasoningStep>;
        if (claude.mode === "adaptive") {
            steps.off = claude.always
                ? { ok: false, why: "这个模型一直在想，关不掉" }
                : {
                    ok: true,
                    send: claude.defaultOn ? { thinking: { type: "disabled" } } : null,
                    note: claude.offCapped ? "Opus 5 关掉思考后，偶尔会把工具调用写进正文" : claude.defaultOn ? undefined : "这个模型默认就不想，所以什么都不用发",
                };
            for (const k of ["low", "medium", "high", "xhigh", "max"] as const) {
                if ((k === "xhigh" && !claude.xhigh) || (k === "max" && !claude.max)) {
                    steps[k] = { ok: false, why: "这个模型没有这一档" };
                    continue;
                }
                steps[k] = claude.always
                    ? { ok: true, send: { output_config: { effort: k } } }
                    : { ok: true, send: { thinking: { type: "adaptive" }, output_config: { effort: k } }, thinking: "adaptive" };
            }
        } else {
            steps.off = { ok: true, send: null, note: "这一代默认就不想，所以什么都不用发" };
            for (const k of ["low", "medium", "high"] as const) {
                const send: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: BUDGET[k] } };
                if (claude.effort) send.output_config = { effort: k };
                steps[k] = {
                    ok: true,
                    send,
                    budget: BUDGET[k],
                    thinking: "enabled",
                    note: "开了之后预设里的温度和 Top K 不发（Claude 规定），输出上限不够会自动抬高；工具调用接着回的那一轮不开思考",
                };
            }
            steps.xhigh = { ok: false, why: "这一代没有这一档" };
            steps.max = { ok: false, why: "这一代没有这一档" };
        }
        return { family: label, where: "请求体", steps };
    }

    if (claude) {
        const label = `${claude.name} · 经${openRouter ? " OpenRouter" : "中转站"}`;
        if (claude.mode === "none") return allUnavailable(label, "这个模型不会推理");
        const note = openRouter ? undefined : RELAY_NOTE;
        const steps = {} as Record<ReasoningLevel, ReasoningStep>;
        steps.off = claude.always
            ? { ok: false, why: "这个模型一直在想，关不掉" }
            : { ok: true, send: openRouter ? { reasoning: { enabled: false } } : { reasoning_effort: "none" }, note };
        for (const k of ["low", "medium", "high"] as const) {
            steps[k] = { ok: true, send: openRouter ? { reasoning: { effort: k } } : { reasoning_effort: k }, note };
        }
        steps.xhigh = { ok: false, why: "OpenAI 格式一般没有这一档" };
        steps.max = { ok: false, why: "OpenAI 格式一般没有这一档" };
        return { family: label, where: "请求体", steps };
    }

    const effortSend = (value: string): Record<string, unknown> => openRouter
        ? (value === "none" ? { reasoning: { enabled: false } } : { reasoning: { effort: value } })
        : { reasoning_effort: value };

    if (/^(gpt-5|o[134])/.test(m) && !/chat/.test(m)) {
        const steps = {} as Record<ReasoningLevel, ReasoningStep>;
        if (/^o/.test(m)) steps.off = { ok: false, why: "o 系列关不掉" };
        else if (/^gpt-5\.\d/.test(m)) steps.off = { ok: true, send: effortSend("none") };
        else steps.off = { ok: true, send: effortSend("minimal"), note: "GPT-5 最低只到 minimal，还会想一点点" };
        for (const k of ["low", "medium", "high"] as const) steps[k] = { ok: true, send: effortSend(k) };
        steps.xhigh = /^gpt-5\.([2-9]|\d{2})|codex-max/.test(m)
            ? { ok: true, send: effortSend("xhigh") }
            : { ok: false, why: "这个模型没有这一档" };
        steps.max = { ok: false, why: "这个模型没有这一档" };
        return { family: "OpenAI 推理模型 · reasoning_effort", where: "请求体", steps };
    }

    if (/gemini-2\.5|gemini-3/.test(m)) {
        const v25 = /gemini-2\.5/.test(m);
        const pro = /pro/.test(m);
        const canOff = v25 && !pro;
        const steps = {} as Record<ReasoningLevel, ReasoningStep>;
        const offWhy = v25 ? "2.5 Pro 关不掉" : "Gemini 3 关不掉";
        if (wire === "gemini") {
            steps.off = canOff ? { ok: true, send: { thinkingConfig: { thinkingBudget: 0 } } } : { ok: false, why: offWhy };
            for (const k of ["low", "medium", "high"] as const) {
                steps[k] = v25
                    ? { ok: true, send: { thinkingConfig: { thinkingBudget: GEMINI_BUDGET[k] } }, budget: GEMINI_BUDGET[k] }
                    : { ok: true, send: { thinkingConfig: { thinkingLevel: k } } };
            }
        } else {
            const note = openRouter ? undefined : RELAY_NOTE;
            steps.off = canOff ? { ok: true, send: effortSend("none"), note } : { ok: false, why: offWhy };
            for (const k of ["low", "medium", "high"] as const) steps[k] = { ok: true, send: effortSend(k), note };
        }
        steps.xhigh = { ok: false, why: "Gemini 没有这一档" };
        steps.max = { ok: false, why: "Gemini 没有这一档" };
        return {
            family: v25 ? "Gemini 2.5 · 思考预算" : "Gemini 3 · 思考档位",
            where: wire === "gemini" ? "generationConfig 里" : "请求体",
            steps,
        };
    }

    if (m.includes("deepseek")) return allUnavailable("DeepSeek · 看模型名", "deepseek-reasoner 会想，deepseek-chat 不想，换模型名就行");
    return allUnavailable(m ? "没认出这个模型" : "还没填模型", "认不出的模型不发推理参数，免得报错");
}

const FALLBACK_ORDER: ReasoningLevel[] = ["max", "xhigh", "high", "medium", "low", "off"];

/** 档位这个模型没有时往下找最近的一档；一档都没有返回 null（什么都不发）。 */
export function resolveReasoningLevel(plan: ReasoningPlan, level: ReasoningLevel): ReasoningLevel | null {
    for (const k of FALLBACK_ORDER.slice(FALLBACK_ORDER.indexOf(level))) {
        if (plan.steps[k].ok) return k;
    }
    return null;
}

export type ReasoningRequest = {
    level: ReasoningLevel;
    send: Record<string, unknown>;
    budget?: number;
    thinking?: "adaptive" | "enabled";
    minMaxTokens?: number;
};

/**
 * 发请求时要合进请求体的推理参数；没设（按服务商默认）或这个模型没法设时返回 null。
 * toolContinuation：最后一条是工具结果。预算模式要求把上一轮的思考块原样带回，
 * 宿主不保存思考签名，这一轮只能不开思考，否则直接 400。
 */
export function reasoningRequestFor(
    config: Pick<ApiConfig, "provider" | "defaultModel" | "reasoningEffort">,
    wire: ReasoningWire,
    options: { toolContinuation?: boolean } = {},
): ReasoningRequest | null {
    const wanted = config.reasoningEffort;
    if (!wanted) return null;
    const plan = planReasoning(wire, config.defaultModel || "", config.provider);
    const level = resolveReasoningLevel(plan, wanted);
    if (!level) return null;
    const step = plan.steps[level];
    if (!step.ok || !step.send) return null;
    if (step.thinking === "enabled" && options.toolContinuation) return null;
    return {
        level,
        send: step.send,
        budget: step.budget,
        thinking: step.thinking,
        minMaxTokens: wire === "anthropic" && step.thinking !== "enabled" ? ADAPTIVE_MIN_MAX_TOKENS[level] : undefined,
    };
}
