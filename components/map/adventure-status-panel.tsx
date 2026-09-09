"use client";

import { useEffect, useRef, useState, type SetStateAction, type CSSProperties } from "react";
import {
  type AdventureStatus, type AdventureStatusField, emptyAdventureStatus, palaceStatusFields,
  editAdventureStatus, dismissStatusProposal,
} from "@/lib/adventure-status";

const control: CSSProperties = { width: "100%", minHeight: 30, border: "1px solid var(--c-adv-input-border, #342e25)", borderRadius: 5, background: "var(--c-adv-input-bg, #151310)", color: "var(--c-adv-body, #d6cec1)", padding: "5px 7px", fontFamily: "inherit", fontSize: "calc(11px*var(--app-text-scale,1))", lineHeight: 1.45, boxSizing: "border-box" };
const button: CSSProperties = { ...control, width: "auto", cursor: "pointer", background: "transparent" };


export default function AdventureStatusPanel({ state, onSave, gameTime, disabled = false, creation = false, onDirtyChange, onGenerate, onGenerationChange }: {
  state?: AdventureStatus;
  onSave: (next: AdventureStatus, expectedRevision: number) => void;
  gameTime: string;
  disabled?: boolean;
  creation?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onGenerate?: (fields: AdventureStatusField[], signal: AbortSignal) => Promise<AdventureStatusField[]>;
  onGenerationChange?: (generating: boolean) => void;
}) {
  const current = state ?? emptyAdventureStatus();
  const [generating, setGenerating] = useState(false);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    onGenerationChange?.(false);
  }, [onGenerationChange]);
  const [enabled, setEnabled] = useState(current.enabled);
  const [fields, setFields] = useState<AdventureStatusField[]>(() => current.fields.map(f => ({ ...f })));
  const [reason, setReason] = useState(creation ? "创建世界时设置初始状态" : "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recordLimit, setRecordLimit] = useState(20);
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const stamp = () => ({ id: crypto.randomUUID(), gameTime, createdAt: new Date().toISOString() });
  const updateFields = (next: SetStateAction<AdventureStatusField[]>) => { setFields(next); onDirtyChange?.(true); };
  const patch = (id: string, value: Partial<AdventureStatusField>) => updateFields(prev => prev.map(f => f.id === id ? { ...f, ...value } : f));
  const cancelGeneration = (message = "已取消生成，原有字段未改变") => {
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    setGenerating(false); onGenerationChange?.(false); setNotice(message);
  };
  const generate = async () => {
    if (!onGenerate || disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setGenerating(true); onGenerationChange?.(true); setError(""); setNotice("");
    timer.current = setTimeout(() => cancelGeneration("生成超过 120 秒，已停止等待，请检查模型连接后重试"), 120000);
    try {
      const suggested = await onGenerate(fields.map(f => ({ ...f })), controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      updateFields(suggested);
      if (!reason.trim()) setReason("根据当前世界与剧情采纳 AI 建议字段");
      setNotice(`AI 已补充 ${suggested.length - fields.length} 个建议字段，尚未保存。请检查初始值和规则后保存。`);
    } catch (e) {
      if (!controller.signal.aborted && request.current === controller) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (timer.current) clearTimeout(timer.current);
        setGenerating(false); onGenerationChange?.(false);
      }
    }
  };
  const submit = () => {
    try {
      const next = editAdventureStatus(current, enabled, fields, reason, stamp());
      onSave(next, current.revision);
      onDirtyChange?.(false);
      setError(""); setNotice("状态设置已保存");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const dismiss = () => {
    try {
      onSave(dismissStatusProposal(current, dismissId!, dismissReason, stamp()), current.revision);
      setDismissId(null); setDismissReason(""); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return <section className="adv-custom-status" aria-label="自定义状态">
    <style>{`
      .adv-custom-status { margin-bottom:14px; color:var(--c-adv-body,#d6cec1); font-size:calc(11px*var(--app-text-scale,1)); line-height:1.5; overflow-wrap:anywhere; }
      .adv-custom-status .acs-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:2px 0 8px; }
      .adv-custom-status .acs-heading strong { font-size:calc(11px*var(--app-text-scale,1)); font-weight:500; letter-spacing:.06em; }
      .adv-custom-status .acs-muted { color:var(--c-adv-text-muted,#958b7b); font-size:calc(10px*var(--app-text-scale,1)); }
      .adv-custom-status .acs-hint { margin:4px 0 8px; color:var(--c-adv-text-muted,#958b7b); font-size:calc(10px*var(--app-text-scale,1)); }
      .adv-custom-status .acs-values { display:grid; grid-template-columns:1fr 1fr; gap:4px 12px; margin:0 0 8px; }
      .adv-custom-status .acs-values > div { display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding:5px 0; border-bottom:1px solid var(--c-adv-input-border,#342e25); min-width:0; }
      .adv-custom-status dt { color:var(--c-adv-text-muted,#958b7b); font-size:calc(10px*var(--app-text-scale,1)); }
      .adv-custom-status dd { margin:0; text-align:right; color:var(--c-adv-accent,#c8a064); }
      .adv-custom-status details > summary { min-height:30px; display:flex; align-items:center; gap:8px; cursor:pointer; list-style:none; font-size:calc(10px*var(--app-text-scale,1)); color:var(--c-adv-text-muted,#958b7b); }
      .adv-custom-status details > summary::-webkit-details-marker { display:none; }
      .adv-custom-status details > summary::after { content:'+'; margin-left:auto; font-size:12px; font-weight:400; opacity:.7; }
      .adv-custom-status details[open] > summary::after { content:'−'; }
      .adv-custom-status .acs-editor { border-top:1px solid var(--c-adv-input-border,#342e25); }
      .adv-custom-status .acs-toggle { display:flex; align-items:center; gap:7px; min-height:30px; color:var(--c-adv-body,#d6cec1); }
      .adv-custom-status input[type=checkbox] { width:12px; height:12px; margin:0; accent-color:var(--c-adv-accent,#c8a064); }
      .adv-custom-status .acs-field { border-bottom:1px solid var(--c-adv-input-border,#342e25); }
      .adv-custom-status .acs-field > summary { min-height:34px; color:inherit; font-size:calc(11px*var(--app-text-scale,1)); }
      .adv-custom-status .acs-field-name { flex:1; min-width:0; }
      .adv-custom-status .acs-field-value { max-width:50%; text-align:right; color:var(--c-adv-accent,#c8a064); }
      .adv-custom-status .acs-field fieldset { border:0; margin:0; padding:4px 0 10px; min-width:0; }
      .adv-custom-status .acs-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px 8px; margin-bottom:6px; }
      .adv-custom-status label:not(.acs-toggle) { display:block; min-width:0; color:var(--c-adv-text-muted,#958b7b); font-size:calc(10px*var(--app-text-scale,1)); }
      .adv-custom-status label > input:not([type=checkbox]), .adv-custom-status label > textarea { display:block; margin-top:3px; }
      .adv-custom-status .acs-actions { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:8px 0; }
      .adv-custom-status .acs-primary { border-color:var(--c-adv-accent-dim,#78613d) !important; color:var(--c-adv-accent,#c8a064) !important; background:var(--c-adv-choice-bg,rgba(200,160,100,.05)) !important; }
      .adv-custom-status .acs-record { border-top:1px solid var(--c-adv-input-border,#342e25); padding:7px 0; }
      .adv-custom-status .acs-record strong { font-size:inherit; font-weight:500; }
      .adv-custom-status .acs-record small { font-size:calc(9px*var(--app-text-scale,1)); color:var(--c-adv-text-muted,#958b7b); }
      .adv-custom-status blockquote { margin:4px 0; padding-left:7px; border-left:1px solid var(--c-adv-accent-dim,#78613d); color:var(--c-adv-text-muted,#958b7b); font-size:calc(10px*var(--app-text-scale,1)); }
      .adv-custom-status button:disabled { cursor:default; opacity:.45; }
      .adv-custom-status :is(button,input,textarea,summary):focus-visible { outline:1px solid var(--c-adv-accent,#c8a064); outline-offset:2px; }
    `}</style>
    <div className="acs-heading">
      <strong>自定义状态</strong>
      <span className="acs-muted">{current.enabled ? "已开启" : "未开启"}</span>
    </div>
    {!current.enabled && <p className="acs-hint">让 AI 按世界设定生成身份与数值。</p>}
    {current.enabled && <dl className="acs-values">{current.fields.map(f => <div key={f.id}>
      <dt>{f.name}</dt><dd title={f.type === "number" ? `范围 ${f.min}～${f.max}` : undefined}>{String(f.value)}</dd>
    </div>)}</dl>}
    <details className="acs-editor" open={creation || undefined}>
      <summary>设置与手动纠正</summary>
      <fieldset disabled={disabled || generating} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, opacity: disabled ? 0.6 : 1 }}>
        <label className="acs-toggle"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); onDirtyChange?.(true); }} />启用自定义状态</label>
        {enabled && <>
          {onGenerate && <div className="acs-actions">
            <button type="button" className="acs-primary" style={button} disabled={fields.length >= 20} onClick={generate}>{generating ? "AI 正在生成建议…" : fields.length ? "让 AI 补充字段" : "让 AI 根据世界生成字段"}</button>
          </div>}
          {fields.length === 0 && <button type="button" style={button} onClick={() => updateFields(palaceStatusFields())}>填入宫廷示例</button>}
          {fields.length > 0 && <p className="acs-hint">点击字段编辑 · 数值不自动改变身份</p>}
          {fields.map((f, i) => <details className="acs-field" key={f.id}>
            <summary aria-label={`编辑${f.name || `字段 ${i + 1}`}`}>
              <span className="acs-field-name">{f.name || `字段 ${i + 1}`}</span>
              <span className="acs-field-value">{String(Number.isNaN(f.value) ? "—" : f.value)}</span>
            </summary>
            <fieldset>
              <div className="acs-grid">
                <label>名称<input style={control} value={f.name} maxLength={40} onChange={e => patch(f.id, { name: e.target.value })} /></label>
                <label>{f.type === "text" ? "当前身份 / 文字" : "当前数值"}<input style={control} type={f.type === "number" ? "number" : "text"} step="any" value={typeof f.value === "number" && !Number.isFinite(f.value) ? "" : f.value} maxLength={200} onChange={e => patch(f.id, { value: f.type === "number" ? e.target.value === "" ? NaN : Number(e.target.value) : e.target.value })} /></label>
              </div>
              {f.type === "number" && <div className="acs-grid">
                <label>最小值<input style={control} type="number" step="any" value={Number.isFinite(f.min) ? f.min : ""} onChange={e => patch(f.id, { min: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
                <label>最大值<input style={control} type="number" step="any" value={Number.isFinite(f.max) ? f.max : ""} onChange={e => patch(f.id, { max: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
              </div>}
              <label>变更规则<textarea style={{ ...control, minHeight: 56, resize: "vertical" }} value={f.rule} maxLength={800} onChange={e => patch(f.id, { rule: e.target.value })} placeholder="哪些事件可以改变它？" /></label>
              <button type="button" style={{ ...button, marginTop: 6, color: "var(--c-adv-text-muted,#958b7b)", borderColor: "transparent", paddingLeft: 0 }} onClick={() => {
                if (window.confirm(`移除“${f.name || "未命名字段"}”？保存后生效，历史记录保留。`)) updateFields(prev => prev.filter(item => item.id !== f.id));
              }}>移除字段</button>
            </fieldset>
          </details>)}
          <div className="acs-actions">
            {(["text", "number"] as const).map(type => <button key={type} type="button" style={button} disabled={fields.length >= 20} onClick={() => updateFields(prev => [...prev, {
              id: crypto.randomUUID(), name: "", type, value: type === "text" ? "待设定" : 0,
              rule: type === "text" ? "仅已发生并正式生效的剧情事件可以改变此状态。" : "依据已发生的剧情增减，不自动决定身份变化。",
              ...(type === "number" ? { min: 0, max: 100 } : {}),
            }])}>＋{type === "text" ? "身份 / 文字" : "辅助数值"}</button>)}
          </div>
        </>}
        {!enabled && current.fields.length > 0 && <p className="acs-hint">关闭后保留原值与记录，保存后生效。</p>}
        <label>设置或纠正原因<textarea rows={1} style={{ ...control, resize: "vertical" }} maxLength={800} value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：按已有剧情补录初始身份" /></label>
        <div className="acs-actions"><button type="button" className="acs-primary" style={button} onClick={submit}>保存状态设置</button></div>
      </fieldset>
      {generating && <div role="status" className="acs-hint">生成中，最多等待 120 秒。<button type="button" style={button} onClick={() => cancelGeneration()}>取消生成</button></div>}
      {disabled && <p role="status" className="acs-hint">剧情生成中，请稍后修改。</p>}
    </details>
    {error && <p role="alert" style={{ color: "#e5a69b", margin: "6px 0" }}>{error}</p>}
    {notice && <p role="status" className="acs-hint">{notice}</p>}
    {current.records.some(r => r.status === "pending") && <details>
      <summary>待发生事项（不改变当前值）</summary>
      {current.records.filter(r => r.status === "pending").map(r => <div key={r.id} className="acs-record">
        <strong>{r.fieldName} → {String(r.to)}</strong><div>{r.reason}</div><small>{r.gameTime}</small>
        <div><button type="button" style={button} disabled={disabled || generating} onClick={() => { setDismissId(r.id); setDismissReason(""); }}>撤销此待发生事项</button></div>
        {dismissId === r.id && <div>
          <label>撤销原因<input style={control} value={dismissReason} maxLength={800} onChange={e => setDismissReason(e.target.value)} disabled={disabled || generating} /></label>
          <div className="acs-actions"><button type="button" style={button} disabled={disabled || generating} onClick={dismiss}>确认撤销</button>
          <button type="button" style={button} onClick={() => setDismissId(null)}>取消</button></div>
        </div>}
      </div>)}
    </details>}
    {current.records.length > 0 && <details>
      <summary>变更记录 · {current.records.length}</summary>
      {[...current.records].reverse().slice(0, recordLimit).map(r => <article key={r.id} className="acs-record">
        <strong>{r.fieldName}：{String(r.from)} → {String(r.to)}</strong>
        <div className="acs-muted">{({ applied: "已生效", pending: "待发生", resolved: "已兑现", dismissed: "已撤销 / 已取代" })[r.status]} · {r.source === "manual" ? "手动设置 / 纠正" : "剧情事件"}</div>
        <div>{r.reason}</div>{r.evidence && <blockquote>{r.evidence}</blockquote>}
        <small>{r.gameTime} · {new Date(r.createdAt).toLocaleString()}</small>
      </article>)}
      {current.records.length > recordLimit && <button type="button" style={button} onClick={() => setRecordLimit(n => n + 20)}>查看更多记录</button>}
    </details>}
  </section>;
}
