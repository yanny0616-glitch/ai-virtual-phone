"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Search, SlidersHorizontal, MessagesSquare, PencilLine, Trash2, Sparkles, AlertCircle } from "lucide-react";
import type { MemoryEntry } from "@/lib/memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType, saveMemoryEntry } from "@/lib/memory-storage";
import { isShiguang } from "@/lib/shiguang-domain";
import { SHIGUANG_CATEGORIES, type ShiguangCategory, type ShiguangData } from "@/lib/shiguang-types";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runShiguangPipeline } from "@/lib/shiguang-summarizer";
import { ConfirmDialog } from "@/components/ui/modal";
import "./shiguang.css";

const PAGE_SIZE = 20;
const STATUS_LABELS = { remembered: "记在心里", pending: "等待兑现", completed: "已经完成", changed: "计划有变" };
function localDate(iso: string): string {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
}
function displayTime(iso: string): string {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function ShiguangPanel({ characterId, characterName, userName }: { characterId: string; characterName: string; userName: string }) {
    const [entries, setEntries] = useState<MemoryEntry[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [query, setQuery] = useState("");
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [categories, setCategories] = useState<ShiguangCategory[]>([]);
    const [time, setTime] = useState("all");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [page, setPage] = useState(0);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [enabled, setEnabled] = useState(() => loadMemoryConfig().shiguangEnabled);
    const reload = useCallback(async () => {
        const stored = await loadMemoryEntriesByType(characterId, "shiguang");
        setEntries(stored.filter(isShiguang).sort((a,b) => b.shiguang!.lastEventAt.localeCompare(a.shiguang!.lastEventAt)));
        setLoaded(true);
    }, [characterId]);
    useEffect(() => {
        let active = true;
        const refresh = () => {
            void loadMemoryEntriesByType(characterId, "shiguang").then(stored => {
                if (!active) return;
                setEntries(stored.filter(isShiguang).sort((a,b) => b.shiguang!.lastEventAt.localeCompare(a.shiguang!.lastEventAt)));
                setLoaded(true);
            }).catch(() => { if (active) { setNotice("记忆加载失败，请重新打开页面。"); setLoaded(true); } });
        };
        refresh();
        window.addEventListener("shiguang-updated", refresh);
        return () => { active = false; window.removeEventListener("shiguang-updated", refresh); };
    }, [characterId]);
    const filtered = useMemo(() => {
        const keyword = query.trim().toLocaleLowerCase();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const since = new Date(today);
        if (time === "7" || time === "30") since.setDate(since.getDate() - Number(time) + 1);
        return entries.filter(entry => {
            const d = entry.shiguang!;
            const date = localDate(d.firstEventAt);
            if (categories.length && !categories.some(c => d.categories.includes(c))) return false;
            if (time === "custom" && ((start && date < start) || (end && date > end))) return false;
            if ((time === "7" || time === "30") && (date < localDate(since.toISOString()) || date > localDate(today.toISOString()))) return false;
            return !keyword || [d.title, entry.content, d.reason, d.story, d.significance, d.followup, ...d.details.map(f => `${f.label} ${f.value}`)].join(" ").toLocaleLowerCase().includes(keyword);
        });
    }, [entries, categories, time, start, end, query]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount - 1);
    const activeFilter = categories.length > 0 || time !== "all";
    const changeFilter = (action: () => void) => { action(); setPage(0); };
    const summarize = async () => {
        if (busy) return;
        setBusy(true); setNotice("");
        try {
            await hydrateChatStorage();
            const result = await runShiguangPipeline(characterId, characterName);
            setNotice(result.success ? `已整理，记下 ${result.saved || 0} 条拾光。${result.hasMore ? "还有未整理消息，可继续整理。" : ""}` : result.error || "整理失败，请重试。");
            await reload();
        } catch { setNotice("整理失败，请稍后重试。"); }
        finally { setBusy(false); }
    };
    return <div className="sg-memory">
        <div className="sg-screen">
            <header className="sg-top"><div className="sg-brand">拾光</div><div className="sg-person">和{characterName}的记忆</div></header>
            <div className="sg-main">
                <div className="sg-tools">
                    <label className="sg-search"><Search aria-hidden="true"/><input type="search" value={query} onChange={e => changeFilter(() => setQuery(e.target.value))} placeholder="找一段记忆…" aria-label="搜索记忆"/></label>
                    <button className="sg-filter-btn" type="button" aria-label={activeFilter ? "筛选，已应用条件" : "筛选"} aria-expanded={filtersOpen} aria-controls="sg-filters" onClick={() => setFiltersOpen(v => !v)}><SlidersHorizontal aria-hidden="true"/>{activeFilter && <span className="sg-dot"/>}</button>
                </div>
                {filtersOpen && <section className="sg-filters" id="sg-filters" aria-label="记忆筛选">
                    <div className="sg-fgroup"><span className="sg-flabel">类型</span><div className="sg-chips" role="group" aria-label="记忆类型，可多选">{SHIGUANG_CATEGORIES.map(category => <label className="sg-chip" key={category}><input type="checkbox" checked={categories.includes(category)} onChange={e => changeFilter(() => setCategories(old => e.target.checked ? [...old, category] : old.filter(c => c !== category)))}/><span>{category}</span></label>)}</div></div>
                    <div className="sg-fgroup"><span className="sg-flabel">时间</span><div className="sg-chips" role="radiogroup" aria-label="记录时间">{[["all", "全部"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["custom", "自选"]].map(([value,label]) => <label className="sg-chip" key={value}><input type="radio" name="sg-time" value={value} checked={time === value} onChange={() => changeFilter(() => setTime(value))}/><span>{label}</span></label>)}</div></div>
                    {time === "custom" && <div className="sg-dates"><label>开始日期<input type="date" value={start} max={end || undefined} onChange={e => changeFilter(() => setStart(e.target.value))}/></label><label>结束日期<input type="date" value={end} min={start || undefined} onChange={e => changeFilter(() => setEnd(e.target.value))}/></label></div>}
                    <button type="button" className="sg-clear" onClick={() => changeFilter(() => { setCategories([]); setTime("all"); setStart(""); setEnd(""); setQuery(""); })}>清除筛选</button>
                </section>}
                <div className="sg-list-head"><p className="sg-count" aria-live="polite">{filtered.length} 条记忆{activeFilter ? " · 已筛选" : ""}</p><button className="sg-clear" disabled={busy || !enabled} onClick={summarize}><Sparkles size={12}/>{busy ? "整理中…" : "整理新消息"}</button></div>
                {!enabled && <p className="sg-empty">拾光记录与回忆已关闭。<button className="sg-clear" onClick={async () => {
                    const { saveMemoryConfig } = await import("@/lib/memory-storage");
                    saveMemoryConfig({ ...loadMemoryConfig(), shiguangEnabled: true }); setEnabled(true);
                }}>开启拾光</button></p>}
                {notice && <p className="sg-save-hint" role="status">{notice}</p>}
                {!loaded ? <p className="sg-empty">正在翻找记忆…</p> : !filtered.length ? <p className="sg-empty">{entries.length ? "没有找到这段记忆，试试其他筛选。" : "还没有拾光。聊天积累到拾光设定的轮次后会独立整理，也可以点「整理新消息」。"}</p> : filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(entry => <ShiguangCard key={entry.id} entry={entry} characterName={characterName} userName={userName} onChanged={reload}/>)}
                {pageCount > 1 && <nav className="sg-pagination" aria-label="记忆分页"><button className="sg-action" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pageCount}</span><button className="sg-action" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
                <p className="sg-foot">有些小事，后来成了很重要的事。</p>
            </div>
        </div>
    </div>;
}

function ShiguangCard({ entry, characterName, userName, onChanged }: { entry: MemoryEntry; characterName: string; userName: string; onChanged: () => Promise<void> }) {
    const d = entry.shiguang!;
    const [sourceOpen, setSourceOpen] = useState(false);
    const [sources, setSources] = useState<NativeTimelineEntry[] | null>(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState({ title: d.title, categories: d.categories, content: entry.content, reason: d.reason, story: d.story || "", significance: d.significance, facts: d.details.map(f => `${f.label}：${f.value}`).join("\n"), followup: d.followup, status: d.status, dueAt: d.dueAt || "" });
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [deleting, setDeleting] = useState(false);
    const sourceId = `sg-source-${entry.id}`;
    const editorId = `sg-editor-${entry.id}`;
    const showSource = async () => {
        setSourceOpen(!sourceOpen);
        if (sourceOpen) return;
        try {
            await hydrateChatStorage();
            const ids = new Set(entry.sourceMessageIds || []);
            setSources(loadNativeTimeline(entry.characterId).filter(e => ids.has(e.id)));
        } catch { setNotice("原消息加载失败，请重试。"); }
    };
    const persist = async (updated: MemoryEntry) => {
        await saveMemoryEntry(updated);
        window.dispatchEvent(new CustomEvent("shiguang-updated"));
        await onChanged();
    };
    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        if (busy || !draft.title.trim() || !draft.content.trim()) return;
        if (!draft.categories.length) { setNotice("至少选择一种记忆类型。"); return; }
        setBusy(true); setNotice("");
        try {
            const details = draft.facts.split("\n").filter(v => v.trim()).map(line => {
                const split = line.search(/[：:]/);
                return split > 0 ? { label: line.slice(0, split).trim(), value: line.slice(split + 1).trim() } : { label: "补充", value: line.trim() };
            });
            const recallSummary = [draft.content.trim(), draft.reason.trim(), draft.story.trim(), ...details.map(f => `${f.label}：${f.value}`), draft.significance.trim()].filter(Boolean).join("；");
            await persist({ ...entry, content: draft.content.trim(), updatedAt: new Date().toISOString(), shiguang: { ...d,
                title: draft.title.trim(), categories: draft.categories, reason: draft.reason.trim(), story: draft.story.trim(), significance: draft.significance.trim(), details,
                followup: draft.followup.trim(), status: draft.status, dueAt: draft.status === "pending" ? draft.dueAt || undefined : undefined,
                // Regenerate compact text locally so the next response sees user edits without an API call.
                stableSummary: d.stableSummary ? draft.significance.trim() || draft.content.trim() : "",
                recallSummary, userEdited: true,
            } });
            setEditing(false); setNotice("记忆已更新，手动修改的内容会优先保留。");
        } catch { setNotice("保存失败，请重试。"); }
        finally { setBusy(false); }
    };
    return <article className="sg-record"><details className="sg-note">
        <summary className="sg-summary"><div className="sg-meta"><span>{displayTime(d.firstEventAt)}</span>{d.userEdited && <span>已补充</span>}</div><h2><span>{d.title}</span><ChevronDown className="sg-chev" aria-hidden="true"/></h2><p className="sg-lead">{entry.content}</p><div className="sg-foot-row"><div className="sg-labels">{d.categories.map(c => <span className="sg-tag" key={c}>{c}</span>)}</div><span className="sg-fold"><span className="sg-open-label">展开详情</span><span className="sg-close-label">收起详情</span></span></div></summary>
        <div className="sg-detail">
            {d.reason && <section className="sg-block"><h3>事情的缘由</h3><p>{d.reason}</p></section>}
            {d.story && <section className="sg-block"><h3>那天发生了什么</h3><p>{d.story}</p></section>}
            {!!d.details.length && <section className="sg-block"><h3>记下的细节</h3><dl className="sg-facts">{d.details.map((f,i) => <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl></section>}
            {d.significance && <section className="sg-block"><h3>这件事里，值得记住的</h3><p>{d.significance}</p></section>}
            {(d.status !== "remembered" || d.followup) && <section className="sg-next"><div className="sg-status"><span aria-hidden="true"/><span>{STATUS_LABELS[d.status]}</span></div>{d.followup && <p>{d.followup}</p>}{d.dueAt && <p>约定日期：{d.dueAt}</p>}</section>}
            <div className="sg-actions"><button type="button" className="sg-action" aria-expanded={sourceOpen} aria-controls={sourceId} onClick={showSource}><MessagesSquare aria-hidden="true"/>回看原消息</button><button type="button" className="sg-action" aria-expanded={editing} aria-controls={editorId} onClick={() => {
                if (!editing) setDraft({ title: d.title, categories: d.categories, content: entry.content, reason: d.reason, story: d.story || "", significance: d.significance, facts: d.details.map(f => `${f.label}：${f.value}`).join("\n"), followup: d.followup, status: d.status, dueAt: d.dueAt || "" });
                setEditing(!editing);
            }}><PencilLine aria-hidden="true"/>编辑与后续</button></div>
            {sourceOpen && <section className="sg-source" id={sourceId}><h3>聊天原消息{sources ? ` · ${sources.length} 条` : ""}</h3>{sources === null ? <p>正在加载…</p> : <>{sources.length < (entry.sourceMessageIds?.length || 0) && <p className="sg-save-hint">部分原消息已删除或不可用，记忆仍保留。</p>}{sources.map(source => <div className={`sg-msg${source.authorType === "user" ? " sg-user" : ""}`} key={source.id}><label>{source.authorType === "user" ? userName : source.sourceDetail === "group" ? source.groupName || "群聊" : characterName} · {displayTime(source.timestamp)}</label><p>{source.sourceDetail === "direct" ? source.content.replace(/^\[[^\]]*\]\s*[^:：]+[:：]\s*/, "") : source.content}</p></div>)}</>}</section>}
            {editing && <form className="sg-update" id={editorId} onSubmit={save}>
                <div className="sg-chips" role="group" aria-label="修改记忆类型">{SHIGUANG_CATEGORIES.map(category => <label className="sg-chip" key={category}><input type="checkbox" checked={draft.categories.includes(category)} onChange={e => setDraft({ ...draft, categories: e.target.checked ? [...draft.categories, category] : draft.categories.filter(c => c !== category) })}/><span>{category}</span></label>)}</div>
                {([['title','标题',60],['content','记忆简述',200],['reason','事情的缘由',600],['story','那天发生了什么',600],['facts','具体信息（每行一项：名称：内容）',1200],['significance','值得记住的',400],['followup','后来发生了什么',600]] as const).map(([key,label,maxLength]) => <label key={key}>{label}<textarea required={key === 'title' || key === 'content'} rows={key === 'title' ? 1 : 2} maxLength={maxLength} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/></label>)}
                <label>现在的进展<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as ShiguangData["status"] })}>{Object.entries(STATUS_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                {draft.status === "pending" && <label>约定日期<input type="date" value={draft.dueAt} onChange={e => setDraft({ ...draft, dueAt: e.target.value })}/></label>}
                <button className="sg-submit" disabled={busy}>{busy ? "保存中…" : "保存记忆"}</button>
                <button className="sg-clear" type="button" disabled={busy} onClick={() => setDeleting(true)}><Trash2 size={12}/>删除这条记忆</button>
            </form>}
            {notice && <p className="sg-save-hint" role="status">{notice}</p>}
        </div>
    </details>{deleting && <ConfirmDialog title="删除这条拾光？" message="删除后不再展示或用于回忆，原聊天消息保留。" icon={AlertCircle} variant="danger" confirmLabel="删除记忆" onCancel={() => setDeleting(false)} onConfirm={async () => {
        setDeleting(false); setBusy(true);
        try { await persist({ ...entry, updatedAt: new Date().toISOString(), shiguang: { ...d, deletedAt: new Date().toISOString() } }); }
        catch { setNotice("删除失败，请重试。"); }
        finally { setBusy(false); }
    }}/>}</article>;
}
