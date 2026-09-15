"use client";

import { Fragment, useCallback, useContext, useEffect, useState } from "react";
import {
    Bell, Camera, Check, ChevronRight, Database, Image as ImageIcon, LayoutGrid, Loader2,
    MessageCircle, Smartphone, X, type LucideIcon,
} from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { retryFailedWrites } from "@/lib/storage-health";
import {
    runTroubleshootChecks,
    testDefaultChat,
    type Category,
    type CategoryId,
    type CheckAction,
    type CheckStep,
    type Symptom,
    type TestResult,
} from "@/lib/troubleshoot-checks";

const CAT_ICONS: Record<CategoryId, LucideIcon> = {
    chat: MessageCircle,
    proactive: Bell,
    moments: Camera,
    media: ImageIcon,
    data: Database,
    display: Smartphone,
    apps: LayoutGrid,
};
const RING = 2 * Math.PI * 20;

function countBy(steps: CheckStep[], state: CheckStep["state"]): number {
    return steps.filter(s => s.state === state).length;
}

function symptomBadge(sym: Symptom): { cls: string; label: string } {
    const bad = countBy(sym.steps, "bad");
    if (bad) return { cls: "is-bad", label: String(bad) };
    if (countBy(sym.steps, "warn")) return { cls: "is-warn", label: "注意" };
    if (countBy(sym.steps, "ok") && !countBy(sym.steps, "q")) return { cls: "is-ok", label: "正常" };
    return { cls: "is-q", label: "看说明" };
}

function initiallyOpen(cats: Category[]): Set<string> {
    return new Set(cats.flatMap(c => c.symptoms).filter(s => countBy(s.steps, "bad") > 0).map(s => s.id));
}

