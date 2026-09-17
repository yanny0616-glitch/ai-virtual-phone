"use client";

import { AlertTriangle, Check, Info } from "lucide-react";
import { determineBaseUrl } from "@/lib/api-helpers";
import { fixApiBaseUrl } from "@/lib/api-url";

function tailFor(provider: string): string {
    if (provider === "Anthropic") return "/messages";
    if (provider === "Google") return "/models/…:generateContent";
    return "/chat/completions";
}

export function ApiUrlPreview({ provider, baseUrl, onApply, onSwitchProvider }: {
    provider: string;
    baseUrl?: string;
    onApply: (fixed: string) => void;
    onSwitchProvider: (provider: string) => void;
}) {
    const raw = (baseUrl || "").trim();
    if (!raw) {
        const official = determineBaseUrl({ provider });
        if (!official) {
            return (
                <div className="dg-req">
                    <div className="dg-note is-warn"><AlertTriangle size={12} /><span>自定义服务商要填地址，一般是中转站给的那串，以 /v1 结尾</span></div>
                </div>
            );
        }
        return (
            <div className="dg-req">
                <div className="dg-req-h"><span className="dg-verb">POST</span>留空，用官方地址</div>
                <div className="dg-url">{official}<span className="dg-url-tail">{tailFor(provider)}</span></div>
            </div>
        );
    }

    const fix = fixApiBaseUrl(provider, raw);
    const canApply = !!fix.base && fix.base !== raw.replace(/\/+$/, "");
    const { parts, suggest } = fix;
    return (
        <>
            <div className="dg-req">
                <div className="dg-req-h"><span className="dg-verb">POST</span>实际会请求</div>
                {!fix.invalid && (
                    <div className="dg-url">
                        {parts.scheme && <span className="dg-url-add">{parts.scheme}</span>}
                        {parts.kept}
                        {parts.cut && <span className="dg-url-cut">{parts.cut}</span>}
                        {parts.add && <span className="dg-url-add">{parts.add}</span>}
                        {parts.tail && <span className="dg-url-tail">{parts.tail}</span>}
                    </div>
                )}
                {fix.notes.length > 0 && (
                    <div className="dg-notes">
                        {fix.notes.map(n => (
                            <div key={n.text} className={`dg-note ${n.tone === "ok" ? "is-ok" : "is-bad"}`}>
                                {n.tone === "ok" ? <Check size={12} /> : <Info size={12} />}
                                <span>{n.text}</span>
                            </div>
                        ))}
                    </div>
                )}
                {canApply && (
                    <div className="dg-req-act">
                        <button type="button" className="dg-pill is-soft" onClick={() => onApply(fix.base)}>改成这个</button>
                    </div>
                )}
            </div>
            {suggest && (
                <div className="dg-suggest">
                    <AlertTriangle size={15} />
                    <span>{suggest.text}</span>
                    <button type="button" className="dg-pill" onClick={() => onSwitchProvider(suggest.provider)}>切换</button>
                </div>
            )}
        </>
    );
}
