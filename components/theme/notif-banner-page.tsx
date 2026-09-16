"use client";

// 通知横幅美化：全局一份，改的是 --notif-* 变量，存进主题档案的 cssOverrides
// （所以外观预设、主题包导出都自动带上）。预览用横幅真实的 class 和真实的 CSS，
// 自定义 CSS 写了什么这里就长什么样。

import { useState, type CSSProperties } from "react";
import type { ThemeProfile } from "@/lib/theme-types";

type NotifBannerPageProps = {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
};

type Scene = "single" | "group" | "system" | "long" | "call";

const SCENES: { id: Scene; label: string }[] = [
  { id: "single", label: "单聊" },
  { id: "group", label: "群聊" },
  { id: "system", label: "系统" },
  { id: "long", label: "长文本" },
  { id: "call", label: "来电" },
];

const SCENE_DATA: Record<Exclude<Scene, "call">, { title: string; body: string; group: boolean }> = {
  single: { title: "林林", body: "在忙吗？刚路过那家店", group: false },
  group: { title: "读书群", body: "阿野：这本我上周才看完", group: true },
  system: { title: "系统", body: "本地数据库写入失败，点开看看", group: false },
  long: { title: "苏雯", body: "我刚刚把整件事从头到尾想了一遍，还是觉得当时不该那样说，你要是愿意听我想解释一下", group: false },
};

/** 每一项都是一个 --notif-* 变量；留空就是不写，走 CSS 里的默认值 */
type Control =
  | { kind: "range"; key: string; label: string; min: number; max: number; step: number; unit: string; def: number; hint?: string }
  | { kind: "select"; key: string; label: string; options: { value: string; label: string }[]; hint?: string };

const CONTROLS: { group: string; items: Control[] }[] = [
  {
    group: "版式",
    items: [
      { kind: "select", key: "--notif-layout", label: "排法", options: [
        { value: "", label: "左图右字（默认）" },
        { value: "row-reverse", label: "右图左字" },
        { value: "column", label: "上图下字（拍立得）" },
      ] },
      { kind: "select", key: "--notif-text-align", label: "文字对齐", options: [
        { value: "", label: "靠左（默认）" },
        { value: "center", label: "居中" },
        { value: "right", label: "靠右" },
      ] },
      { kind: "select", key: "--notif-action-order", label: "「查看」按钮", options: [
        { value: "", label: "在右边（默认）" },
        { value: "-1", label: "在左边" },
      ] },
    ],
  },
  {
    group: "位置和尺寸",
    items: [
      { kind: "range", key: "--notif-top", label: "离顶部", min: 8, max: 200, step: 1, unit: "px", def: 54 },
      { kind: "range", key: "--notif-left", label: "左边距", min: 0, max: 80, step: 1, unit: "px", def: 10 },
      { kind: "range", key: "--notif-right", label: "右边距", min: 0, max: 80, step: 1, unit: "px", def: 10 },
      { kind: "range", key: "--notif-min-height", label: "最矮多高", min: 0, max: 200, step: 2, unit: "px", def: 66 },
      { kind: "range", key: "--notif-radius", label: "圆角", min: 0, max: 40, step: 1, unit: "px", def: 18 },
      { kind: "range", key: "--notif-gap", label: "图文间距", min: 0, max: 32, step: 1, unit: "px", def: 12 },
    ],
  },
  {
    group: "头像",
    items: [
      { kind: "range", key: "--notif-avatar-w", label: "宽", min: 0, max: 140, step: 2, unit: "px", def: 42, hint: "拍立得版式里想让图铺满，把它拉到最大" },
      { kind: "range", key: "--notif-avatar-h", label: "高", min: 0, max: 200, step: 2, unit: "px", def: 42 },
      { kind: "range", key: "--notif-avatar-radius", label: "圆角", min: 0, max: 50, step: 1, unit: "%", def: 50 },
    ],
  },
  {
    group: "停留",
    items: [
      { kind: "range", key: "--notif-duration", label: "停多久", min: 1.2, max: 30, step: 0.2, unit: "s", def: 6, hint: "新消息横幅按这个自动收起；手指按住时不计时" },
    ],
  },
];

const PRESETS: { name: string; vars: Record<string, string> }[] = [
  { name: "默认", vars: {} },
  {
    name: "窄条",
    vars: {
      "--notif-min-height": "48px",
      "--notif-padding": "7px 10px",
      "--notif-avatar-w": "30px",
      "--notif-avatar-h": "30px",
      "--notif-radius": "12px",
      "--notif-gap": "9px",
    },
  },
  {
    name: "居中卡片",
    vars: {
      "--notif-left": "30px",
      "--notif-right": "30px",
      "--notif-radius": "26px",
      "--notif-text-align": "center",
      "--notif-justify": "center",
      "--notif-gap": "10px",
    },
  },
];

const NOTIF_PREFIX = "--notif-";

function numberFromVar(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : def;
}

