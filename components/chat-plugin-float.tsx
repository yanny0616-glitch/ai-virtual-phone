"use client";

// components/chat-plugin-float.tsx
// float.panel 坑位：聊天之外的悬浮小窗宿主。
// 宿主只管窗框（标题栏、拖动、收起、位置记忆），窗体内部是插件的裸 DOM，和别的坑位一样。
// 没有插件认领时不产生任何 DOM。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

const POSITION_KEY = "ai_phone_plugin_float_pos_v1";
const MINIMIZED_KEY = "ai_phone_plugin_float_min_v1";
const MARGIN = 12;

type Position = { left: number; top: number };

function readStoredPosition(): Position | null {
    try {
        const raw = window.localStorage.getItem(POSITION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Position>;
        if (typeof parsed?.left !== "number" || typeof parsed?.top !== "number") return null;
        return { left: parsed.left, top: parsed.top };
    } catch {
        return null;
    }
}

export function ChatPluginFloat() {
    const runtime = getChatPluginRuntime();
    const slotVersion = useSyncExternalStore(
        runtime.subscribeSlotsChanged,
        () => runtime.getSlotsVersion(),
        () => 0,
    );
    const hasPlugins = runtime.getSlotRegistrations("float.panel").length > 0;

    const windowRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
    // 惰性初始化而不是进 effect 里 setState：插件是异步加载的，首帧两边都还没有坑位、渲染都是 null，
    // 等有插件时早已是纯客户端渲染，读 localStorage 不会和服务端渲染对不上。
    const [position, setPosition] = useState<Position | null>(() => (typeof window === "undefined" ? null : readStoredPosition()));
    const [minimized, setMinimized] = useState(() => {
        if (typeof window === "undefined") return false;
        try { return window.localStorage.getItem(MINIMIZED_KEY) === "1"; } catch { return false; }
    });

    // 落位后夹进可视范围：换了设备、转屏或窗口变小，存下来的坐标可能已经在屏外。
    const clampIntoView = useCallback(() => {
        const el = windowRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!el || !host) return;
        setPosition((prev) => {
            const maxLeft = Math.max(MARGIN, host.clientWidth - el.offsetWidth - MARGIN);
            const maxTop = Math.max(MARGIN, host.clientHeight - el.offsetHeight - MARGIN);
            const base = prev ?? { left: MARGIN, top: Math.max(MARGIN, host.clientHeight - el.offsetHeight - 96) };
            const next = {
                left: Math.min(Math.max(MARGIN, base.left), maxLeft),
                top: Math.min(Math.max(MARGIN, base.top), maxTop),
            };
            return next.left === prev?.left && next.top === prev?.top ? prev : next;
        });
    }, []);

    useEffect(() => {
        if (!hasPlugins) return;
        clampIntoView();
        window.addEventListener("resize", clampIntoView);
        return () => window.removeEventListener("resize", clampIntoView);
    }, [hasPlugins, minimized, clampIntoView]);

    useEffect(() => {
        const el = bodyRef.current;
        if (!el || !hasPlugins) return;
        const dispose = runtime.mountSlot("float.panel", el, {});
        return () => {
            dispose();
            el.replaceChildren();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slotVersion, hasPlugins]);

    function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
        const el = windowRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!el || !host) return;
        const rect = el.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        dragRef.current = {
            pointerId: event.pointerId,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        // 记下宿主原点，拖动过程中只做减法，避免每帧再取一次 rect。
        el.dataset.hostLeft = String(hostRect.left);
        el.dataset.hostTop = String(hostRect.top);
    }

    function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        const el = windowRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        if (!drag || drag.pointerId !== event.pointerId || !el || !host) return;
        const hostLeft = Number(el.dataset.hostLeft || 0);
        const hostTop = Number(el.dataset.hostTop || 0);
        const maxLeft = Math.max(MARGIN, host.clientWidth - el.offsetWidth - MARGIN);
        const maxTop = Math.max(MARGIN, host.clientHeight - el.offsetHeight - MARGIN);
        setPosition({
            left: Math.min(Math.max(MARGIN, event.clientX - hostLeft - drag.dx), maxLeft),
            top: Math.min(Math.max(MARGIN, event.clientY - hostTop - drag.dy), maxTop),
        });
    }

    function endDrag(event: React.PointerEvent<HTMLDivElement>) {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (position) {
            try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* 隐私模式 */ }
        }
    }

    function toggleMinimized() {
        setMinimized((prev) => {
            const next = !prev;
            try { window.localStorage.setItem(MINIMIZED_KEY, next ? "1" : "0"); } catch { /* 隐私模式 */ }
            return next;
        });
    }

    if (!hasPlugins) return null;

    return (
        <div
            ref={windowRef}
            className="plugin-float-window"
            data-minimized={minimized ? "" : undefined}
            style={position ? { left: position.left, top: position.top } : { left: MARGIN, bottom: 96 }}
        >
            <div
                className="plugin-float-header"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                <span className="plugin-float-title">插件</span>
                <button type="button" className="plugin-float-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={toggleMinimized} aria-label={minimized ? "展开插件悬浮窗" : "收起插件悬浮窗"}>
                    {minimized ? "▸" : "▾"}
                </button>
            </div>
            <div ref={bodyRef} className="plugin-float-body" data-chat-plugin-slot="float.panel" />
        </div>
    );
}
