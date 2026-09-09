"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MapWorld } from "@/lib/map-types";
import type { WorldSettingPlan } from "@/lib/adventure-world-edit";

const input: CSSProperties = { width: "100%", minHeight: 56, boxSizing: "border-box", padding: "6px 8px", borderRadius: 5, border: "1px solid var(--c-adv-input-border,#342e25)", background: "var(--c-adv-input-bg,#151310)", color: "inherit", font: "inherit", resize: "vertical" };
const button: CSSProperties = { minHeight: 30, padding: "5px 8px", border: "1px solid var(--c-adv-input-border,#342e25)", borderRadius: 5, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" };

export default function AdventureWorldEditor({ world, disabled, onGenerate, onApply, onBusyChange }: {
  world: MapWorld;
  disabled: boolean;
  onGenerate: (instruction: string, signal: AbortSignal) => Promise<WorldSettingPlan>;
  onApply: (plan: WorldSettingPlan) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<WorldSettingPlan | null>(null);
  const [busy, setBusy] = useState<"" | "generating" | "saving">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    onBusyChange(false);
  }, [onBusyChange]);
  const cancel = (message = "已取消生成，原设定未改变") => {
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    setBusy(""); onBusyChange(false); setNotice(message);
  };
  const generate = async () => {
    if (disabled || request.current || saving.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy("generating"); onBusyChange(true); setError(""); setNotice(""); setPlan(null);
    timer.current = setTimeout(() => cancel("生成超过 120 秒，已停止等待，请缩小修改范围后重试"), 120000);
    try {
      const result = await onGenerate(instruction, controller.signal);
      if (!controller.signal.aborted && request.current === controller) setPlan(result);
    } catch (e) {
      if (!controller.signal.aborted && request.current === controller) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (timer.current) clearTimeout(timer.current);
        setBusy(""); onBusyChange(false);
      }
    }
  };
  const apply = async () => {
    if (!plan || disabled || request.current || saving.current) return;
    saving.current = true; setBusy("saving"); onBusyChange(true); setError(""); setNotice("");
    try {
      await onApply(plan);
      setPlan(null); setNotice("已保存，后续剧情使用新设定。已有进度和历史保留。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(""); onBusyChange(false); }
  };

  return <section className="adv-world-editor" aria-label="世界设定编辑">
    <style>{`
      .adv-world-editor { font-size:calc(11px*var(--app-text-scale,1)); line-height:1.5; margin-bottom:14px; color:var(--c-adv-body,#d6cec1); overflow-wrap:anywhere; }
      .adv-world-editor details > summary { list-style:none; display:flex; align-items:center; gap:8px; min-height:32px; cursor:pointer; }
      .adv-world-editor details > summary::-webkit-details-marker { display:none; }
      .adv-world-editor details > summary::after { content:'+'; margin-left:auto; opacity:.6; }
      .adv-world-editor details[open] > summary::after { content:'−'; }
      .adv-world-editor .awe-muted { font-size:calc(10px*var(--app-text-scale,1)); color:var(--c-adv-text-muted,#958b7b); }
      .adv-world-editor .awe-row { padding:6px 0; border-top:1px solid var(--c-adv-input-border,#342e25); }
      .adv-world-editor .awe-actions { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
      .adv-world-editor p { margin:4px 0 8px; }
      .adv-world-editor label { display:block; }
      .adv-world-editor textarea { display:block; margin-top:4px; }
      .adv-world-editor .awe-preview { padding:7px 8px; margin:6px 0; border-left:2px solid var(--c-adv-accent-dim,#78613d); background:var(--c-adv-input-bg,#151310); white-space:pre-wrap; }
      .adv-world-editor button:disabled { opacity:.45; cursor:default; }
      .adv-world-editor :is(button,textarea,summary):focus-visible { outline:1px solid var(--c-adv-accent,#c8a064); outline-offset:2px; }
    `}</style>
    <details onToggle={e => { if (!e.currentTarget.open && request.current) cancel(); }}>
      <summary>世界设定 <span className="awe-muted">AI 编辑</span></summary>
      <details className="awe-row">
        <summary className="awe-muted">查看当前背景与 NPC · {world.skeleton.npcs.length} 人</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{world.skeleton.world.lore}</p>
        {world.skeleton.npcs.map(n => <details key={n.id} className="awe-row">
          <summary>{n.name}<span className="awe-muted">{n.locationNode}</span></summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{n.personality}</p>
        </details>)}
      </details>
      <label>修改要求<textarea aria-label="世界设定修改要求" style={input} value={instruction} maxLength={4000} disabled={disabled || !!busy} onChange={e => { setInstruction(e.target.value); setPlan(null); setNotice(""); }} placeholder="例如：把陆敬堂改成四十岁的权臣，保留姓名与立场；皇帝尚无子嗣，其余背景不变。" /></label>
      <p className="awe-muted">支持背景、已有 NPC 的姓名与人设。先预览，确认后保存。</p>
      <div className="awe-actions">
        <button type="button" style={{ ...button, color: "var(--c-adv-accent,#c8a064)" }} disabled={disabled || !!busy || !instruction.trim()} onClick={generate}>{busy === "generating" ? "正在生成改动…" : "生成修改预览"}</button>
        {busy === "generating" && <button type="button" style={button} onClick={() => cancel()}>取消生成</button>}
      </div>
      {busy === "generating" && <p role="status" className="awe-muted">最多等待 120 秒，生成期间不改变世界设定。</p>}
      {plan && <div aria-label="世界设定修改预览">
        <p className="awe-muted">{plan.changes.length} 处改动 · 尚未保存</p>
        {plan.changes.map(c => <article key={`${c.target}:${c.field}`} className="awe-row">
          <div>{c.label}</div><p className="awe-muted">{c.reason}</p>
          <details><summary className="awe-muted">修改前</summary><div style={{ whiteSpace: "pre-wrap" }}>{c.before}</div></details>
          <div className="awe-preview"><span className="awe-muted">修改后</span><div>{c.after}</div></div>
        </article>)}
        <div className="awe-actions">
          <button type="button" style={{ ...button, color: "var(--c-adv-accent,#c8a064)" }} disabled={disabled || !!busy} onClick={apply}>{busy === "saving" ? "保存中…" : "确认保存改动"}</button>
          <button type="button" style={button} disabled={!!busy} onClick={() => setPlan(null)}>放弃预览</button>
        </div>
      </div>}
      {error && <p role="alert" style={{ color: "#e5a69b" }}>{error}</p>}
      {notice && <p role="status" className="awe-muted">{notice}</p>}
      {disabled && <p className="awe-muted">剧情生成中，请完成后再编辑。</p>}
    </details>
  </section>;
}
