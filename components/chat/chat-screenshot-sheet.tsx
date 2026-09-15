"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, X } from "lucide-react";
import { shareOrDownloadFile } from "@/lib/share-file";

export const SCREENSHOT_MAX = 80;
/** iPhone 上画布超过约 1600 万像素会直接出空白图 */
const MAX_CANVAS_AREA = 16_000_000;

type ShotOptions = { avatar: boolean; name: boolean; time: boolean; background: boolean; watermark: boolean };
export type ShotRow = { renderId: string; storedId: string; at: string };

const OPTION_ROWS: { key: keyof ShotOptions; label: string; on: string; off: string }[] = [
    { key: "avatar", label: "头像", on: "显示", off: "隐藏" },
    { key: "name", label: "对方名字", on: "显示", off: "打码" },
    { key: "time", label: "时间", on: "显示", off: "隐藏" },
    { key: "background", label: "背景", on: "聊天背景", off: "纯色" },
    { key: "watermark", label: "角落水印", on: "加", off: "不加" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const MASK = "▇▇▇";

function dayLabel(rows: ShotRow[]): string {
    const days = rows.map(r => new Date(r.at)).filter(d => !Number.isNaN(d.getTime()));
    if (!days.length) return "";
    const fmt = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
    const first = days[0];
    const last = days[days.length - 1];
    return first.toDateString() === last.toDateString() ? `${first.getFullYear()}年${fmt(first)}` : `${fmt(first)} – ${fmt(last)}`;
}

function isExternalImage(src: string): boolean {
    if (!/^https?:/i.test(src)) return false;
    try {
        return new URL(src).origin !== window.location.origin;
    } catch {
        return false;
    }
}

const solid = (color: string) => (!color || color === "transparent" || /rgba\(.*,\s*0\)$/.test(color) ? "" : color);

// 把选中的消息行克隆进聊天页根节点里一个看不见的舞台：留在 .session-<id> 底下，
// 用户的自定义 CSS 照样命中；再把消息列表外层几层的 class 原样套上，选择器链不断。
async function captureRows(root: HTMLElement, rows: ShotRow[], opts: ShotOptions, title: string): Promise<{ blob: Blob; external: string[] }> {
    const found = rows
        .map(row => ({ row, el: root.querySelector<HTMLElement>(`#message-${CSS.escape(row.renderId)}`) }))
        .filter((item): item is { row: ShotRow; el: HTMLElement } => !!item.el);
    if (!found.length) throw new Error("选中的消息不在页面上，先滑到它们那里再截");
    const unitOf = (el: HTMLElement) => {
        const parent = el.parentElement;
        return parent && parent !== root && parent.querySelectorAll('[id^="message-"]').length === 1 ? parent : el;
    };
    const units = found.map(item => ({ ...item, unit: unitOf(item.el) }));
    const container = units[0].unit.parentElement ?? root;
    const chain: HTMLElement[] = [];
    for (let el: HTMLElement | null = container; el && el !== root; el = el.parentElement) chain.unshift(el);

    const rootStyle = getComputedStyle(root);
    const width = Math.round(container.clientWidth || root.clientWidth);
    const stage = document.createElement("div");
    stage.className = "cx-shot-stage";
    stage.setAttribute("data-shot", "");
    if (!opts.avatar) stage.setAttribute("data-shot-noav", "");
    if (!opts.time) stage.setAttribute("data-shot-notime", "");
    stage.style.width = `${width}px`;
    const base = solid(rootStyle.backgroundColor) || solid(getComputedStyle(document.body).backgroundColor) || "#ffffff";
    stage.style.backgroundColor = base;
    if (opts.background && rootStyle.backgroundImage && rootStyle.backgroundImage !== "none") {
        stage.style.backgroundImage = rootStyle.backgroundImage;
        stage.style.backgroundSize = "cover";
        stage.style.backgroundPosition = "center top";
    }

    const head = document.createElement("div");
    head.className = "cx-shot-head";
    const name = document.createElement("b");
    name.textContent = opts.name ? title : MASK;
    const date = document.createElement("small");
    date.textContent = dayLabel(rows);
    head.append(name, date);
    stage.appendChild(head);

    let host: HTMLElement = stage;
    for (const ancestor of chain) {
        const shell = document.createElement("div");
        shell.className = ancestor.className;
        for (const attr of Array.from(ancestor.attributes)) if (attr.name.startsWith("data-")) shell.setAttribute(attr.name, attr.value);
        shell.classList.add("cx-shot-shell");
        host.appendChild(shell);
        host = shell;
    }

    const external: string[] = [];
    for (const { row, unit } of units) {
        const clone = unit.cloneNode(true) as HTMLElement;
        for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))]) {
            el.removeAttribute("id");
            el.removeAttribute("data-active");
            el.removeAttribute("data-highlight");
            el.removeAttribute("data-selected");
        }
        if (!opts.name) clone.querySelectorAll(".chat-group-sender-name").forEach(el => { el.textContent = MASK; });
        if (Array.from(clone.querySelectorAll("img")).some(img => isExternalImage(img.src))) external.push(row.storedId);
        host.appendChild(clone);
    }

    if (opts.watermark) {
        const mark = document.createElement("div");
        mark.className = "cx-shot-wm";
        const now = new Date();
        mark.textContent = `小手机 · ${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
        stage.appendChild(mark);
    }

    root.appendChild(stage);
    try {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const height = stage.scrollHeight;
        const scale = Math.min(window.devicePixelRatio || 2, 2, Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height)));
        const { domToBlob } = await import("modern-screenshot");
        const blob = await domToBlob(stage, { scale, type: "image/png", timeout: 15000, style: { left: "0px", top: "0px", position: "relative" } });
        return { blob, external };
    } finally {
        stage.remove();
    }
}

type Shot = { key: string; url?: string; blob?: Blob; external: string[]; error?: string };

export function ChatScreenshotSheet({ rootRef, rows, title, onDeselect, onSaved, onClose }: {
    rootRef: RefObject<HTMLElement | null>;
    rows: ShotRow[];
    title: string;
    onDeselect: (storedIds: string[]) => void;
    onSaved: () => void;
    onClose: () => void;
}) {
    const [opts, setOpts] = useState<ShotOptions>({ avatar: true, name: true, time: true, background: true, watermark: false });
    const [shot, setShot] = useState<Shot | null>(null);
    const [saving, setSaving] = useState(false);
    const tooMany = rows.length > SCREENSHOT_MAX;
    const key = useMemo(() => JSON.stringify([opts, rows.map(r => r.renderId)]), [opts, rows]);

    useEffect(() => {
        const root = rootRef.current;
        if (tooMany || !root || !rows.length) return;
        let live = true;
        const timer = setTimeout(() => {
            captureRows(root, rows, opts, title).then(
                ({ blob, external }) => { if (live) setShot({ key, blob, external, url: URL.createObjectURL(blob) }); },
                error => { if (live) setShot({ key, external: [], error: `截图失败：${error instanceof Error ? error.message : String(error)}` }); },
            );
        }, 150);
        return () => { live = false; clearTimeout(timer); };
    }, [key, opts, rootRef, rows, title, tooMany]);

    useEffect(() => {
        const url = shot?.url;
        return () => { if (url) URL.revokeObjectURL(url); };
    }, [shot?.url]);

    const current = shot?.key === key ? shot : null;
    const busy = !tooMany && rows.length > 0 && !current;

    const save = async () => {
        if (!current?.blob) return;
        setSaving(true);
        try {
            const now = new Date();
            const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
            const result = await shareOrDownloadFile(current.blob, `聊天截图-${title}-${stamp}.png`, "聊天截图");
            if (result !== "cancelled") onSaved();
        } finally {
            setSaving(false);
        }
    };

    return createPortal(
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet cx-vars cx-shot" role="dialog" aria-label="聊天截图" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="cx-sh-head">
                    <span className="cx-sh-title"><b>聊天截图</b><small>{rows.length} 条消息 · 一张长图</small></span>
                    <button type="button" className="cx-x" aria-label="关闭" onClick={onClose}><X size={13} /></button>
                </div>
                <div className="dg-sh-body">
                    {tooMany && (
                        <div className="cx-warn"><AlertCircle size={13} /><span>选了 {rows.length} 条，一张图最多 {SCREENSHOT_MAX} 条，再多 iPhone 会画成空白。少选一些再截。</span></div>
                    )}
                    {!!current?.external.length && (
                        <div className="cx-warn">
                            <AlertCircle size={13} />
                            <span>有 {current.external.length} 条消息带别的网站的图片，浏览器不让画进截图，会变成灰块。<button type="button" onClick={() => onDeselect(current.external)}>取消选中这 {current.external.length} 条</button></span>
                        </div>
                    )}
                    {current?.error && <div className="cx-error">{current.error}</div>}
                    {!tooMany && (
                        <div className="cx-shot-preview" {...(busy ? { "data-busy": "" } : {})}>
                            {shot?.url && <img src={shot.url} alt="截图预览" />}
                            {busy && <span className="cx-shot-wait"><Loader2 size={15} className="cx-spin" />正在画…</span>}
                        </div>
                    )}
                    <div className="cx-list">
                        {OPTION_ROWS.map(row => (
                            <div key={row.key} className="cx-opt">
                                <span>{row.label}</span>
                                <div className="cx-minis" role="radiogroup" aria-label={row.label}>
                                    <button type="button" role="radio" aria-checked={opts[row.key]} onClick={() => setOpts(prev => ({ ...prev, [row.key]: true }))}>{row.on}</button>
                                    <button type="button" role="radio" aria-checked={!opts[row.key]} onClick={() => setOpts(prev => ({ ...prev, [row.key]: false }))}>{row.off}</button>
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="cx-note">截的是屏幕上真实的气泡，自定义 CSS、双语翻译、折叠的状态栏都照原样。</p>
                </div>
                <div className="dg-sh-foot">
                    <button type="button" className="dg-pill is-ghost" onClick={onClose}>取消</button>
                    <button type="button" className="dg-pill" disabled={!current?.blob || saving} onClick={() => void save()}>{saving ? "正在打开…" : "存到相册"}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
