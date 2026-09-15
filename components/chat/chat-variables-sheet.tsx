"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, CornerDownRight, X } from "lucide-react";
import { CHAT_PLUGIN_VARS_CHANGED_EVENT, getChatPluginVar, setChatPluginVar, unsetChatPluginVar } from "@/lib/chat-plugin-storage";
import type { ChatPluginVarScope } from "@/lib/chat-plugin-types";
import { getStatusRegionConfig } from "@/lib/chat-status-region";
import {
    CHAT_MESSAGE_PUSHED_EVENT,
    getLatestCharacterStateMessage,
    loadChatMessages,
    updateChatMessage,
    type ChatSession,
} from "@/lib/chat-storage";
import {
    CHAT_VAR_DEFS_CHANGED_EVENT,
    chatVarDefsFor,
    chatVarNameProblem,
    coerceChatVar,
    deleteChatVarDef,
    listChatPluginVars,
    loadChatVarDefs,
    newChatVarDef,
    readChatVar,
    saveChatVarDef,
    varValueText,
    type ChatVarDef,
    type ChatVarKind,
} from "@/lib/chat-variables";

type Tab = "chat" | "char" | "global";
type View =
    | { kind: "list" }
    | { kind: "def"; def: ChatVarDef }
    | { kind: "raw"; scope: ChatPluginVarScope; targetId?: string; name: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function clock(value: unknown): string {
    const t = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(t)) return str(value);
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function when(at: number): string {
    const diff = Date.now() - at;
    if (diff < 60000) return "刚刚";
    const d = new Date(at);
    if (d.toDateString() === new Date().toDateString()) return clock(at);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const itemsCount = (v: unknown, unit: string) => {
    const items = obj(v).items;
    return Array.isArray(items) ? `${items.length} ${unit}` : "";
};

type CatalogEntry = { label: string; source: string; kind: "plugin" | "app"; users: string; summary: (value: unknown) => string };

// 官方插件和 APP 记在角色身上的变量：给个中文名和一句话摘要；认不出的一律显示原始数据
const CATALOG: Record<string, CatalogEntry> = {
    affection: {
        label: "好感", source: "好感账本", kind: "plugin", users: "朋友圈节奏、挂念",
        summary: v => {
            const o = obj(v);
            if (typeof o.score !== "number") return "";
            const delta = typeof o.todayDelta === "number" && o.todayDelta ? ` · 今天 ${o.todayDelta > 0 ? "+" : ""}${o.todayDelta}` : "";
            return `${Math.round(o.score)} 分${str(o.relation) ? ` · ${o.relation}` : ""}${delta}`;
        },
    },
    profile: {
        label: "个性签名", source: "个性签名", kind: "plugin", users: "朋友圈资料页",
        summary: v => { const o = obj(v); return str(o.signature) ? `「${o.signature}」${o.by === "self" ? " · TA 自己改的" : ""}` : ""; },
    },
    presence: {
        label: "在线状态", source: "挂念", kind: "app", users: "在线状态、好感账本、忙碌回复、约见面、朋友圈节奏、个性签名",
        summary: v => {
            const o = obj(v);
            const text = [o.label, o.text, o.activity, o.status, o.state].map(str).find(Boolean) ?? "";
            return text + (o.until ? ` · 到 ${clock(o.until)}` : "");
        },
    },
    presenceOverride: { label: "手动状态", source: "在线状态", kind: "plugin", users: "忙碌回复、好感账本", summary: v => str(obj(v).state) || "没有" },
    routine: { label: "作息", source: "在线状态", kind: "plugin", users: "在线状态", summary: v => itemsCount(v, "条") },
    routineExceptions: { label: "作息例外", source: "在线状态 · 忙碌回复", kind: "plugin", users: "在线状态", summary: v => itemsCount(v, "条例外") },
    wokenByCall: {
        label: "被电话吵醒", source: "忙碌回复", kind: "plugin", users: "忙碌回复",
        summary: v => { const o = obj(v); return o.at ? `${clock(o.at)} · ${o.kind === "video" ? "视频" : "语音"}` : ""; },
    },
    moments: { label: "朋友圈安排", source: "挂念", kind: "app", users: "朋友圈节奏", summary: v => (obj(v).at ? `更新于 ${clock(obj(v).at)}` : "") },
};

function compact(value: unknown): string {
    const text = varValueText(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const STATE_COLORS: Record<string, string> = {
    "好感度": "var(--c-icon-rose)", "占有欲": "var(--c-icon-violet)", "焦虑值": "var(--c-icon-amber)",
    "信任": "var(--c-icon-blue)", "安全感": "var(--c-icon-teal)",
};

function StatusBlock({ session, onChanged }: { session: ChatSession; onChanged: () => void }) {
    const mode = getStatusRegionConfig(session.id).mode;
    if (session.isGroup || mode === "off") return null;
    if (mode === "custom") {
        const latest = [...loadChatMessages(session.id)].reverse().find(m => m.statusPanel);
        return (
            <section className="cx-sec">
                <div className="cx-sec-h"><span>自定义状态栏</span><span>最新一条 · 只看</span></div>
                {latest?.statusPanel ? <pre className="cx-json">{latest.statusPanel}</pre> : <div className="cx-note">还没有状态栏，AI 回一轮就有了。</div>}
                <div className="cx-note">格式由你的状态栏契约决定，这里不拆字段、也不改。</div>
            </section>
        );
    }
    const holder = getLatestCharacterStateMessage(session.contactId);
    const values = holder?.stateValues ?? [];
    const commit = (index: number, next: number) => {
        if (!holder || !Number.isFinite(next)) return;
        const value = Math.max(0, Math.min(100, Math.round(next)));
        const name = values[index].name;
        const patchValues = (list?: typeof values) => list?.map(sv => (sv.name === name ? { ...sv, value } : sv));
        updateChatMessage(holder.id, { stateValues: patchValues(values), ...(holder.freshStateValues ? { freshStateValues: patchValues(holder.freshStateValues) } : {}) });
        onChanged();
    };
    return (
        <section className="cx-sec">
            <div className="cx-sec-h"><span>状态栏数值</span><span>AI 每轮回复自己带</span></div>
            {values.length ? (
                <div className="cx-list">
                    {values.map((sv, i) => (
                        <div key={sv.name} className="cx-sv">
                            <span className="cx-sv-nm">{sv.name}</span>
                            <span className="cx-meter"><i style={{ width: `${Math.max(0, Math.min(100, sv.value))}%`, background: STATE_COLORS[sv.name] ?? "var(--c-icon-active)" }} /></span>
                            <span className="cx-step">
                                <button type="button" aria-label={`${sv.name}减 1`} onClick={() => commit(i, sv.value - 1)}>−</button>
                                <input aria-label={sv.name} inputMode="numeric" value={sv.value} onChange={e => commit(i, Number(e.target.value))} />
                                <button type="button" aria-label={`${sv.name}加 1`} onClick={() => commit(i, sv.value + 1)}>+</button>
                            </span>
                        </div>
                    ))}
                </div>
            ) : <div className="cx-note">还没有数值，AI 回一轮就有了。</div>}
            {values.length > 0 && <div className="cx-note">改了之后，下一轮 AI 从你改的数接着算。</div>}
        </section>
    );
}

function VarCard({ def, onOpen }: { def: ChatVarDef; onOpen: () => void }) {
    const value = readChatVar(def);
    const last = def.history?.[0];
    const range = def.kind === "number"
        ? (typeof def.min === "number" || typeof def.max === "number" ? `${def.min ?? ""}–${def.max ?? ""}` : "数字")
        : def.kind === "choice" ? (def.options ?? []).join(" / ") : "文字";
    const pct = def.kind === "number" && typeof def.min === "number" && typeof def.max === "number" && def.max > def.min && value !== ""
        ? ((Number(value) - def.min) / (def.max - def.min)) * 100 : null;
    const fromN = Number(last?.from), toN = Number(last?.to);
    const numeric = !!last && last.from !== "" && Number.isFinite(fromN) && Number.isFinite(toN);
    return (
        <button type="button" className="cx-vc" onClick={onOpen}>
            <span className="cx-vc-top">
                <b>{def.name}</b>
                <span className={`cx-tag${def.ai ? " is-ai" : ""}`}>{def.ai ? "AI 按规则改" : "只你改"}</span>
                <span className={`cx-vc-val${def.kind === "number" ? " is-num" : ""}`}>{value || "（空）"}</span>
            </span>
            {pct !== null && Number.isFinite(pct) && <span className="cx-meter"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>}
            <span className="cx-vc-desc">{def.desc}{def.desc ? " · " : ""}<span>{range}</span></span>
            {def.rule && <span className="cx-rule"><CornerDownRight size={12} /><span>{def.rule}</span></span>}
            {last && (
                <span className="cx-last">
                    {numeric
                        ? <span className={`cx-d ${toN >= fromN ? "is-up" : "is-down"}`}>{toN >= fromN ? "↑" : "↓"}{Math.round(Math.abs(toN - fromN) * 100) / 100}</span>
                        : <span className="cx-d">改</span>}
                    <span>{last.why || (last.by === "ai" ? "AI 改的" : "你改的")}</span>
                    <span>· {when(last.at)}</span>
                </span>
            )}
        </button>
    );
}

function DefEditor({ def, onDone }: { def: ChatVarDef; onDone: () => void }) {
    const isNew = !loadChatVarDefs().some(d => d.id === def.id);
    const [name, setName] = useState(def.name);
    const [kind, setKind] = useState<ChatVarKind>(def.kind);
    const [min, setMin] = useState(def.min === undefined ? "" : String(def.min));
    const [max, setMax] = useState(def.max === undefined ? "" : String(def.max));
    const [options, setOptions] = useState<string[]>(def.options ?? []);
    const [optDraft, setOptDraft] = useState("");
    const [value, setValue] = useState(() => (isNew ? "50" : readChatVar(def)));
    const [desc, setDesc] = useState(def.desc);
    const [rule, setRule] = useState(def.rule);
    const [ai, setAi] = useState(def.ai);
    const [error, setError] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);

    const addOption = () => {
        const text = optDraft.trim();
        if (!text || options.includes(text)) return;
        setOptions([...options, text]);
        if (!value || !options.includes(value)) setValue(text);
        setOptDraft("");
    };

    const save = () => {
        const problem = chatVarNameProblem(name, def.scope, def.targetId, def.id);
        if (problem) { setError(problem); return; }
        if (kind === "choice" && !options.length) { setError("选项类型至少加一个选项"); return; }
        const num = (text: string) => (text.trim() === "" || !Number.isFinite(Number(text)) ? undefined : Number(text));
        const next: ChatVarDef = {
            ...def, name: name.trim(), kind, desc, rule, ai,
            min: kind === "number" ? num(min) : undefined,
            max: kind === "number" ? num(max) : undefined,
            options: kind === "choice" ? options : [],
        };
        const current = kind === "choice" && !options.includes(value) ? options[0] : value;
        if (!coerceChatVar(next, current).ok) { setError(kind === "number" ? "当前值要填数字" : "当前值不在选项里"); return; }
        saveChatVarDef(next, current);
        onDone();
    };

    return (
        <>
            <div className="dg-sh-body">
                <div className="cx-list">
                    <label className="cx-fld"><span>名称</span><input value={name} maxLength={20} placeholder="比如：信任度" onChange={e => { setName(e.target.value); setError(""); }} /></label>
                    <div className="cx-fld">
                        <span>类型</span>
                        <div className="cx-minis" role="radiogroup" aria-label="类型">
                            {([["number", "数字"], ["choice", "选项"], ["text", "文字"]] as const).map(([k, label]) => (
                                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setError(""); }}>{label}</button>
                            ))}
                        </div>
                    </div>
                    {kind === "number" && (
                        <div className="cx-fld">
                            <span>当前值 · 范围</span>
                            <div className="cx-range">
                                <input aria-label="当前值" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} />
                                <em>范围</em>
                                <input aria-label="最小" inputMode="decimal" value={min} placeholder="不限" onChange={e => setMin(e.target.value)} />
                                <em>–</em>
                                <input aria-label="最大" inputMode="decimal" value={max} placeholder="不限" onChange={e => setMax(e.target.value)} />
                            </div>
                        </div>
                    )}
                    {kind === "choice" && (
                        <div className="cx-fld">
                            <span>当前值 · 点一下选中，× 删掉</span>
                            <div className="cx-chips">
                                {options.map(option => (
                                    <span key={option} className={`cx-chip${option === value ? " is-on" : ""}`}>
                                        <button type="button" onClick={() => setValue(option)}>{option}</button>
                                        <button type="button" aria-label={`删掉${option}`} onClick={() => setOptions(options.filter(o => o !== option))}>×</button>
                                    </span>
                                ))}
                                <input className="cx-chip-add" value={optDraft} placeholder="加一个" aria-label="加一个选项"
                                    onChange={e => setOptDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
                                    onBlur={addOption} />
                            </div>
                        </div>
                    )}
                    {kind === "text" && (
                        <label className="cx-fld"><span>当前值</span><textarea rows={2} value={value} onChange={e => setValue(e.target.value)} /></label>
                    )}
                    <label className="cx-fld"><span>说明 · 告诉 AI 这是什么</span><textarea rows={2} value={desc} placeholder="比如：林屿有多相信你说到做到" onChange={e => setDesc(e.target.value)} /></label>
                </div>
                <div className="cx-list">
                    <label className="cx-swrow">
                        <span className="cx-swrow-tx"><b>让 AI 按规则改</b><span>关掉就只有你能改</span></span>
                        <span className="cx-sw"><input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} /><i /></span>
                    </label>
                    <label className="cx-fld"><span>更新规则</span><textarea rows={3} value={rule} placeholder="比如：你守约 +3；放鸽子 −8；一轮最多改 10" onChange={e => setRule(e.target.value)} /></label>
                </div>
                {def.history?.length > 0 && (
                    <section className="cx-sec">
                        <div className="cx-sec-h"><span>最近变化</span></div>
                        <div className="cx-list cx-hist">
                            {def.history.slice(0, 8).map(h => (
                                <div key={h.at}>
                                    <time>{when(h.at)}</time>
                                    <b>{h.from || "（空）"}→{h.to || "（空）"}</b>
                                    <span>{h.why || "—"} · {h.by === "ai" ? "AI" : "你"}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
                {error && <div className="cx-error" role="alert">{error}</div>}
            </div>
            <div className="dg-sh-foot">
                {isNew ? <span /> : (
                    <button type="button" className="dg-pill is-danger" onClick={() => { if (confirmDelete) { deleteChatVarDef(def.id); onDone(); } else setConfirmDelete(true); }}>
                        {confirmDelete ? "再点一次删除" : "删除"}
                    </button>
                )}
                <button type="button" className="dg-pill" onClick={save}>保存</button>
            </div>
        </>
    );
}

function RawVarView({ scope, targetId, name, onDone }: { scope: ChatPluginVarScope; targetId?: string; name: string; onDone: () => void }) {
    const value = getChatPluginVar(name, scope, targetId);
    const entry = scope === "character" ? CATALOG[name] : undefined;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2) ?? "");
    const save = () => {
        let parsed: unknown = draft;
        try { parsed = JSON.parse(draft); } catch { /* 不是 JSON 就按文字存 */ }
        setChatPluginVar(name, parsed, scope, targetId);
        setEditing(false);
    };
    return (
        <>
            <div className="dg-sh-body">
                <div className="cx-list">
                    {entry && <div className="cx-kv"><span>现在</span><b>{entry.summary(value) || "（空）"}</b></div>}
                    <div className="cx-kv"><span>谁在写</span><b>{entry ? `${entry.source}（${entry.kind === "app" ? "APP" : "插件"}）` : scope === "character" ? "第三方插件或 APP，宿主不认识它的格式" : "世界书 / 角色卡的 {{setvar}}，或插件"}</b></div>
                    {entry && <div className="cx-kv"><span>谁在用</span><b>{entry.users}</b></div>}
                </div>
                <section className="cx-sec">
                    <div className="cx-sec-h"><span>原始数据</span><span>{name}</span></div>
                    {editing
                        ? <textarea className="cx-json" rows={8} value={draft} onChange={e => setDraft(e.target.value)} aria-label="原始数据" />
                        : <pre className="cx-json">{JSON.stringify(value, null, 2)}</pre>}
                    <div className="cx-note">{entry ? "这项照插件自己的规则变。改坏了插件可能读不懂，一般去聊天信息里对应插件那一栏改。" : "填 JSON；不是 JSON 就按文字存。"}</div>
                </section>
            </div>
            <div className="dg-sh-foot">
                {scope !== "character"
                    ? <button type="button" className="dg-pill is-danger" onClick={() => { unsetChatPluginVar(name, scope, targetId); onDone(); }}>删除</button>
                    : <span />}
                {editing
                    ? <button type="button" className="dg-pill" onClick={save}>保存</button>
                    : <button type="button" className="dg-pill is-ghost" onClick={() => setEditing(true)}>改原始数据</button>}
            </div>
        </>
    );
}

export function ChatVariablesSheet({ session, characterName, onClose }: { session: ChatSession; characterName: string; onClose: () => void }) {
    const isGroup = !!session.isGroup;
    const characterId = isGroup ? undefined : session.contactId;
    const [tab, setTab] = useState<Tab>("chat");
    const [view, setView] = useState<View>({ kind: "list" });
    const [, setTick] = useState(0);
    const refresh = () => setTick(t => t + 1);

    useEffect(() => {
        const events = [CHAT_PLUGIN_VARS_CHANGED_EVENT, CHAT_VAR_DEFS_CHANGED_EVENT, CHAT_MESSAGE_PUSHED_EVENT];
        const bump = () => setTick(t => t + 1);
        events.forEach(name => window.addEventListener(name, bump));
        return () => events.forEach(name => window.removeEventListener(name, bump));
    }, []);

    const defs = chatVarDefsFor(session.id, characterId);
    const sessionDefs = defs.filter(d => d.scope === "session");
    const charDefs = defs.filter(d => d.scope === "character");
    const globalDefs = defs.filter(d => d.scope === "global");
    const others = (scope: ChatPluginVarScope, targetId: string | undefined, taken: ChatVarDef[]) =>
        Object.entries(listChatPluginVars(scope, targetId)).filter(([name]) => !taken.some(d => d.name === name));
    const sessionOthers = others("session", session.id, sessionDefs);
    const charOthers = characterId ? others("character", characterId, charDefs) : [];
    const globalOthers = others("global", undefined, globalDefs);
    const statusMode = isGroup ? "off" : getStatusRegionConfig(session.id).mode;
    const counts: Record<Tab, number> = {
        chat: sessionDefs.length + sessionOthers.length + (statusMode === "off" ? 0 : 1),
        char: charDefs.length + charOthers.length,
        global: globalDefs.length + globalOthers.length,
    };
    const tabs: [Tab, string][] = isGroup ? [["chat", "这段聊天"], ["global", "全局"]] : [["chat", "这段聊天"], ["char", characterName], ["global", "全局"]];

    const back = () => { setView({ kind: "list" }); refresh(); };
    const cards = (list: ChatVarDef[]) => list.length > 0 && (
        <div className="cx-list">{list.map(def => <VarCard key={def.id} def={def} onOpen={() => setView({ kind: "def", def })} />)}</div>
    );
    const rawRows = (list: [string, unknown][], scope: ChatPluginVarScope, targetId?: string) => list.length > 0 && (
        <div className="cx-list">
            {list.map(([name, value]) => {
                const entry = scope === "character" ? CATALOG[name] : undefined;
                return (
                    <button key={name} type="button" className="cx-plugrow" onClick={() => setView({ kind: "raw", scope, targetId, name })}>
                        <span className="cx-plugrow-tx">
                            <b>{entry?.label ?? name}{entry ? <span className={`cx-tag ${entry.kind === "app" ? "is-app" : "is-plug"}`}>{entry.kind === "app" ? "APP" : "插件"}</span> : scope === "character" ? <span className="cx-tag">第三方</span> : null}</b>
                            <span>{(entry?.summary(value) || "") || compact(value) || "（空）"}</span>
                            <code>{name}{entry ? ` · 来自「${entry.source}」` : ""}</code>
                        </span>
                        <ChevronRight size={15} className="cx-chev" />
                    </button>
                );
            })}
        </div>
    );
    const addButton = (label: string, scope: ChatPluginVarScope, targetId?: string) => (
        <button type="button" className="cx-addv" onClick={() => setView({ kind: "def", def: newChatVarDef(scope, targetId) })}>＋ {label}</button>
    );

    let title = "聊天变量";
    let body: React.ReactNode;
    if (view.kind === "def") {
        title = view.def.name || "新建变量";
        body = <DefEditor def={view.def} onDone={back} />;
    } else if (view.kind === "raw") {
        title = (view.scope === "character" ? CATALOG[view.name]?.label : undefined) ?? view.name;
        body = <RawVarView scope={view.scope} targetId={view.targetId} name={view.name} onDone={back} />;
    } else {
        body = (
            <div className="dg-sh-body">
                {tab === "chat" && (
                    <>
                        <StatusBlock session={session} onChanged={refresh} />
                        <section className="cx-sec">
                            <div className="cx-sec-h"><span>你建的变量</span>{sessionDefs.length > 0 && <span>点开改</span>}</div>
                            {cards(sessionDefs) || <div className="cx-note">给这段聊天记点东西：信任度、约定、天气……写好规则，AI 每轮照着改。</div>}
                        </section>
                        {sessionOthers.length > 0 && (
                            <section className="cx-sec">
                                <div className="cx-sec-h"><span>世界书和插件写进来的</span></div>
                                {rawRows(sessionOthers, "session", session.id)}
                            </section>
                        )}
                        {addButton("新建变量", "session", session.id)}
                    </>
                )}
                {tab === "char" && characterId && (
                    <>
                        {charDefs.length > 0 && <section className="cx-sec"><div className="cx-sec-h"><span>你给 {characterName} 建的</span></div>{cards(charDefs)}</section>}
                        <section className="cx-sec">
                            <div className="cx-sec-h"><span>插件和 APP 记在 {characterName} 身上的</span><span>所有聊天通用</span></div>
                            {rawRows(charOthers, "character", characterId) || <div className="cx-note">还没有插件或 APP 记过东西。</div>}
                            {charOthers.length > 0 && <div className="cx-note">这些照各自插件的规则变，AI 的「[变量]」行不会改它们。</div>}
                        </section>
                        {addButton(`给 ${characterName} 建一个变量`, "character", characterId)}
                    </>
                )}
                {tab === "global" && (
                    <>
                        <section className="cx-sec">
                            <div className="cx-sec-h"><span>所有聊天共用</span></div>
                            {cards(globalDefs) || <div className="cx-note">全局变量在每段聊天里都看得到，比如季节、世界线。</div>}
                        </section>
                        {globalOthers.length > 0 && <section className="cx-sec"><div className="cx-sec-h"><span>世界书和插件写进来的</span></div>{rawRows(globalOthers, "global")}</section>}
                        {addButton("新建全局变量", "global")}
                    </>
                )}
            </div>
        );
    }

    if (typeof document === "undefined") return null;
    return createPortal(
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet cx-vars" role="dialog" aria-label="聊天变量" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="cx-sh-head">
                    {view.kind !== "list" && <button type="button" className="cx-x" aria-label="返回" onClick={back}><ChevronLeft size={15} /></button>}
                    <span className="cx-sh-title"><b>{title}</b>{view.kind === "list" && <small>{characterName} · {isGroup ? "群聊" : "单聊"}</small>}</span>
                    <button type="button" className="cx-x" aria-label="关闭" onClick={onClose}><X size={13} /></button>
                </div>
                {view.kind === "list" && (
                    <div className="cx-seg" role="tablist">
                        {tabs.map(([key, label]) => (
                            <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
                                <span>{label}</span><i>{counts[key]}</i>
                            </button>
                        ))}
                    </div>
                )}
                {body}
            </div>
        </div>,
        document.body,
    );
}
