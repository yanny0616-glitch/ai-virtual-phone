"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Database, HardDrive, Loader2, X } from "lucide-react";
import {
    getServerStorageHealth,
    getStorageHealth,
    refreshStorageEstimate,
    retryFailedWrites,
    storageUsageRatio,
    subscribeStorageHealth,
    unsavedMessageTexts,
} from "@/lib/storage-health";

const FULL_RATIO = 0.9;
const ESTIMATE_EVERY_MS = 10 * 60_000;

function formatBytes(n: number): string {
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

function hhmm(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function openDataSettings(): void {
    window.dispatchEvent(new CustomEvent("mascot-navigate", { detail: { app: "settings", mode: "data" } }));
}

export function StorageHealthBanner() {
    const health = useSyncExternalStore(subscribeStorageHealth, getStorageHealth, getServerStorageHealth);
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [fullDismissed, setFullDismissed] = useState(false);
    const [savedAt, setSavedAt] = useState(0);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        void refreshStorageEstimate();
        const timer = window.setInterval(() => { void refreshStorageEstimate(); }, ESTIMATE_EVERY_MS);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!savedAt) return;
        const timer = window.setTimeout(() => setSavedAt(0), 2500);
        return () => window.clearTimeout(timer);
    }, [savedAt]);

    const ratio = storageUsageRatio(health);
    const unsaved = health.failures.length + health.overflow;
    const broken = unsaved > 0 || health.connectionLost;
    const lostCss = health.unsavedMessageIds.length && typeof CSS !== "undefined"
        ? `${health.unsavedMessageIds.map(id => `[data-msg-id="${CSS.escape(id)}"]`).join(",")}{outline:1.5px dashed var(--dg-bad);outline-offset:3px}`
        : "";

    const retry = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const left = await retryFailedWrites();
            if (!left) {
                setOpen(false);
                setSavedAt(Date.now());
            }
        } finally {
            setBusy(false);
        }
    };

    const copyTexts = async () => {
        const text = unsavedMessageTexts().join("\n\n");
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
        } catch {
            setOpen(true);
        }
    };

    if (broken) {
        const last = health.failures[health.failures.length - 1];
        const texts = health.failedRetries > 0 ? unsavedMessageTexts() : [];
        const nearFull = ratio !== null && ratio >= 0.8;
        const title = unsaved ? `有 ${unsaved} 处内容没存上` : "数据库连接断了";
        const desc = health.failedRetries >= 2
            ? "重试也存不上。先复制下没存上的文字，再完全关掉小手机重开；重开后这些不会自己回来。"
            : health.failedRetries === 1
                ? nearFull ? "还是没存上：存储快满了，先去清理再重试。" : "还是没存上。等几秒再点一次重试。"
                : !last
                    ? "浏览器把数据库断开了，iPhone 切后台久了常见。点重试重新连上。"
                    : `最近一条是 ${hhmm(last.at)} 的${last.label}（${last.error}）。关掉页面前先点重试。`;
        return (
            <>
                {lostCss && <style>{lostCss}</style>}
                <div className="dg-banner" role="alert">
                    <div className="dg-banner-main">
                        <span className="dg-tile is-round is-bad"><Database size={15} /></span>
                        <button type="button" className="dg-banner-tx" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                            <b>{title}</b>
                            <span>{desc}</span>
                        </button>
                        <button type="button" className="dg-pill" disabled={busy} onClick={() => void retry()}>
                            {busy ? <Loader2 size={13} className="animate-spin" /> : "重试"}
                        </button>
                    </div>
                    {open && (
                        <div className="dg-banner-list">
                            {health.failures.slice(-6).reverse().map(f => (
                                <span key={f.id}><b>{hhmm(f.at)} · {f.label}</b>{f.preview ? ` · 「${f.preview}」` : ""}{f.retryable ? "" : " · 这条重试不了"}</span>
                            ))}
                            {health.overflow > 0 && <span>另有 {health.overflow} 处太多了，没留住内容，重试也补不回</span>}
                            {health.unsavedMessageIds.length > 0 && <span>聊天里画了红色虚线框的就是没存上的消息</span>}
                        </div>
                    )}
                    {(texts.length > 0 || nearFull) && (
                        <div className="dg-banner-acts">
                            {nearFull && <button type="button" className="dg-pill is-ghost" onClick={openDataSettings}>去清理</button>}
                            {texts.length > 0 && (
                                <button type="button" className="dg-pill is-ghost" onClick={() => void copyTexts()}>
                                    {copied ? "已复制" : `复制 ${texts.length} 条文字`}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </>
        );
    }

    if (savedAt) {
        return (
            <div className="dg-banner" role="status">
                <div className="dg-banner-main">
                    <span className="dg-tile is-round is-ok"><Check size={15} /></span>
                    <span className="dg-banner-tx"><b>都存上了</b></span>
                </div>
            </div>
        );
    }

    if (ratio !== null && ratio >= FULL_RATIO && !fullDismissed && health.usage !== null && health.quota !== null) {
        return (
            <div className="dg-banner" role="alert">
                <div className="dg-banner-main">
                    <span className="dg-tile is-round is-warn"><HardDrive size={15} /></span>
                    <span className="dg-banner-tx">
                        <b>存储快满了</b>
                        <span>{formatBytes(health.usage)} / 约 {formatBytes(health.quota)}。满了新消息存不上，浏览器还可能清掉旧记录。</span>
                        <span className="dg-bar"><i style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} /></span>
                    </span>
                    <button type="button" className="dg-pill" onClick={openDataSettings}>去清理</button>
                    <button type="button" className="dg-banner-x" aria-label="这次先不管" onClick={() => setFullDismissed(true)}><X size={14} /></button>
                </div>
            </div>
        );
    }

    return null;
}
