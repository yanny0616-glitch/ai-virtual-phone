"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, Asterisk, Camera, ChevronRight, Clapperboard, History, Images, MapPin, MessageSquareText, NotebookPen, Paintbrush, PhoneOff, Ruler, type LucideIcon } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import { REPLY_COUNT_MAX, REPLY_LENGTH_MODES, type ReplyLengthMode } from "@/lib/reply-style";
import { callSettings } from "@/lib/call-directives";
import { CALL_ART_CHANGED_EVENT, defaultCallArt, loadCallArt } from "@/lib/call-art";
import { callCssPresetName } from "@/lib/call-css";
import { listCallRecords } from "@/lib/call-records";
import { loadChatMessages, type ChatSession } from "@/lib/chat-storage";
import { CallArtSheet } from "./call-art-sheet";
import { CallCssSheet } from "./call-css-sheet";

type InfoIcon = (props: { icon: LucideIcon; color: string }) => ReactNode;
type RowsProps = { session: ChatSession; updateSession: (updates: Partial<ChatSession>) => void; InfoIcon: InfoIcon };

function ToggleRow({ InfoIcon, icon, color, label, desc, checked, onChange }: {
    InfoIcon: InfoIcon; icon: LucideIcon; color: string; label: string; desc: string; checked: boolean; onChange: (on: boolean) => void;
}) {
    return (
        <div className="menu-item">
            <InfoIcon icon={icon} color={color} />
            <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc">{desc}</span></div>
            <div className="menu-right"><Toggle checked={checked} onChange={onChange} /></div>
        </div>
    );
}

/** 聊天信息 ›「聊天」：回复长度、整段一个气泡、线上动作描写、自动切换线上线下 */
export function ReplyStyleRows({ session, updateSession, InfoIcon }: RowsProps) {
    const [mode, setMode] = useState<ReplyLengthMode>(session.replyLength ?? "mood");
    const [range, setRange] = useState<[number, number]>([session.replyMin ?? 1, session.replyMax ?? 4]);
    const [single, setSingle] = useState(!!session.singleBubble);
    const [actions, setActions] = useState(!!session.onlineActions);
    const [autoSwitch, setAutoSwitch] = useState(!!session.autoModeSwitch);

    const step = (which: 0 | 1, delta: number) => {
        const next: [number, number] = [range[0], range[1]];
        next[which] = Math.min(REPLY_COUNT_MAX, Math.max(1, next[which] + delta));
        if (next[0] > next[1]) next[which === 0 ? 1 : 0] = next[which];
        setRange(next);
        updateSession({ replyMin: next[0], replyMax: next[1] });
    };

    return (
        <>
            <div className="menu-item">
                <InfoIcon icon={Ruler} color={CONTENT_APP_ACCENTS.chat} />
                <div className="menu-label-group">
                    <span className="menu-label">回复长度</span>
                    <span className="menu-desc">{mode === "custom" ? `每轮 ${range[0]}～${range[1]} 句，是提醒不是硬截断` : REPLY_LENGTH_MODES.find(m => m.id === mode)?.desc}</span>
                </div>
            </div>
            <div className="cx-info-minis cx-len">
                <div className="cx-minis" role="radiogroup" aria-label="回复长度">
                    {REPLY_LENGTH_MODES.map(m => (
                        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => { setMode(m.id); updateSession({ replyLength: m.id }); }}>{m.label}</button>
                    ))}
                </div>
                {mode === "custom" && (
                    <div className="cx-step cx-count">
                        <em>每轮</em>
                        <button type="button" aria-label="最少减一" onClick={() => step(0, -1)}>−</button><b>{range[0]}</b><button type="button" aria-label="最少加一" onClick={() => step(0, 1)}>+</button>
                        <em>到</em>
                        <button type="button" aria-label="最多减一" onClick={() => step(1, -1)}>−</button><b>{range[1]}</b><button type="button" aria-label="最多加一" onClick={() => step(1, 1)}>+</button>
                        <em>句</em>
                    </div>
                )}
            </div>
            <ToggleRow InfoIcon={InfoIcon} icon={MessageSquareText} color={BINDING_ACCENTS.voice} label="整段一个气泡" desc="一轮回复放进一个气泡；表情包、照片还是单独一条"
                checked={single} onChange={on => { setSingle(on); updateSession({ singleBubble: on }); }} />
            <ToggleRow InfoIcon={InfoIcon} icon={Asterisk} color={BINDING_ACCENTS.memory} label="线上动作描写" desc="允许 *低头笑了一下* 这种，气泡里显示成灰色斜体"
                checked={actions} onChange={on => { setActions(on); updateSession({ onlineActions: on }); }} />
            <ToggleRow InfoIcon={InfoIcon} icon={ArrowLeftRight} color={BINDING_ACCENTS.api} label="自动切换线上线下" desc="聊到见面，TA 自己切进线下；分开了再切回来"
                checked={autoSwitch} onChange={on => { setAutoSwitch(on); updateSession({ autoModeSwitch: on }); }} />
        </>
    );
}

