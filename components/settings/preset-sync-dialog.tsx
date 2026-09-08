"use client";

import { useEffect, useRef, useState } from "react";
import { ContentDialog } from "@/components/ui/modal";
import { getPromptTags } from "@/lib/content-tag-utils";
import { PRESET_SYNC_FIELDS, type PresetEntryDiff, type PresetSyncField } from "@/lib/preset-entry-sync";
import type { Prompt } from "@/lib/settings-types";

function fieldText(prompt: Prompt, field: PresetSyncField): string {
    if (field === "tags") return getPromptTags(prompt).join("、") || "通用";
    const value = prompt[field];
    if (field === "injection_position") return value === 1 ? "绝对位置" : "相对位置";
    if (field === "injection_depth") return String(value ?? 0);
    if (["marker", "system_prompt", "forbid_overrides"].includes(field)) return value === true ? "是" : "否";
    return String(value ?? "") || "（空）";
}

export function PresetSyncDialog({ sourceName, targetName, entries, warnings, onConfirm, onClose }: {
    sourceName: string;
    targetName: string;
    entries: PresetEntryDiff[];
    warnings: string[];
    onConfirm: (selected: PresetEntryDiff[]) => string | null;
    onClose: () => void;
}) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const dialog = bodyRef.current?.closest<HTMLElement>('[role="dialog"]');
        if (!dialog) return;
        const previous = document.activeElement;
        dialog.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
            if (event.key !== "Tab") return;
            const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')]
                .filter(element => element.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1];
            if (!first) { event.preventDefault(); return; }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
                event.preventDefault(); first.focus();
            }
        };
        dialog.addEventListener("keydown", onKey);
        return () => { dialog.removeEventListener("keydown", onKey); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
    }, [onClose]);
    const missing = entries.filter(entry => entry.kind === "missing").length;
    return <ContentDialog title="同步内置条目" onCancel={onClose}
        dialogClassName="!w-[92%] !max-w-[560px] !outline-none [&_.modal-title]:!text-[14px] [&_.modal-body_p]:!text-[11px] [&_.modal-footer_button]:!text-[12px]"
        confirmLabel={`同步所选（${selected.size}）`} confirmDisabled={selected.size === 0}
        onConfirm={() => setError(onConfirm(entries.filter(entry => selected.has(entry.identifier))))}>
        <div ref={bodyRef} className="flex flex-col gap-3 text-[12px] leading-relaxed">
            <p className="menu-desc !mt-0">从“{sourceName}”同步到“{targetName}”。更新勾选条目的内容和属性；已有开关、排序及额外条目保留。新增条目沿用内置开关状态。</p>
            <div className="flex items-center justify-between gap-2">
                <span>缺少 {missing} 项 · 有差异 {entries.length - missing} 项</span>
                {entries.length > 0 && <button type="button" className="ui-btn ui-btn-ghost !min-h-[44px] !px-2 !text-[11px]"
                    onClick={() => { setSelected(selected.size === entries.length ? new Set() : new Set(entries.map(entry => entry.identifier))); setError(null); }}>
                    {selected.size === entries.length ? "取消全选" : "全选"}
                </button>}
            </div>
            {error && <p role="alert" className="text-[var(--c-danger,#c54b4b)]">{error}</p>}
            {warnings.map(warning => <p key={warning} className="menu-desc !mt-0">{warning}</p>)}
            <div className="max-h-[48dvh] overflow-y-auto overscroll-contain">
                {!entries.length && <p className="menu-desc !mt-0">没有缺少或有差异的条目。仅开关、排序不同不会列入同步。</p>}
                {entries.map(entry => <div key={entry.identifier} className="border-t border-[var(--c-border,rgba(0,0,0,0.08))] py-2">
                    <label className="flex min-h-[44px] cursor-pointer items-start gap-3 py-2">
                        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-black" checked={selected.has(entry.identifier)}
                            onChange={() => { setSelected(previous => { const next = new Set(previous); if (next.has(entry.identifier)) next.delete(entry.identifier); else next.add(entry.identifier); return next; }); setError(null); }} />
                        <span className="min-w-0 flex-1 break-words">
                            <span className="font-semibold">{entry.source.name || "未命名条目"}</span>
                            <span className="ml-2 text-[11px] text-[var(--c-text-sub,#888)]">{entry.kind === "missing" ? "缺少 · 将新增" : "有差异 · 将更新"}</span>
                            {entry.kind === "changed" && <span className="mt-1 block text-[11px] text-[var(--c-text-sub,#888)]">{entry.fields.map(field => PRESET_SYNC_FIELDS[field]).join("、")}</span>}
                        </span>
                    </label>
                    <details className="ml-7 text-[11px]">
                        <summary className="min-h-[36px] cursor-pointer py-2 text-[var(--c-text-sub,#888)]">{entry.kind === "missing" ? "查看新增内容" : "查看差异"}</summary>
                        <div className="flex flex-col gap-3 rounded-xl bg-black/[0.025] p-3">
                            {entry.fields.map(field => <div key={field}>
                                <div className="mb-1 font-semibold">{PRESET_SYNC_FIELDS[field]}</div>
                                {entry.current && <><div className="text-[var(--c-text-sub,#888)]">当前</div><div className="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{fieldText(entry.current, field)}</div></>}
                                <div className="text-[var(--c-text-sub,#888)]">内置</div>
                                <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{fieldText(entry.source, field)}</div>
                            </div>)}
                        </div>
                    </details>
                </div>)}
            </div>
        </div>
    </ContentDialog>;
}
