"use client";

import { Fragment, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import type { ApiConfig } from "@/lib/settings-types";
import {
    REASONING_LEVELS,
    planReasoning,
    reasoningWireForConfig,
    resolveReasoningLevel,
    type ReasoningLevel,
} from "@/lib/reasoning-effort";

function JsonNodes({ value }: { value: unknown }): ReactNode {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        return (
            <>
                {"{ "}
                {entries.map(([key, v], i) => (
                    <Fragment key={key}>
                        {i > 0 ? ", " : ""}
                        <span className="dg-k">{key}</span>: <JsonNodes value={v} />
                    </Fragment>
                ))}
                {" }"}
            </>
        );
    }
    if (typeof value === "string") return <span className="dg-s">&quot;{value}&quot;</span>;
    return <span className="dg-n">{String(value)}</span>;
}

const levelLabel = (key: ReasoningLevel) => REASONING_LEVELS.find(s => s.key === key)?.label ?? key;

export function ReasoningDepthCard({ config, onChange }: {
    config: ApiConfig;
    onChange: (level: ReasoningLevel | undefined) => void;
}) {
    const plan = planReasoning(reasoningWireForConfig(config), config.defaultModel || "", config.provider);
    const isDefault = !config.reasoningEffort;
    const wanted: ReasoningLevel = config.reasoningEffort ?? "medium";
    const effective = resolveReasoningLevel(plan, wanted);
    const step = effective ? plan.steps[effective] : null;
    const send = !isDefault && step?.ok ? step.send : null;
    const idx = REASONING_LEVELS.findIndex(s => s.key === (effective ?? wanted));

    const notes: Array<{ tone: "" | "warn"; text: string }> = [];
    if (!isDefault) {
        const w = plan.steps[wanted];
        if (!w.ok) notes.push({ tone: "warn", text: effective ? `「${levelLabel(wanted)}」${w.why}，实际按「${levelLabel(effective)}」发` : w.why });
        if (step?.ok && step.note) notes.push({ tone: "", text: step.note });
    }

    return (
        <div className="flex flex-col gap-1">
            <label className="menu-desc ml-1">推理深度</label>
            <div className="dg-card">
                <div className="dg-depth">
                    <div className="dg-depth-top">
                        <b>想多深</b>
                        <span className="dg-fam">{plan.family}</span>
                    </div>
                    <div className={`dg-gauge${isDefault || !effective ? " is-off" : ""}`} role="radiogroup" aria-label="推理深度">
                        <span className="dg-rail" />
                        <span className="dg-fill" style={{ width: effective && !isDefault ? `${(idx / 5) * 83.33}%` : 0 }} />
                        {REASONING_LEVELS.map((s, i) => {
                            const st = plan.steps[s.key];
                            const on = !isDefault && !!effective && st.ok;
                            return (
                                <button
                                    key={s.key}
                                    type="button"
                                    role="radio"
                                    aria-checked={i === idx}
                                    disabled={isDefault || !st.ok}
                                    title={st.ok ? undefined : st.why}
                                    className={[!st.ok ? "is-na" : "", on && i <= idx ? "is-lit" : "", on && i === idx ? "is-cur" : ""].filter(Boolean).join(" ")}
                                    onClick={() => onChange(s.key)}
                                >
                                    <span className="dg-dot" />
                                    <span>{s.label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="dg-payload">
                        <div className="dg-payload-h"><span>这次请求会带上</span><span>{send ? plan.where : ""}</span></div>
                        <div>{send ? <JsonNodes value={send} /> : <span className="dg-payload-none">不带推理参数</span>}</div>
                    </div>
                    {notes.length > 0 && (
                        <div className="dg-notes">
                            {notes.map(n => (
                                <div key={n.text} className={`dg-note${n.tone ? ` is-${n.tone}` : ""}`}>
                                    <Info size={12} />
                                    <span>{n.text}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="dg-row">
                    <span className="dg-row-tx">
                        <b>按服务商默认</b>
                        <span>打开就不带推理参数，老配置照旧</span>
                    </span>
                    <Toggle
                        checked={isDefault}
                        onChange={(v) => onChange(v ? undefined : (resolveReasoningLevel(plan, "medium") ?? "medium"))}
                        aria-label="按服务商默认"
                    />
                </div>
            </div>
            <p className="dg-sec-f">想得越多越慢、越费 token。按模型名自动换写法；这个模型没有的档位点不了，认不出的模型什么都不发。管聊天、群聊、APP 等主请求，后台记忆总结这类小任务不受影响。</p>
        </div>
    );
}
