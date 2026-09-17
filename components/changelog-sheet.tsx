"use client";

import { useEffect, useState } from "react";
import {
    BookOpen, Brain, ChevronRight, Cpu, Database, Heart, Image as ImageIcon, Layers, MessageCircle,
    Moon, Palette, Phone, ScrollText, Settings, Sparkles, Wrench, type LucideIcon,
} from "lucide-react";
import {
    changelogAfter,
    fetchLocalChangelog,
    formatChangelogDate,
    loadSeenChangelogId,
    markChangelogSeen,
    type ChangelogEntry,
    type ChangelogItem,
} from "@/lib/changelog";
import { loadApiConfigs } from "@/lib/settings-storage";

const AREA_ICONS: Record<string, LucideIcon> = {
    聊天: MessageCircle, 生图: ImageIcon, 外观: Palette, 预设: Layers, API: Cpu, 存储: Database, 设置: Settings,
    挂念: Heart, 记忆: Brain, 工坊: Wrench, 小红书: BookOpen, 陪眠: Moon, 通话: Phone,
};
const TONES = ["is-accent", "is-ok", "is-warn", "is-bad", "is-gray"];
const POPUP_DELAY_MS = 1500;

function groupByArea(items: ChangelogItem[]): Array<[string, ChangelogItem[]]> {
    const groups = new Map<string, ChangelogItem[]>();
    for (const it of items) groups.set(it.area, [...(groups.get(it.area) ?? []), it]);
    return [...groups.entries()];
}

export function ChangelogLines({ items }: { items: ChangelogItem[] }) {
    return (
        <>
            {items.map(it => <div key={it.text} className={`dg-ln dg-c-${it.kind}`}>{it.text}</div>)}
        </>
    );
}

export function ChangelogSheet({ title, entries, onClose }: {
    title: string;
    entries: ChangelogEntry[];
    onClose: () => void;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const count = entries.reduce((n, e) => n + e.items.length, 0);
    const newest = entries[0];
    return (
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="dg-sh-head">
                    <b>{title}</b>
                    {newest && (
                        <div className="dg-ver">
                            <code>{newest.id}</code>
                            <span>{entries.length > 1 ? `${entries.length} 次更新 · ` : `${formatChangelogDate(newest.date)} · `}共 {count} 处改动</span>
                        </div>
                    )}
                    <div className="dg-legend">
                        <span className="dg-c-new">新功能</span>
                        <span className="dg-c-opt">优化</span>
                        <span className="dg-c-fix">要你动手</span>
                    </div>
                </div>
                <div className="dg-sh-body">
                    {entries.map(entry => (
                        <div key={entry.id} className="dg-entry">
                            {entries.length > 1 && <div className="dg-entry-date">{formatChangelogDate(entry.date)}</div>}
                            {groupByArea(entry.items).map(([area, items], i) => {
                                const Icon = AREA_ICONS[area] ?? Sparkles;
                                return (
                                    <div key={area} className="dg-mod">
                                        <span className={`dg-tile ${TONES[i % TONES.length]}`}><Icon size={15} strokeWidth={1.9} /></span>
                                        <div className="dg-mod-b">
                                            <h4>{area}</h4>
                                            <ChangelogLines items={items} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <div className="dg-sh-foot">
                    <span>设置 → 关于与声明 里随时能再看</span>
                    <button type="button" className="dg-pill" onClick={onClose}>知道了</button>
                </div>
            </div>
        </div>
    );
}

/** 启动时：有没看过的更新就弹一次。全新安装（还没配过 API）不弹，直接记成已读。 */
export function ChangelogPopup() {
    const [entries, setEntries] = useState<ChangelogEntry[]>([]);

    useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void fetchLocalChangelog().then(all => {
                if (cancelled || !all.length) return;
                const seen = loadSeenChangelogId();
                const newestId = all[0].id;
                if (seen === newestId) return;
                if (seen === null && !loadApiConfigs().some(c => c.apiKey)) {
                    markChangelogSeen(newestId);
                    return;
                }
                const unseen = seen === null ? all.slice(0, 1) : changelogAfter(all, seen).slice(0, 3);
                if (unseen.length) setEntries(unseen);
                else markChangelogSeen(newestId);
            });
        }, POPUP_DELAY_MS);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, []);

    if (!entries.length) return null;
    const close = () => {
        markChangelogSeen(entries[0].id);
        setEntries([]);
    };
    return <ChangelogSheet title="小手机更新好了" entries={entries} onClose={close} />;
}

/** 关于页里的一行：以前的更新日志 */
export function ChangelogHistoryRow() {
    const [entries, setEntries] = useState<ChangelogEntry[]>([]);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void fetchLocalChangelog().then(all => { if (!cancelled) setEntries(all); });
        return () => { cancelled = true; };
    }, []);

    if (!entries.length) return null;
    return (
        <>
            <button type="button" className="g-card flex-row items-center" onClick={() => setOpen(true)}>
                <ScrollText size={20} className="shrink-0 text-[var(--c-icon-active)]" />
                <span className="menu-label flex-1 text-left">更新日志</span>
                <span className="menu-desc !mt-0">{entries.length} 次</span>
                <ChevronRight size={16} className="shrink-0 text-[var(--c-icon)]" />
            </button>
            {open && <ChangelogSheet title="更新日志" entries={entries} onClose={() => setOpen(false)} />}
        </>
    );
}