export function NotifBannerPage({ draft, onDraftChange, onApply, onNotice }: NotifBannerPageProps) {
  const [scene, setScene] = useState<Scene>("single");
  const [dark, setDark] = useState(false);
  const [replay, setReplay] = useState(0);

  const vars = draft.cssOverrides;

  function writeVars(patch: Record<string, string | null>) {
    const nextOverrides = { ...draft.cssOverrides };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") delete nextOverrides[key];
      else nextOverrides[key] = value;
    }
    const next = { ...draft, cssOverrides: nextOverrides };
    onDraftChange(next);
    void onApply(next);
    setReplay(n => n + 1);
  }

  function applyPreset(preset: { name: string; vars: Record<string, string> }) {
    const nextOverrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(draft.cssOverrides)) {
      if (!key.startsWith(NOTIF_PREFIX)) nextOverrides[key] = value;
    }
    Object.assign(nextOverrides, preset.vars);
    const next = { ...draft, cssOverrides: nextOverrides };
    onDraftChange(next);
    void onApply(next);
    setReplay(n => n + 1);
    onNotice(preset.name === "默认" ? "通知横幅已恢复默认" : `通知横幅已套用「${preset.name}」`);
  }

  // 预览壳自己带一份变量：还没点保存的值也照样能看到效果
  const previewStyle: CSSProperties = {};
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith(NOTIF_PREFIX)) (previewStyle as Record<string, string>)[key] = value;
  }

  const sceneData = scene === "call" ? null : SCENE_DATA[scene];

  return (
    <div className="theme-section-page" data-bottom-reserve style={{ gap: 14 }}>
      <p className="ts-13 text-[var(--c-text)] leading-relaxed">
        改的是全局的通知横幅，新消息和来电两种都跟着变（各自的默认长相不同，改过的项才共用）。改完立刻生效，预览用的是横幅真身的样式；想写更细的规则去「CSS 变量」页，选择器是 <code>[data-notif-kind=&quot;message&quot;]</code> 和 <code>[data-notif-kind=&quot;call&quot;]</code>。
      </p>

      {/* 预览台 */}
      <div
        className="notif-preview-stage"
        data-color-scheme={dark ? "dark" : "light"}
        style={{
          ...previewStyle,
          position: "relative",
          height: 210,
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid var(--c-border)",
          background: dark
            ? "linear-gradient(160deg, #1f2430 0%, #11141b 100%)"
            : "linear-gradient(160deg, #dfe6f2 0%, #f6f7fb 100%)",
        }}
      >
        {scene === "call" ? (
          <div key={`call-${replay}`} className="incoming-call-bar" data-notif-kind="call" data-call-type="voice" data-group="0">
            <div className="incoming-call-bar-info">
              <span className="incoming-call-bar-avatar incoming-call-bar-avatar-fallback">林</span>
              <div className="incoming-call-bar-text">
                <span className="incoming-call-bar-name">林林</span>
                <span className="incoming-call-bar-type">语音通话</span>
              </div>
            </div>
            <div className="incoming-call-bar-actions">
              <span className="incoming-call-bar-btn incoming-call-bar-decline" aria-hidden>✕</span>
              <span className="incoming-call-bar-btn incoming-call-bar-accept" aria-hidden>✆</span>
            </div>
          </div>
        ) : (
          <div
            key={`${scene}-${replay}`}
            className="chat-message-notice-bar"
            data-notif-kind="message"
            data-group={sceneData?.group ? "1" : "0"}
            style={{ cursor: "default" }}
          >
            <div className="chat-message-notice-info">
              <span className="chat-message-notice-avatar chat-message-notice-avatar-fallback">
                {sceneData?.title[0] || "消"}
              </span>
              <div className="chat-message-notice-text">
                <span className="chat-message-notice-name">{sceneData?.title}</span>
                <span className="chat-message-notice-body">{sceneData?.body}</span>
              </div>
            </div>
            <span className="chat-message-notice-action">查看</span>
          </div>
        )}
      </div>

      {/* 场景切换 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {SCENES.map(item => (
          <button
            key={item.id}
            type="button"
            className={scene === item.id ? "ui-btn ui-btn-soft-action" : "ui-btn ui-btn-outline"}
            style={{ padding: "3px 12px", fontSize: "calc(12px*var(--app-text-scale,1))" }}
            onClick={() => { setScene(item.id); setReplay(n => n + 1); }}
          >
            {item.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ui-btn ui-btn-outline"
          style={{ padding: "3px 12px", fontSize: "calc(12px*var(--app-text-scale,1))" }}
          onClick={() => setDark(v => !v)}
        >
          {dark ? "深色" : "浅色"}
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-outline"
          style={{ padding: "3px 12px", fontSize: "calc(12px*var(--app-text-scale,1))" }}
          onClick={() => setReplay(n => n + 1)}
        >
          ▶ 重播
        </button>
      </div>

      {/* 预设 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {PRESETS.map(preset => (
          <button
            key={preset.name}
            type="button"
            className="ui-btn ui-btn-outline"
            style={{ padding: "3px 12px", fontSize: "calc(12px*var(--app-text-scale,1))" }}
            onClick={() => applyPreset(preset)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* 逐项调 */}
      {CONTROLS.map(group => (
        <section key={group.group} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h4 className="ts-13" style={{ margin: 0, color: "var(--c-text-title)", fontWeight: 600 }}>{group.group}</h4>
          {group.items.map(control => control.kind === "select" ? (
            <label key={control.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span className="ts-13" style={{ color: "var(--c-text)" }}>{control.label}</span>
              <select
                className="ui-select"
                style={{ width: "auto", minWidth: 150 }}
                value={vars[control.key] || ""}
                onChange={e => writeVars({ [control.key]: e.target.value || null })}
              >
                {control.options.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : (
            <div key={control.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="ts-13" style={{ color: "var(--c-text)" }}>{control.label}</span>
                <span className="ts-13" style={{ color: "var(--c-text-title)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {numberFromVar(vars[control.key], control.def)}{control.unit}
                  {vars[control.key] ? "" : " · 默认"}
                </span>
              </div>
              <input
                type="range"
                className="ui-slider"
                data-ui="slider"
                min={control.min}
                max={control.max}
                step={control.step}
                value={numberFromVar(vars[control.key], control.def)}
                onChange={e => writeVars({ [control.key]: `${e.target.value}${control.unit}` })}
              />
              {control.hint && <p className="ts-11" style={{ margin: 0, color: "var(--c-icon)", lineHeight: 1.4 }}>{control.hint}</p>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
