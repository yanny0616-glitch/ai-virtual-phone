"use client";

// 长期记忆总结进度：自动和手动总结都在这里冒条，停在哪个 App 都看得见。
// 进行中的条常驻并带「停止」；结果条到点消失。挂在微信同步 toast 同一位置（状态栏下方）。

import { useEffect, useRef, useState } from "react";
import { MEMORY_SUMMARY_TOAST_EVENT, requestStopSummarization, type MemorySummaryToast as ToastDetail } from "@/lib/memory-summarizer";

type Entry = { characterId: string; text: string; running: boolean; stopping: boolean };

export function MemorySummaryToast() {
    const [entries, setEntries] = useState<Entry[]>([]);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    useEffect(() => {
        const timersMap = timers.current;
        const remove = (id: string) => {
            clearTimeout(timersMap.get(id));
            timersMap.delete(id);
            setEntries(prev => prev.filter(entry => entry.characterId !== id));
        };
        const onToast = (event: Event) => {
            const detail = (event as CustomEvent<ToastDetail>).detail;
            if (!detail?.characterId) return;
            const id = detail.characterId;
            if (!detail.text) { remove(id); return; }
            clearTimeout(timersMap.get(id));
            timersMap.delete(id);
            const entry: Entry = { characterId: id, text: detail.text, running: detail.running, stopping: detail.stopping === true };
            setEntries(prev => [...prev.filter(item => item.characterId !== id), entry]);
            if (!detail.running) timersMap.set(id, setTimeout(() => remove(id), Math.max(1500, Number(detail.duration) || 2500)));
        };
        window.addEventListener(MEMORY_SUMMARY_TOAST_EVENT, onToast);
        return () => {
            window.removeEventListener(MEMORY_SUMMARY_TOAST_EVENT, onToast);
            for (const timer of timersMap.values()) clearTimeout(timer);
            timersMap.clear();
        };
    }, []);

    if (entries.length === 0) return null;
    return (
        <div
            style={{
                position: "fixed",
                left: "50%",
                top: "calc(env(safe-area-inset-top, 0px) + 44px)",
                transform: "translateX(-50%)",
                zIndex: 3000,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                pointerEvents: "none",
                maxWidth: "calc(100vw - 32px)",
            }}
        >
            {entries.map(entry => (
                <div
                    className="wp-toast"
                    key={entry.characterId}
                    style={{ position: "static", display: "flex", alignItems: "center", gap: 10, padding: entry.running ? "6px 8px 6px 16px" : undefined }}
                >
                    <span>{entry.text}</span>
                    {entry.running && (
                        <button
                            type="button"
                            disabled={entry.stopping}
                            onClick={() => requestStopSummarization(entry.characterId)}
                            style={{
                                pointerEvents: "auto",
                                flexShrink: 0,
                                border: "none",
                                borderRadius: 12,
                                padding: "3px 10px",
                                background: "rgba(255,255,255,0.18)",
                                color: "inherit",
                                font: "inherit",
                                opacity: entry.stopping ? 0.5 : 1,
                            }}
                        >
                            {entry.stopping ? "停止中" : "停止"}
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}
