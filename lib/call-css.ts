// 通话美化：用户写的 CSS 只作用在通话界面里（[data-call-screen]），挂断键另有一层保护样式。

export const CALL_CSS_SCOPE = "[data-call-screen]";

export const CALL_CSS_PRESETS: { id: string; name: string; css: string }[] = [
    {
        id: "live",
        name: "直播风",
        css: `/* 直播风：左上角 LIVE 角标，字幕像评论一条条从左下冒出来 */
.call-topbar { align-items: flex-start; text-align: left; padding-left: 18px; }
.call-name::after {
  content: "LIVE"; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
  background: #ff3b5c; color: #fff; font-size: 10px; font-weight: 700;
  letter-spacing: .08em; vertical-align: 2px;
}
.call-subs { justify-content: flex-end; }
.call-sub {
  align-self: flex-start !important; max-width: 80%; text-align: left;
  background: rgba(0, 0, 0, .38); border-radius: 14px; padding: 5px 11px;
  font-size: 13px; line-height: 1.5;
}
.call-sub[data-role="user"] { background: rgba(255, 59, 92, .38); }
.call-sub::before { content: attr(data-name) "："; color: #ffd66b; font-weight: 600; }
.call-sub-narr { color: rgba(255, 255, 255, .62); }
.call-portrait { filter: saturate(1.12) contrast(1.04); }`,
    },
];

/** 通话界面上稳定的 class / 属性，写 CSS 就认这些 */
export const CALL_CSS_HOOKS: [string, string][] = [
    [":root", "整个通话界面（写 :root 会换成通话界面本身）"],
    [".call-scene", "场景背景层"],
    [".call-portrait", "视频里 TA 的立绘（没设就是头像）"],
    [".call-avatar", "语音通话中间的头像"],
    [".call-topbar", "顶部名字和时长"],
    [".call-name / .call-timer", "名字、时长那两行"],
    [".call-subs", "字幕区"],
    [".call-sub[data-role]", "一条字幕；data-role 是 user / assistant，data-name 是说话人"],
    [".call-sub-narr", "字幕里的（旁白）"],
    [".call-controls", "底部按钮区"],
    ["[data-call-hangup]", "挂断键：可以改颜色大小，藏不掉"],
];

export function callCssPresetName(css: string | undefined): string {
    const text = (css || "").trim();
    if (!text) return "默认";
    return CALL_CSS_PRESETS.find(preset => preset.css.trim() === text)?.name ?? "自定义";
}

/** 不管用户 CSS 怎么写，挂断键和它的外层都得看得见、点得到 */
export const CALL_HANGUP_GUARD_CSS = `
${CALL_CSS_SCOPE} [data-call-hangup],
${CALL_CSS_SCOPE} :has(> [data-call-hangup]) {
  visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;
  clip-path: none !important; filter: none !important;
}
${CALL_CSS_SCOPE} [data-call-hangup] { z-index: 2147483000 !important; }`;