export function callSectionSummary(session: ChatSession): string {
    const flags = callSettings(session);
    return [flags.narration && "动描", flags.hangup && "TA 能挂断", flags.summary && "小结", session.callCSS?.trim() && callCssPresetName(session.callCSS)]
        .filter(Boolean).join(" · ") || "全关";
}

/** 聊天信息 ›「通话」：children 放原来外观里的通话背景两行 */
export function CallSettingsRows({ session, updateSession, InfoIcon, characterName, onOpenRecords, children }: RowsProps & {
    characterName: string;
    onOpenRecords: () => void;
    children?: ReactNode;
}) {
    const [flags, setFlags] = useState(() => callSettings(session));
    const [lib, setLib] = useState(() => loadCallArt(session.contactId));
    const [callCSS, setCallCSS] = useState(session.callCSS || "");
    const [sheet, setSheet] = useState<"art" | "css" | null>(null);
    const [recordCount] = useState(() => listCallRecords(loadChatMessages(session.id)).length);

    useEffect(() => {
        const onChange = () => setLib(loadCallArt(session.contactId));
        window.addEventListener(CALL_ART_CHANGED_EVENT, onChange);
        return () => window.removeEventListener(CALL_ART_CHANGED_EVENT, onChange);
    }, [session.contactId]);

    const flag = (key: keyof typeof flags, field: keyof ChatSession) => ({
        checked: flags[key],
        onChange: (on: boolean) => { setFlags(prev => ({ ...prev, [key]: on })); updateSession({ [field]: on }); },
    });
    const defaults = [defaultCallArt(lib, "portrait")?.name, defaultCallArt(lib, "scene")?.name].filter(Boolean).join(" · ");

    return (
        <>
            <ToggleRow InfoIcon={InfoIcon} icon={Clapperboard} color={BINDING_ACCENTS.memory} label="通话动描" desc="TA 可以写（把手机拿远了一点）这种旁白，字幕灰色显示，语音不读" {...flag("narration", "callNarration")} />
            <ToggleRow InfoIcon={InfoIcon} icon={PhoneOff} color={"var(--c-danger)"} label="允许 TA 主动挂断" desc="吵架、困了、有事，TA 会自己挂；关掉就只有你能挂" {...flag("hangup", "allowCharHangup")} />
            <ToggleRow InfoIcon={InfoIcon} icon={NotebookPen} color={BINDING_ACCENTS.preset} label="通话小结" desc="挂断后多请求一次 AI，用一句话记下聊了什么，挂在通话卡片上" {...flag("summary", "callSummary")} />
            <ToggleRow InfoIcon={InfoIcon} icon={Camera} color={BINDING_ACCENTS.voice} label="视频时我的摄像头默认打开" desc="接通就开前置，不用每次点" {...flag("cameraDefault", "callCameraDefault")} />
            <ToggleRow InfoIcon={InfoIcon} icon={MapPin} color={BINDING_ACCENTS.api} label="场景跟着 TA 在哪" desc="在线状态里 TA 在公司，就换「公司」场景；对不上的用默认" {...flag("sceneFollow", "callSceneFollow")} />
            <button type="button" className="menu-item" onClick={() => setSheet("art")}>
                <InfoIcon icon={Images} color={BINDING_ACCENTS.embedding} />
                <div className="menu-label-group">
                    <span className="menu-label">立绘和场景</span>
                    <span className="menu-desc">{lib.portraits.length} 张立绘 · {lib.scenes.length} 个场景，缺了就用头像和通话背景</span>
                </div>
                <div className="menu-right">{defaults && <span className="menu-desc mr-1">{defaults}</span>}<ChevronRight size={16} /></div>
            </button>
            <button type="button" className="menu-item" onClick={() => setSheet("css")}>
                <InfoIcon icon={Paintbrush} color={BINDING_ACCENTS.voice} />
                <div className="menu-label-group"><span className="menu-label">通话美化</span><span className="menu-desc">给通话界面写 CSS，有直播风预设</span></div>
                <div className="menu-right"><span className="menu-desc mr-1">{callCssPresetName(callCSS)}</span><ChevronRight size={16} /></div>
            </button>
            <button type="button" className="menu-item" onClick={onOpenRecords}>
                <InfoIcon icon={History} color={CONTENT_APP_ACCENTS.chat} />
                <div className="menu-label-group"><span className="menu-label">通话记录</span><span className="menu-desc">回放、编辑、分享音频、修复中断的通话</span></div>
                <div className="menu-right"><span className="menu-desc mr-1">{recordCount} 通</span><ChevronRight size={16} /></div>
            </button>
            {children}
            {sheet === "art" && (
                <CallArtSheet characterId={session.contactId} characterName={characterName} artSwitch={flags.artSwitch}
                    onArtSwitch={on => { setFlags(prev => ({ ...prev, artSwitch: on })); updateSession({ callArtSwitch: on }); }}
                    onClose={() => setSheet(null)} />
            )}
            {sheet === "css" && <CallCssSheet value={callCSS} onSave={css => { setCallCSS(css); updateSession({ callCSS: css }); }} onClose={() => setSheet(null)} />}
        </>
    );
}
