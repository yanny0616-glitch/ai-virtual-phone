"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, PencilLine, RefreshCw, X } from "lucide-react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_MS = 280;

const ACTION_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 5,
    minWidth: 64,
    color: "#fff",
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "calc(12px*var(--app-text-scale,1))",
    opacity: 0.92,
};

const ACTION_ICON_STYLE: CSSProperties = {
    width: 42,
    height: 42,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.14)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
};

function Action({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={disabled}
            style={{ ...ACTION_STYLE, opacity: disabled ? 0.4 : ACTION_STYLE.opacity }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); e.preventDefault(); onClick(); }}
        >
            <span style={ACTION_ICON_STYLE}>{icon}</span>
            {label}
        </button>
    );
}

type Point = { x: number; y: number };

/**
 * 全屏媒体预览层：图片（或未生成时的文字描述）+ 下方操作按钮排。
 * 聊天、朋友圈、小卷共用——聊天流里不放常驻小按钮，保存/编辑/重新生成都收在这里。
 * 图片可双指捏合缩放、双击放大或还原、放大后拖动；没放大时单击关闭。
 * 只传 onRegenerate 的调用方沿用「重新生成」一个按钮（点了由调用方自己弹框）。
 */
export function MediaPreviewOverlay({
    imageUrl,
    description,
    saveFilename,
    onEdit,
    onRegenerate,
    regenerating,
    onClose,
}: {
    imageUrl?: string | null;
    description?: string;
    saveFilename?: string;
    onEdit?: () => void;
    onRegenerate?: () => void;
    regenerating?: boolean;
    onClose: () => void;
}) {
    // 保存要重新拉一次图片，慢网络下会卡一下——按钮上给个状态
    const [saving, setSaving] = useState(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const pillRef = useRef<HTMLDivElement>(null);
    const view = useRef({ s: 1, x: 0, y: 0 });
    const pointers = useRef(new Map<number, Point>());
    const pinch = useRef<{ d: number; s: number; x: number; y: number; m: Point } | null>(null);
    const drag = useRef<{ p: Point; x: number; y: number } | null>(null);
    const tap = useRef<{ start: Point; at: number; moved: boolean } | null>(null);
    const lastTap = useRef<{ p: Point; at: number } | null>(null);
    const closeTimer = useRef<number | null>(null);
    const pillTimer = useRef<number | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            if (closeTimer.current) window.clearTimeout(closeTimer.current);
            if (pillTimer.current) window.clearTimeout(pillTimer.current);
        };
    }, [onClose]);

    const paint = useCallback((animate = false) => {
        const img = imgRef.current;
        if (!img) return;
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        img.style.transition = animate && !reduce ? "transform 0.2s ease-out" : "none";
        const { s, x, y } = view.current;
        img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
        const pill = pillRef.current;
        if (pill) {
            pill.textContent = `${Math.round(s * 100)}%`;
            pill.style.opacity = "1";
            if (pillTimer.current) window.clearTimeout(pillTimer.current);
            pillTimer.current = window.setTimeout(() => { pill.style.opacity = "0"; }, 900);
        }
    }, []);

    useEffect(() => {
        view.current = { s: 1, x: 0, y: 0 };
        const img = imgRef.current;
        if (img) img.style.transform = "";
    }, [imageUrl]);

    // 图的未变换布局框（offset* 不受 transform 影响）+ 舞台尺寸；缩放后的图不许拖离舞台
    const bound = useCallback(() => {
        const img = imgRef.current;
        const stage = stageRef.current;
        const v = view.current;
        if (!img || !stage) return;
        if (v.s <= 1.01) { view.current = { s: 1, x: 0, y: 0 }; return; }
        const W = stage.clientWidth, H = stage.clientHeight;
        const w = img.offsetWidth * v.s, h = img.offsetHeight * v.s;
        const left = Math.max(Math.min(W - w, (W - w) / 2), Math.min(Math.max(0, (W - w) / 2), img.offsetLeft + v.x));
        const top = Math.max(Math.min(H - h, (H - h) / 2), Math.min(Math.max(0, (H - h) / 2), img.offsetTop + v.y));
        view.current = { s: v.s, x: left - img.offsetLeft, y: top - img.offsetTop };
    }, []);

    const zoomAt = useCallback((next: number, p: Point, animate = false) => {
        const img = imgRef.current;
        if (!img) return;
        const v = view.current;
        const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
        const ox = p.x - img.offsetLeft, oy = p.y - img.offsetTop;
        view.current = { s, x: ox - (ox - v.x) * s / v.s, y: oy - (oy - v.y) * s / v.s };
        bound();
        paint(animate);
    }, [bound, paint]);

    const local = (e: { clientX: number; clientY: number }): Point => {
        const rect = stageRef.current?.getBoundingClientRect();
        return { x: e.clientX - (rect?.left || 0), y: e.clientY - (rect?.top || 0) };
    };

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = local(e);
        pointers.current.set(e.pointerId, p);
        if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.current.s, x: view.current.x, y: view.current.y, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
            drag.current = null;
            tap.current = null;
        } else if (pointers.current.size === 1) {
            drag.current = { p, x: view.current.x, y: view.current.y };
            tap.current = { start: p, at: Date.now(), moved: false };
        }
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!pointers.current.has(e.pointerId)) return;
        const p = local(e);
        pointers.current.set(e.pointerId, p);
        const img = imgRef.current;
        if (pinch.current && pointers.current.size >= 2 && img) {
            const [a, b] = [...pointers.current.values()];
            const start = pinch.current;
            const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.s * Math.hypot(a.x - b.x, a.y - b.y) / start.d));
            const ox = start.m.x - img.offsetLeft, oy = start.m.y - img.offsetTop;
            view.current = { s, x: ox - (ox - start.x) * s / start.s + (m.x - start.m.x), y: oy - (oy - start.y) * s / start.s + (m.y - start.m.y) };
            bound();
            paint();
            return;
        }
        if (tap.current && Math.hypot(p.x - tap.current.start.x, p.y - tap.current.start.y) > 6) tap.current.moved = true;
        if (drag.current && view.current.s > 1) {
            view.current = { ...view.current, x: drag.current.x + p.x - drag.current.p.x, y: drag.current.y + p.y - drag.current.p.y };
            bound();
            paint();
        }
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
        if (pointers.current.size === 1) {
            const [rest] = [...pointers.current.values()];
            drag.current = { p: rest, x: view.current.x, y: view.current.y };
            return;
        }
        drag.current = null;
        const t = tap.current;
        tap.current = null;
        if (!t || t.moved || Date.now() - t.at > 400) return;
        const now = Date.now();
        const prev = lastTap.current;
        if (prev && now - prev.at < TAP_MS && Math.hypot(prev.p.x - t.start.x, prev.p.y - t.start.y) < 30) {
            lastTap.current = null;
            if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
            zoomAt(view.current.s > 1 ? 1 : DOUBLE_TAP_SCALE, t.start, true);
            return;
        }
        lastTap.current = { p: t.start, at: now };
        if (view.current.s > 1) return;
        closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose(); }, TAP_MS);
    };

    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        zoomAt(view.current.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), local(e));
    };

    const save = async () => {
        if (!imageUrl || !saveFilename) return;
        setSaving(true);
        try {
            const { downloadUrl } = await import("@/lib/download-utils");
            await downloadUrl(imageUrl, saveFilename);
        } finally {
            setSaving(false);
        }
    };

    if (typeof document === "undefined") return null;
    const hasActions = Boolean(onEdit || onRegenerate || (imageUrl && saveFilename));
    return createPortal(
        <div
            style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.9)", display: "flex", flexDirection: "column", color: "#fff" }}
            onClick={imageUrl ? undefined : onClose}
        >
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "calc(env(safe-area-inset-top, 0px) + 10px) 14px 6px" }}>
                <button
                    type="button"
                    aria-label="关闭"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); onClose(); }}
                    style={{ width: 32, height: 32, borderRadius: "50%", border: "none", background: "rgba(255,255,255,0.14)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                >
                    <X size={17} />
                </button>
            </div>
            {imageUrl ? (
                <div
                    ref={stageRef}
                    style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", touchAction: "none", display: "flex", alignItems: "center", justifyContent: "center" }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onWheel={onWheel}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        ref={imgRef}
                        src={imageUrl}
                        alt=""
                        draggable={false}
                        style={{ maxWidth: "94%", maxHeight: "94%", objectFit: "contain", transformOrigin: "0 0", willChange: "transform", userSelect: "none", pointerEvents: "none" }}
                    />
                    <div
                        ref={pillRef}
                        style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", padding: "4px 9px", borderRadius: 999, background: "rgba(255,255,255,0.16)", fontSize: "calc(11px*var(--app-text-scale,1))", fontVariantNumeric: "tabular-nums", opacity: 0, transition: "opacity 0.2s", pointerEvents: "none" }}
                    />
                </div>
            ) : description ? (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div
                        style={{ color: "#fff", opacity: 0.9, maxWidth: "min(85vw, 420px)", maxHeight: "60vh", overflowY: "auto", fontSize: "calc(14px*var(--app-text-scale,1))", lineHeight: 1.6, whiteSpace: "pre-wrap", textAlign: "center" }}
                        onClick={e => e.stopPropagation()}
                    >
                        {description}
                    </div>
                </div>
            ) : <div style={{ flex: 1 }} />}
            {hasActions && (
                <div
                    style={{ display: "flex", justifyContent: "center", gap: 28, padding: "12px 18px calc(env(safe-area-inset-bottom, 0px) + 22px)" }}
                    onClick={e => e.stopPropagation()}
                >
                    {onEdit && <Action icon={<PencilLine size={19} />} label="编辑" disabled={regenerating} onClick={onEdit} />}
                    {onRegenerate && (
                        <Action
                            icon={<RefreshCw size={19} />}
                            label={regenerating ? "生成中…" : onEdit ? "重新生图" : "重新生成"}
                            disabled={regenerating}
                            onClick={onRegenerate}
                        />
                    )}
                    {imageUrl && saveFilename && (
                        <Action icon={<Download size={19} />} label={saving ? "保存中…" : "保存"} disabled={saving} onClick={() => { void save(); }} />
                    )}
                </div>
            )}
        </div>,
        document.body,
    );
}
