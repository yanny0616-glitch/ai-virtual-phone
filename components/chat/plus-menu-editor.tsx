"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, GripVertical } from "lucide-react";
import { useTouchSort } from "@/lib/use-touch-sort";
import { arrangePlusMenu, savePlusMenuPrefs, type PlusMenuPrefs } from "@/lib/chat-plus-menu";

export type PlusMenuEditorItem = { id: string; label: string; icon: ReactNode; tag?: string };

type Lists = { visible: string[]; rest: string[] };

const move = (list: string[], from: number, to: number): string[] => {
    const next = [...list];
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    return next;
};

export function PlusMenuEditor({ items, prefs, onClose }: {
    items: PlusMenuEditorItem[];
    prefs: PlusMenuPrefs | null;
    onClose: () => void;
}) {
    const [lists, setLists] = useState<Lists>(() => {
        const arranged = arrangePlusMenu(items, prefs);
        return { visible: arranged.visible.map(item => item.id), rest: arranged.rest.map(item => item.id) };
    });
    const touched = useRef(false);
    const byId = new Map(items.map(item => [item.id, item]));

    useEffect(() => {
        if (!touched.current) return;
        savePlusMenuPrefs({
            order: [...lists.visible, ...lists.rest],
            hidden: lists.rest,
            seen: prefs?.seen ?? items.filter(item => item.id.startsWith("app:")).map(item => item.id),
        });
        // prefs 和 items 跟着保存会回流，只在用户改动时写
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lists]);

    const update = (fn: (prev: Lists) => Lists) => { touched.current = true; setLists(fn); };
    const { containerRef: visibleRef, onTouchStart: visibleStart, onTouchMove: visibleMove, onTouchEnd: visibleEnd } =
        useTouchSort((from, to) => update(prev => ({ ...prev, visible: move(prev.visible, from, to) })));
    const { containerRef: restRef, onTouchStart: restStart, onTouchMove: restMove, onTouchEnd: restEnd } =
        useTouchSort((from, to) => update(prev => ({ ...prev, rest: move(prev.rest, from, to) })));

    const toggle = (id: string) => update(prev => prev.visible.includes(id)
        ? { visible: prev.visible.filter(x => x !== id), rest: [id, ...prev.rest] }
        : { visible: [...prev.visible, id], rest: prev.rest.filter(x => x !== id) });

    const row = (id: string, index: number, on: boolean, onStart: (index: number, e: React.TouchEvent) => void) => {
        const item = byId.get(id);
        if (!item) return null;
        return (
            <div key={id} className={`cx-row${on ? "" : " is-off"}`} onTouchStart={e => onStart(index, e)}>
                <button type="button" className="cx-ck" role="checkbox" aria-checked={on} aria-label={item.label} onClick={() => toggle(id)}>
                    <Check size={12} strokeWidth={3} />
                </button>
                <span className="cx-ti" aria-hidden="true">{item.icon}</span>
                <span className="cx-nm">{item.label}{item.tag && <span className={`cx-tag${item.tag === "新" ? " is-new" : ""}`}>{item.tag}</span>}</span>
                <span className="cx-grip" aria-hidden="true"><GripVertical size={16} /></span>
            </div>
        );
    };

    if (typeof document === "undefined") return null;
    return createPortal(
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet" role="dialog" aria-label="编辑「+」面板" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="dg-sh-head">
                    <b>编辑「+」面板</b>
                    <span className="cx-desc">勾上的放在面板里，没勾的收进「显示其余功能」。按住一行上下拖，调整顺序。所有聊天通用。</span>
                </div>
                <div className="dg-sh-body">
                    <div className="cx-list" ref={visibleRef} onTouchMove={visibleMove} onTouchEnd={visibleEnd} onTouchCancel={visibleEnd}>
                        {lists.visible.map((id, index) => row(id, index, true, visibleStart))}
                    </div>
                    {lists.rest.length > 0 && (
                        <div>
                            <div className="cx-split">收进「显示其余功能」</div>
                            <div className="cx-list" ref={restRef} onTouchMove={restMove} onTouchEnd={restEnd} onTouchCancel={restEnd}>
                                {lists.rest.map((id, index) => row(id, index, false, restStart))}
                            </div>
                        </div>
                    )}
                </div>
                <div className="dg-sh-foot">
                    <button type="button" className="dg-pill is-ghost" onClick={() => update(() => ({ visible: items.map(item => item.id), rest: [] }))}>恢复默认</button>
                    <button type="button" className="dg-pill" onClick={onClose}>完成</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
