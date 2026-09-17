"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, Pencil, Phone, PhoneMissed, Play, Share2, Square, Trash2, Video } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { CHAT_MESSAGE_PUSHED_EVENT, deleteChatMessagesByIds, editChatMessage, loadChatMessages, updateChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { callKindLabel, listCallRecords, repairBrokenCall, summarizeCall, type CallRecord } from "@/lib/call-records";
import { splitNarration, stripNarration } from "@/lib/call-directives";
import { stripVoiceExpression } from "@/lib/voice-expression";
import { playAudioBlob, resolveVoiceConfig, synthesizeChatSpeech } from "@/lib/tts-service";
import { buildCallAudio } from "@/lib/call-audio";
import { shareOrDownloadFile } from "@/lib/share-file";

const pad = (n: number) => String(n).padStart(2, "0");

function callWhen(iso: string, now: number): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dayOf = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    const today = new Date(now);
    const diff = Math.round((dayOf(today) - dayOf(d)) / 86_400_000);
    if (diff === 0) return `今天 ${hm}`;
    if (diff === 1) return `昨天 ${hm}`;
    return `${d.getFullYear() === today.getFullYear() ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const fileStamp = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

const lineShown = (m: ChatMessage) => (m.mediaType === "audio" ? m.mediaData?.label || m.content || "" : m.mediaType ? "" : m.content || "");
const lineSpeech = (m: ChatMessage) => stripNarration(m.mediaType === "audio" ? m.mediaData?.ttsText || lineShown(m) : m.content || "");
const visibleLines = (r: CallRecord) => r.lines.filter(m => !m.isRetracted && m.role !== "system" && lineShown(m).trim());
const openable = (r: CallRecord) => r.outcome === "answered" || r.outcome === "broken";

function recordTitle(r: CallRecord, charName: string): string {
    switch (r.outcome) {
        case "answered": return callKindLabel(r.kind);
        case "broken": return `${callKindLabel(r.kind)} · 中断`;
        case "missed": return `${charName}没接${(r.missedCount ?? 1) > 1 ? ` ×${r.missedCount}` : ""}`;
        case "rejected": return `${charName}拒接了`;
        case "declined": return "你拒接了";
        case "cancelled": return "你取消了";
    }
}

function recordSub(r: CallRecord, charName: string, now: number): string {
    const when = callWhen(r.startAt, now);
    if (r.outcome === "answered") return `${when} · ${r.hungUpBy === "char" ? `${charName}挂断` : "你挂断"}`;
    if (r.outcome === "broken") return `${when} · 没挂断就退出了`;
    return r.reason ? `${when} · 「${r.reason}」` : `${when} · ${callKindLabel(r.kind)}`;
}

function Narrated({ text }: { text: string }) {
    return <>{splitNarration(text).map((part, i) => (part.narr ? <span key={i} className="cx-narr">{part.text}</span> : <span key={i}>{part.text}</span>))}</>;
}

function RecordIcon({ record }: { record: CallRecord }) {
    const Icon = !openable(record) ? PhoneMissed : record.kind === "video" ? Video : Phone;
    return <span className={`cx-cico${!openable(record) ? " is-miss" : record.outcome === "broken" ? " is-broken" : ""}`}><Icon size={15} strokeWidth={1.8} /></span>;
}

function RecordRow({ record, charName, now, onOpen }: { record: CallRecord; charName: string; now: number; onOpen: () => void }) {
    const count = visibleLines(record).length;
    const sumline = record.outcome === "broken" ? `${count} 句散在聊天里，没收成通话卡片` : record.summary;
    const inner = (
        <>
            <RecordIcon record={record} />
            <span className="cx-ci-t">
                <b>{recordTitle(record, charName)}</b>
                <small>{recordSub(record, charName, now)}</small>
                {sumline && <span className="cx-ci-sum">{sumline}</span>}
            </span>
            <span className="cx-ci-r">{record.duration || "—"}{openable(record) && <small>{count} 句</small>}</span>
        </>
    );
    return openable(record)
        ? <button type="button" className="cx-ci" onClick={onOpen}>{inner}</button>
        : <div className="cx-ci">{inner}</div>;
}

type AudioState = { state: "idle" | "building" | "ready"; done: number; total: number; blob?: Blob };

function CallDetail({ session, record, charName, now, onDeleteMessages, onDeleted }: {
    session: ChatSession;
    record: CallRecord;
    charName: string;
    now: number;
    onDeleteMessages?: (messages: ChatMessage[]) => Promise<void> | void;
    onDeleted: () => void;
}) {
    const lines = visibleLines(record);
    const charTexts = lines.filter(m => m.role === "assistant").map(lineSpeech).filter(Boolean);
    const broken = record.outcome === "broken";
    const [editing, setEditing] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [playing, setPlaying] = useState<string | null>(null);
    const [audio, setAudio] = useState<AudioState>({ state: "idle", done: 0, total: 0 });
    const [busy, setBusy] = useState<"" | "summary" | "repair" | "delete">("");
    const [note, setNote] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const runRef = useRef(0);
    const abortRef = useRef<(() => void) | null>(null);

    const stop = useCallback(() => {
        runRef.current++;
        abortRef.current?.();
        abortRef.current = null;
        setPlaying(null);
    }, []);
    useEffect(() => stop, [stop]);

    const voice = () => {
        const config = resolveVoiceConfig(session.contactId);
        if (!config) setNote(`${charName}还没配声音：去角色的「绑定」里选一个语音`);
        return config;
    };

    const play = async (key: string, texts: string[]) => {
        if (playing === key) { stop(); return; }
        stop();
        const config = voice();
        if (!config) return;
        const run = ++runRef.current;
        setPlaying(key);
        try {
            for (const text of texts) {
                const blob = await synthesizeChatSpeech(text, config);
                if (run !== runRef.current) return;
                if (!blob) continue;
                const { promise, abort } = playAudioBlob(blob);
                abortRef.current = abort;
                await promise;
                if (run !== runRef.current) return;
            }
        } catch (error) {
            setNote(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            if (run === runRef.current) { abortRef.current = null; setPlaying(null); }
        }
    };

    // iPhone 的分享面板必须由点击直接拉起：先合成，好了再点一次才分享
    const shareAudio = async () => {
        if (audio.state === "ready" && audio.blob) {
            const kind = callKindLabel(record.kind);
            const result = await shareOrDownloadFile(audio.blob, `${charName}-${kind}-${fileStamp(record.startAt)}.wav`, `和${charName}的${kind}`);
            if (result === "downloaded") setNote("已下载 WAV 文件");
            return;
        }
        if (audio.state === "building") return;
        const config = voice();
        if (!config) return;
        setNote("");
        setAudio({ state: "building", done: 0, total: charTexts.length });
        try {
            const blob = await buildCallAudio(charTexts, config, (done, total) => setAudio(prev => ({ ...prev, done, total })));
            if (!blob) throw new Error("一句都没合成出来");
            setAudio({ state: "ready", done: 0, total: 0, blob });
            setNote("合成好了，点「分享」选「存储到文件」");
        } catch (error) {
            setAudio({ state: "idle", done: 0, total: 0 });
            setNote(`合成失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const saveEdits = () => {
        for (const m of lines) {
            const draft = drafts[m.id];
            if (draft === undefined || draft === lineShown(m)) continue;
            if (m.mediaType === "audio") updateChatMessage(m.id, { mediaData: { ...m.mediaData, label: draft, ttsText: undefined } });
            else editChatMessage(m.id, draft);
        }
        setDrafts({});
        setEditing(false);
        setAudio({ state: "idle", done: 0, total: 0 });
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    };

    const resummarize = async () => {
        setBusy("summary");
        setNote("");
        try {
            if (!await summarizeCall(session, record)) setNote("这通电话没什么可总结的");
        } catch (error) {
            setNote(`总结失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy("");
        }
    };

    const repair = async () => {
        setBusy("repair");
        try { await repairBrokenCall(session.id, record); } finally { setBusy(""); }
    };

    const remove = async () => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        const all = [record.startMsg, ...record.lines, record.endMsg].filter((m): m is ChatMessage => !!m);
        stop();
        setBusy("delete");
        try {
            if (onDeleteMessages) await onDeleteMessages(all);
            else {
                deleteChatMessagesByIds(session.id, all.map(m => m.id));
                window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
            }
            onDeleted();
        } finally {
            setBusy("");
        }
    };

    const Kind = record.kind === "video" ? Video : Phone;
    return (
        <div className="cx-calls-body">
            <div className="cx-list cx-cd">
                <div className="cx-cd-top">
                    <span className={`cx-cico${broken ? " is-broken" : ""}`}><Kind size={15} strokeWidth={1.8} /></span>
                    <span className="cx-ci-t">
                        <b>{callKindLabel(record.kind)}{record.duration ? ` · ${record.duration}` : broken ? " · 中断" : ""}</b>
                        <small>{recordSub(record, charName, now)}</small>
                    </span>
                </div>
                {broken ? (
                    <div className="cx-warn">
                        <AlertCircle size={13} />
                        <span>这通电话没正常挂断（小手机被关掉了），聊天里这 {lines.length} 句是散着的。<button type="button" disabled={!!busy} onClick={() => void repair()}>{busy === "repair" ? "修复中…" : "修复"}</button>：补一条挂断记录，收成一张通话卡片。</span>
                    </div>
                ) : (
                    <div className="cx-cd-sum">
                        <b>小结</b>
                        <span>{record.summary || "还没有"}</span>
                        <button type="button" disabled={!!busy} onClick={() => void resummarize()}>{busy === "summary" ? "总结中…" : record.summary ? "重新总结" : "生成"}</button>
                    </div>
                )}
                <div className="cx-cd-acts">
                    <button type="button" className="dg-pill" disabled={!charTexts.length || editing} onClick={() => void play("all", charTexts)}>
                        {playing === "all" ? <Square size={12} /> : <Play size={12} />}{playing === "all" ? "停" : "播整段"}
                    </button>
                    <button type="button" className="dg-pill is-ghost" onClick={() => (editing ? saveEdits() : (stop(), setEditing(true)))}><Pencil size={12} />{editing ? "保存" : "编辑"}</button>
                    {editing && <button type="button" className="dg-pill is-ghost" onClick={() => { setDrafts({}); setEditing(false); }}>取消</button>}
                    {!editing && (
                        <button type="button" className="dg-pill is-ghost" disabled={!charTexts.length || audio.state === "building"} onClick={() => void shareAudio()}>
                            {audio.state === "building" ? <Loader2 size={12} className="cx-spin" /> : <Share2 size={12} />}
                            {audio.state === "building" ? `合成中 ${audio.done}/${audio.total}` : audio.state === "ready" ? "分享" : "分享音频"}
                        </button>
                    )}
                </div>
                {note && <p className="cx-cd-note">{note}</p>}
            </div>
            <div className="cx-list cx-tl">
                {lines.map(m => {
                    const shown = lineShown(m);
                    return (
                        <div key={m.id} className="cx-tl-row" data-role={m.role}>
                            <span className="cx-tl-who">{m.role === "user" ? "你" : charName}</span>
                            {editing ? (
                                <textarea className="cx-tl-edit" value={drafts[m.id] ?? shown} rows={Math.min(6, Math.max(1, Math.ceil(shown.length / 18)))}
                                    onChange={e => setDrafts(prev => ({ ...prev, [m.id]: e.target.value }))} />
                            ) : (
                                <span className="cx-tl-tx"><Narrated text={stripVoiceExpression(shown)} /></span>
                            )}
                            {!editing && m.role === "assistant" && (
                                <button type="button" className="cx-tl-play" aria-label={playing === m.id ? "停" : "播这句"} onClick={() => void play(m.id, [lineSpeech(m)])}>
                                    {playing === m.id ? <Square size={10} /> : <Play size={10} />}
                                </button>
                            )}
                        </div>
                    );
                })}
                {!lines.length && <p className="cx-empty">这通电话里没说话</p>}
            </div>
            <p className="cx-note">播放用{charName}现在的声音重新合成，不是当时的录音；只读 TA 说的话。改字就是改聊天里那条消息。</p>
            <button type="button" className="cx-cd-del" disabled={busy === "delete"} onClick={() => void remove()}>
                <Trash2 size={14} />{confirmDelete ? "再点一次，删掉这通电话的所有消息" : "删除这通电话"}
            </button>
        </div>
    );
}

export function CallRecordsPage({ session, characterName, onClose, onDeleteMessages, initialRecordId }: {
    session: ChatSession;
    characterName: string;
    onClose: () => void;
    onDeleteMessages?: (messages: ChatMessage[]) => Promise<void> | void;
    initialRecordId?: string;
}) {
    const [messages, setMessages] = useState(() => [...loadChatMessages(session.id)]);
    const [openId, setOpenId] = useState<string | null>(initialRecordId ?? null);
    const [now] = useState(() => Date.now());

    useEffect(() => {
        const reload = () => setMessages([...loadChatMessages(session.id)]);
        window.addEventListener("chat-messages-updated", reload);
        window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, reload);
        return () => {
            window.removeEventListener("chat-messages-updated", reload);
            window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, reload);
        };
    }, [session.id]);

    const records = useMemo(() => listCallRecords(messages), [messages]);
    const open = openId ? records.find(r => r.id === openId) ?? null : null;

    return (
        <PageShell title={open ? "通话详情" : "通话记录"} onBack={open ? () => setOpenId(null) : onClose} className="absolute inset-0 z-[110] cx-calls">
            {open ? (
                <CallDetail key={open.id} session={session} record={open} charName={characterName} now={now} onDeleteMessages={onDeleteMessages} onDeleted={() => setOpenId(null)} />
            ) : (
                <div className="cx-calls-body">
                    <div className="cx-sec">
                        <div className="cx-sec-h"><span>和{characterName}的通话</span><span>共 {records.length} 通</span></div>
                        {records.length ? (
                            <div className="cx-list">
                                {records.map(r => <RecordRow key={r.id} record={r} charName={characterName} now={now} onOpen={() => setOpenId(r.id)} />)}
                            </div>
                        ) : <p className="cx-empty">还没打过电话</p>}
                    </div>
                    <p className="cx-note">记录就是聊天里那些通话消息，不另存一份：删了聊天记录，这里也跟着没了。</p>
                </div>
            )}
        </PageShell>
    );
}