export function TroubleshootPage() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [cats, setCats] = useState<Category[] | null>(null);
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    const [test, setTest] = useState<TestResult | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [rechecking, setRechecking] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void runTroubleshootChecks().then(next => {
            if (cancelled) return;
            setCats(next);
            setOpen(initiallyOpen(next));
        });
        return () => { cancelled = true; };
    }, []);

    const recheck = useCallback(() => {
        setRechecking(true);
        void runTroubleshootChecks({ test }).then(next => {
            setCats(next);
            setRechecking(false);
        });
    }, [test]);

    useEffect(() => {
        setSubpageRightAction("troubleshoot",
            <button type="button" className="dg-pill is-ghost" disabled={rechecking} onClick={recheck}>
                {rechecking ? <Loader2 size={13} className="animate-spin" /> : "重查"}
            </button>,
        );
        return () => setSubpageRightAction("troubleshoot", null);
    }, [recheck, rechecking, setSubpageRightAction]);

    const onAction = async (action: CheckAction, key: string) => {
        if (action.page) {
            window.dispatchEvent(new CustomEvent("settings-navigate", { detail: { page: action.page } }));
            return;
        }
        if (action.run === "reload") {
            window.location.reload();
            return;
        }
        setBusy(key);
        try {
            let nextTest = test;
            if (action.run === "test-chat") {
                nextTest = await testDefaultChat();
                setTest(nextTest);
            } else if (action.run === "retry-storage") {
                await retryFailedWrites();
            } else if (action.run === "request-notify" && typeof Notification !== "undefined") {
                await Notification.requestPermission();
            } else if (action.run === "persist") {
                await navigator.storage?.persist?.();
            }
            setCats(await runTroubleshootChecks({ test: nextTest }));
        } finally {
            setBusy(null);
        }
    };

    const toggle = (id: string, isOpen: boolean) => {
        setOpen(prev => {
            if (prev.has(id) === isOpen) return prev;
            const next = new Set(prev);
            if (isOpen) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    if (!cats) {
        return (
            <div className="dg-page">
                <div className="dg-group">
                    <div className="dg-sum">
                        <Loader2 size={20} className="animate-spin text-[var(--c-icon)]" />
                        <span className="dg-sum-tx"><b>正在查…</b><span>不用联网的几项一秒内出结果</span></span>
                    </div>
                </div>
            </div>
        );
    }

    const symptoms = cats.flatMap(c => c.symptoms);
    const allSteps = symptoms.flatMap(s => s.steps);
    const bad = countBy(allSteps, "bad");
    const warn = countBy(allSteps, "warn");
    const troubled = symptoms.filter(s => countBy(s.steps, "bad") + countBy(s.steps, "warn") > 0).length;
    const ringColor = bad ? "var(--dg-bad)" : warn ? "var(--dg-warn)" : "var(--dg-ok)";
    const ringShare = bad || warn ? Math.max(0.08, troubled / symptoms.length) : 1;
    const head = `查了 ${cats.length} 类 ${symptoms.length} 项`;

    return (
        <div className="dg-page">
            <div className="dg-group">
                <div className="dg-sum">
                    <span className="dg-ring">
                        <svg viewBox="0 0 48 48" aria-hidden="true">
                            <circle cx="24" cy="24" r="20" fill="none" stroke="var(--dg-track)" strokeWidth="5" />
                            <circle cx="24" cy="24" r="20" fill="none" stroke={ringColor} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${ringShare * RING} ${RING}`} />
                        </svg>
                        <b style={{ color: ringColor }}>{bad || warn ? bad || warn : <Check size={18} strokeWidth={2.6} />}</b>
                    </span>
                    <span className="dg-sum-tx">
                        <b>{bad ? `${head}，${bad} 处要处理` : warn ? `${head}，${warn} 处提醒` : `${head}，都正常`}</b>
                        <span>{bad ? "带红色数字的已经展开，按顺序看卡在哪一步" : "遇到具体问题时，点开对应那一项看说明"}</span>
                    </span>
                </div>
            </div>

            {cats.map(cat => {
                const Icon = CAT_ICONS[cat.id];
                const steps = cat.symptoms.flatMap(s => s.steps);
                const catBad = countBy(steps, "bad");
                const catWarn = countBy(steps, "warn");
                return (
                    <section key={cat.id} className="dg-sec">
                        <div className="dg-cat-h">
                            <span className={`dg-tile ${catBad ? "is-bad" : catWarn ? "is-warn" : "is-gray"}`}><Icon size={13} strokeWidth={2} /></span>
                            <b>{cat.title}</b>
                            <span className={catBad ? "is-bad" : catWarn ? "is-warn" : ""}>
                                {catBad ? `${catBad} 处要处理` : catWarn ? `${catWarn} 处提醒` : `${cat.symptoms.length} 项`}
                            </span>
                        </div>
                        <div className="dg-group">
                            {cat.symptoms.map(sym => {
                                const badge = symptomBadge(sym);
                                return (
                                    <details key={sym.id} className="dg-sy" open={open.has(sym.id)} onToggle={e => toggle(sym.id, e.currentTarget.open)}>
                                        <summary>
                                            <span className="dg-sy-lb">{sym.title}</span>
                                            <span className={`dg-badge ${badge.cls}`}>{badge.label}</span>
                                            <ChevronRight size={12} className="dg-chev" />
                                        </summary>
                                        <div className="dg-steps">
                                            {sym.steps.map((st, i) => {
                                                const key = `${sym.id}-${i}`;
                                                return (
                                                    <div key={key} className={`dg-st is-${st.state}`}>
                                                        <span className={`dg-o is-${st.state}`}>
                                                            {st.state === "ok" ? <Check size={10} strokeWidth={3.2} /> : st.state === "bad" ? <X size={10} strokeWidth={3.2} /> : st.state === "warn" ? "!" : null}
                                                        </span>
                                                        <span className="dg-st-tx">{st.text}{st.sub && <small>{st.sub}</small>}</span>
                                                        {st.action && (
                                                            <button
                                                                type="button"
                                                                className={`dg-pill${st.state === "q" || st.state === "ok" ? " is-ghost" : ""}`}
                                                                disabled={busy === key}
                                                                onClick={() => void onAction(st.action!, key)}
                                                            >
                                                                {busy === key ? <Loader2 size={12} className="animate-spin" /> : st.action.label}
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                            {sym.codes && (
                                                <dl className="dg-codes">
                                                    {sym.codes.map(([code, hint]) => (
                                                        <Fragment key={code}><dt>{code}</dt><dd>{hint}</dd></Fragment>
                                                    ))}
                                                </dl>
                                            )}
                                            {sym.aside && <div className="dg-aside">{sym.aside}</div>}
                                        </div>
                                    </details>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
