// 约见面：你约TA、TA也会约你；定好时间地点，到点叫你，去赴约就切进线下，散场留一句回执。
// 宿主只给钩子（卡片、会话动作、到点唤醒、聊天信息里的一栏），规则都在这里。
const DAY = 86400000;
const WEEK = "日一二三四五六";
const pad = (n) => String(n).padStart(2, "0");
const hm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const abs = (ms) => {
  if (!ms) return "现在";
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日（周${WEEK[d.getDay()]}）${hm(ms)}`;
};

// 时间写法：9月20日 19:00 / 2026-09-20 19:00 / 明天 19:30 / 今晚7点半 / 下周五 19:00 / 19:00 / 现在
function parseWhen(raw, nowMs) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^(现在|马上|立刻|这就)/.test(s)) return nowMs;
  const now = new Date(nowMs);
  const t = s.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2}|半)?/);
  if (!t) return null;
  const before = s.slice(0, t.index);
  let hh = Number(t[1]);
  const mm = t[2] === "半" ? 30 : t[2] ? Number(t[2]) : 0;
  if (/下午|傍晚|晚|夜/.test(before) && hh < 12) hh += 12;
  if (/中午/.test(before) && hh < 6) hh += 12;
  if (hh > 23 || mm > 59) return null;
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const full = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  const md = !full && s.match(/(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*[日号]?/);
  const wk = s.match(/(下个?|这个?|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  let base, rollDays = 0;
  if (full) base = new Date(+full[1], +full[2] - 1, +full[3]);
  else if (md) {
    base = new Date(now.getFullYear(), +md[1] - 1, +md[2]);
    if (base.getTime() < today0 - 30 * DAY) base.setFullYear(base.getFullYear() + 1);
  } else if (wk) {
    const target = WEEK.indexOf(wk[2] === "天" ? "日" : wk[2]);
    let add;
    if (wk[1] && wk[1].startsWith("下")) add = (((8 - now.getDay()) % 7) || 7) + (target + 6) % 7;
    else { add = (target - now.getDay() + 7) % 7; rollDays = 7; }
    base = new Date(today0); base.setDate(base.getDate() + add);
  } else {
    const off = /后天/.test(s) ? 2 : /明/.test(s) ? 1 : 0;
    if (!/今|明|后天/.test(s)) rollDays = 1;
    base = new Date(today0); base.setDate(base.getDate() + off);
  }
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm).getTime();
  if (!Number.isFinite(at)) return null;
  return rollDays && at < nowMs - 10 * 60000 ? at + rollDays * DAY : at;
}

// 回复里的标记：[约见答应] [约见推掉] [约见改时间:明天 20:00] [约见:时间|地点|想做什么]
const DIRECTIVE_RE = /[ \t]*\[约见(答应|推掉|改时间)?(?:[:：]([^\]\n]*))?\][ \t]*\n?/g;
function takeDirectives(text) {
  const found = [];
  const clean = String(text).replace(DIRECTIVE_RE, (_, kind, arg) => {
    found.push({ kind: kind === "答应" ? "accept" : kind === "推掉" ? "decline" : kind === "改时间" ? "retime" : "invite", arg: (arg || "").trim() });
    return "";
  });
  return { text: found.length ? clean.replace(/\n{3,}/g, "\n\n").trim() : text, found };
}

const ICON = {
  cal: (s = 12, w = 2) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/></svg>`,
  pin: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
  spark: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
};

const CSS = `
.mt-card{--mt-accent:var(--c-bubble-self,#5b7cfa);--mt-paper:var(--c-bubble-other,#fff);--mt-ink:var(--c-text-title,#1d1d1f);--mt-sub:var(--c-text,#797e85);--mt-serif:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",serif;width:246px;max-width:100%;display:flex;flex-direction:column;gap:3px;text-align:left;-webkit-tap-highlight-color:transparent}
.mt-card svg{flex:none}
/* 卡片自带底色：宿主气泡只留定位，去掉底色和内边距（同宿主的 .chat-bubble-media） */
:is(.chat-bubble-role-user,.chat-bubble-role-assistant):has(> [data-chat-plugin-kind="meetup"]){background:transparent!important;padding:0!important;box-shadow:none!important;border:none!important;overflow:visible!important}
.mt-body{position:relative;display:grid;grid-template-columns:1fr 64px;border-radius:14px;overflow:hidden;background:var(--mt-paper);cursor:pointer}
.mt-card[data-style="ticket"] .mt-body{--notch:calc(100% - 64px);-webkit-mask:radial-gradient(circle at var(--notch) 0,transparent 6px,#000 6.5px) top/100% 51% no-repeat,radial-gradient(circle at var(--notch) 100%,transparent 6px,#000 6.5px) bottom/100% 51% no-repeat;mask:radial-gradient(circle at var(--notch) 0,transparent 6px,#000 6.5px) top/100% 51% no-repeat,radial-gradient(circle at var(--notch) 100%,transparent 6px,#000 6.5px) bottom/100% 51% no-repeat}
.mt-main{padding:11px 12px 11px 13px;min-width:0;background:linear-gradient(160deg,color-mix(in srgb,var(--mt-accent) 9%,var(--mt-paper)) 0%,var(--mt-paper) 60%)}
.mt-kind{display:flex;align-items:center;gap:5px;font-size:calc(10px*var(--app-text-scale,1));font-weight:600;letter-spacing:.08em;color:var(--mt-accent)}
.mt-pill{margin-left:auto;font-style:normal;letter-spacing:0;font-size:calc(9.5px*var(--app-text-scale,1));padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--mt-accent) 12%,transparent)}
.mt-when{display:flex;align-items:baseline;gap:7px;margin:4px 0 5px}
.mt-when b{font-size:calc(24px*var(--app-text-scale,1));line-height:1;font-weight:700;letter-spacing:-.03em;color:var(--mt-ink);font-variant-numeric:tabular-nums}
.mt-was{font-size:calc(11px*var(--app-text-scale,1));color:var(--mt-sub);opacity:.65;font-variant-numeric:tabular-nums}
.mt-day{font-size:calc(11px*var(--app-text-scale,1));color:var(--mt-sub)}
.mt-row{display:flex;align-items:center;gap:5px;font-size:calc(11px*var(--app-text-scale,1));line-height:1.6;color:var(--mt-ink);min-width:0}
.mt-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-row svg{color:var(--mt-accent);opacity:.8}
.mt-plan{color:var(--mt-sub)}
.mt-note{margin-top:6px;font-size:calc(9.5px*var(--app-text-scale,1));color:var(--mt-accent)}
.mt-card:is([data-state="done"],[data-state="declined"],[data-state="cancelled"]) .mt-note{color:var(--mt-sub)}
.mt-stub{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;background:var(--mt-accent);color:#fff;border-left:2px dashed color-mix(in srgb,#fff 55%,var(--mt-accent))}
.mt-stub-m,.mt-stub-w{font-size:calc(9.5px*var(--app-text-scale,1));opacity:.85;letter-spacing:.04em}
.mt-stub-d{font-size:calc(24px*var(--app-text-scale,1));line-height:1.05;font-weight:700;font-variant-numeric:tabular-nums}
.mt-card[data-state="done"] .mt-stub > :not(.mt-stamp){visibility:hidden}
.mt-card[data-state="done"] .mt-stub{background:color-mix(in srgb,var(--mt-sub) 22%,var(--mt-paper));color:var(--mt-ink);border-left-color:var(--mt-paper)}
.mt-card:is([data-state="declined"],[data-state="cancelled"]) .mt-body{opacity:.62}
.mt-card:is([data-state="declined"],[data-state="cancelled"]) .mt-stub{background:color-mix(in srgb,var(--mt-sub) 30%,var(--mt-paper));color:var(--mt-ink)}
.mt-card:is([data-state="declined"],[data-state="cancelled"]) .mt-when b{text-decoration:line-through;text-decoration-thickness:1.5px}
.mt-stamp{position:absolute;inset:50% auto auto 50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:1.5px solid var(--mt-accent);color:var(--mt-accent);background:color-mix(in srgb,var(--mt-paper) 70%,transparent);display:grid;place-items:center;font-style:normal;font-size:calc(10px*var(--app-text-scale,1));font-weight:700;letter-spacing:.05em;transform:rotate(-14deg);box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--mt-paper) 70%,transparent),inset 0 0 0 4px color-mix(in srgb,var(--mt-accent) 60%,transparent)}
.mt-bar{display:flex;border-radius:12px;overflow:hidden;background:var(--mt-paper)}
.mt-bar button{flex:1;border:none;background:none;padding:8px 0;font-size:calc(11.5px*var(--app-text-scale,1));color:var(--mt-sub);font-weight:500;cursor:pointer}
.mt-bar button+button{border-left:1px solid color-mix(in srgb,var(--mt-sub) 14%,transparent)}
.mt-bar button[data-primary]{color:var(--mt-accent);font-weight:700}
.mt-card[data-state="due"] .mt-bar{background:var(--mt-accent)}
.mt-card[data-state="due"] .mt-bar button{color:#fff}
.mt-receipt{border-radius:12px;background:var(--mt-paper);padding:8px 12px;font-size:calc(10.5px*var(--app-text-scale,1));line-height:1.6;color:var(--mt-ink)}
.mt-receipt em{display:block;font-style:normal;font-size:calc(9.5px*var(--app-text-scale,1));color:var(--mt-sub);margin-bottom:1px}

.mt-card[data-style="simple"] .mt-body{display:flex;flex-direction:column;box-shadow:0 1px 0 color-mix(in srgb,var(--mt-sub) 6%,transparent),0 6px 18px -10px color-mix(in srgb,var(--mt-sub) 35%,transparent)}
.mt-card[data-style="simple"] .mt-main{background:none}
.mt-card[data-style="simple"][data-state] .mt-stub{flex-direction:row;justify-content:flex-start;align-items:center;gap:0;padding:7px 13px 9px;background:none;color:var(--mt-sub);border:none;border-top:1px dashed color-mix(in srgb,var(--mt-sub) 30%,transparent)}
.mt-card[data-style="simple"][data-state] .mt-stub > *{visibility:visible;opacity:1;font-size:calc(10px*var(--app-text-scale,1));font-weight:500;line-height:1.4;letter-spacing:0}
.mt-card[data-style="simple"] .mt-stub-d::after{content:"日"}
.mt-card[data-style="simple"] .mt-stub-w{margin-left:5px}
.mt-card[data-style="simple"] .mt-stub .mt-stamp{position:static;margin:0 0 0 auto;width:auto;height:auto;padding:1px 7px;border:none;border-radius:999px;box-shadow:none;transform:none;background:color-mix(in srgb,var(--mt-accent) 12%,transparent);color:var(--mt-accent);font-weight:600}

.mt-card[data-style="letter"]{--mt-paper:color-mix(in srgb,#f1e3c2 38%,var(--c-bubble-other,#fff));--mt-seal:#b8453a}
.mt-card[data-style="letter"] .mt-body{display:flex;flex-direction:column;border-radius:3px;background:var(--mt-paper);box-shadow:0 1px 2px color-mix(in srgb,var(--mt-ink) 12%,transparent),0 8px 20px -12px color-mix(in srgb,var(--mt-ink) 40%,transparent)}
.mt-card[data-style="letter"] :is(.mt-when,.mt-row,.mt-note){border-bottom:1px solid color-mix(in srgb,var(--mt-accent) 13%,transparent)}
.mt-card[data-style="letter"] .mt-main{background:none;padding:12px 15px 4px;font-family:var(--mt-serif)}
.mt-card[data-style="letter"] .mt-kind{color:var(--mt-sub);letter-spacing:.24em;font-weight:500}
.mt-card[data-style="letter"] .mt-kind svg{display:none}
.mt-card[data-style="letter"] .mt-pill{background:none;border:1px solid color-mix(in srgb,var(--mt-sub) 35%,transparent);color:var(--mt-sub);letter-spacing:0}
.mt-card[data-style="letter"] .mt-when{margin:6px 0 0}
.mt-card[data-style="letter"] .mt-when b{font-weight:600;letter-spacing:0;line-height:22px}
.mt-card[data-style="letter"] .mt-row{line-height:22px}
.mt-card[data-style="letter"] .mt-row svg{display:none}
.mt-card[data-style="letter"] .mt-note{margin-top:0;line-height:22px}
.mt-card[data-style="letter"][data-state] .mt-stub{position:static;flex-direction:row;justify-content:flex-end;align-items:baseline;gap:0;padding:2px 15px 10px;background:none;color:var(--mt-sub);border:none;font-family:var(--mt-serif)}
.mt-card[data-style="letter"][data-state] .mt-stub > *{visibility:visible;opacity:1;font-size:calc(10.5px*var(--app-text-scale,1));font-weight:400;line-height:1.4;letter-spacing:.04em}
.mt-card[data-style="letter"] .mt-stub::before{content:"——";margin-right:6px;opacity:.45}
.mt-card[data-style="letter"] .mt-stub-d::after{content:"日"}
.mt-card[data-style="letter"] .mt-stub-w{margin-left:6px}
.mt-card[data-style="letter"] .mt-stub .mt-stamp{inset:auto 14px 26px auto;margin:0;width:42px;height:42px;border-radius:5px;border-color:var(--mt-seal);color:var(--mt-seal);background:none;font-family:var(--mt-serif);font-size:calc(11px*var(--app-text-scale,1));box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--mt-seal) 22%,transparent);transform:rotate(-8deg)}
.mt-card[data-style="letter"] .mt-bar,.mt-card[data-style="letter"] .mt-receipt{border-radius:3px}
.mt-card[data-style="letter"] .mt-receipt{font-family:var(--mt-serif)}
.mt-card[data-style="letter"][data-state="due"] .mt-bar{background:var(--mt-seal)}

.mt-sheet{--mt-accent:var(--c-bubble-self,#5b7cfa);width:292px;max-width:100%;border-radius:18px;background:var(--c-bubble-other,#fff);color:var(--c-text-title,#1d1d1f);padding:16px 16px 14px;display:flex;flex-direction:column;gap:13px;text-align:left;box-shadow:0 12px 40px rgba(0,0,0,.28)}
.mt-sheet-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.mt-sheet-title{font-size:calc(14px*var(--app-text-scale,1));font-weight:700}
.mt-sheet-sub{font-size:calc(10.5px*var(--app-text-scale,1));color:var(--c-text,#797e85);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-field{display:flex;flex-direction:column;gap:6px}
.mt-label{font-size:calc(10.5px*var(--app-text-scale,1));color:var(--c-text,#797e85)}
.mt-label i{font-style:normal;opacity:.7;margin-left:4px}
.mt-chips{display:flex;gap:6px}
.mt-chip{flex:1;border:none;border-radius:9px;padding:7px 0;font-size:calc(11.5px*var(--app-text-scale,1));font-weight:600;background:color-mix(in srgb,var(--c-text,#797e85) 10%,transparent);color:var(--c-text,#797e85);cursor:pointer}
.mt-chip[data-on]{background:color-mix(in srgb,var(--mt-accent) 14%,transparent);color:var(--mt-accent)}
.mt-time{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:8px 12px;border-radius:11px;background:color-mix(in srgb,var(--c-text,#797e85) 7%,transparent)}
.mt-time span{font-size:calc(11px*var(--app-text-scale,1));color:var(--c-text,#797e85)}
.mt-time b{font-size:calc(22px*var(--app-text-scale,1));font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.mt-time input{flex:1;min-width:0;border:none;background:none;color:var(--c-text-title,#1d1d1f);font:inherit;font-size:calc(14px*var(--app-text-scale,1));font-weight:600;text-align:right;padding:4px 0}
.mt-sheet input.ui-input{width:100%;font-size:calc(12px*var(--app-text-scale,1))}
.mt-send{border:none;border-radius:11px;padding:10px 0;font-size:calc(13px*var(--app-text-scale,1));font-weight:700;background:var(--mt-accent);color:#fff;margin-top:2px;cursor:pointer}
.mt-send:disabled{opacity:.5}
.mt-hint{text-align:center;font-size:calc(9.5px*var(--app-text-scale,1));color:var(--c-text,#797e85);margin-top:-5px}
.mt-err{font-size:calc(10px*var(--app-text-scale,1));color:var(--c-danger,#e5484d);margin-top:-6px}
.mt-acts{display:flex;flex-direction:column;gap:6px}
.mt-acts button{border:none;border-radius:11px;padding:10px 0;font-size:calc(12.5px*var(--app-text-scale,1));font-weight:600;background:color-mix(in srgb,var(--c-text,#797e85) 10%,transparent);color:var(--c-text-title,#1d1d1f);cursor:pointer}
.mt-acts button[data-primary]{background:var(--mt-accent);color:#fff}
.mt-acts button[data-danger]{color:var(--c-danger,#e5484d)}

.mt-strip{display:flex;align-items:center;gap:8px;margin:6px 12px 0;padding:6px 6px 6px 12px;border-radius:12px;background:color-mix(in srgb,var(--c-bubble-self,#5b7cfa) 9%,var(--c-page-body-bg,#fff));border:1px solid color-mix(in srgb,var(--c-bubble-self,#5b7cfa) 18%,transparent)}
.mt-strip-k{flex:none;font-size:calc(9.5px*var(--app-text-scale,1));letter-spacing:.08em;color:var(--c-bubble-self,#5b7cfa);font-weight:600}
.mt-strip-v{flex:1;min-width:0;font-size:calc(11px*var(--app-text-scale,1));color:var(--c-text-title,#1d1d1f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-strip-v b{font-variant-numeric:tabular-nums}
.mt-strip button{flex:none;border:none;border-radius:999px;padding:4px 12px;font-size:calc(11px*var(--app-text-scale,1));font-weight:600;background:var(--c-bubble-self,#5b7cfa);color:#fff;cursor:pointer}

.mt-set{padding:2px 24px 10px 32px}
.mt-crow{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;border-top:1px solid color-mix(in srgb,var(--c-text,#797e85) 12%,transparent);font-size:calc(12px*var(--app-text-scale,1));color:var(--c-text-title,#1d1d1f)}
.mt-crow:first-child{border-top:none}
.mt-crow > span:first-child{flex:none}
.mt-seg{display:inline-flex;padding:2px;border-radius:8px;background:color-mix(in srgb,var(--c-text,#797e85) 11%,transparent)}
.mt-seg button{border:none;background:none;font-size:calc(10.5px*var(--app-text-scale,1));padding:3px 8px;border-radius:6px;color:var(--c-text,#797e85);cursor:pointer;white-space:nowrap}
.mt-seg button[data-on]{background:var(--c-bubble-other,#fff);color:var(--c-text-title,#1d1d1f);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--c-text-title,#1d1d1f) 14%,transparent)}
.mt-stepper{display:flex;align-items:center;gap:8px}
.mt-stepper button{width:22px;height:22px;border:none;border-radius:7px;background:color-mix(in srgb,var(--c-text,#797e85) 12%,transparent);color:var(--c-text-title,#1d1d1f);font-size:13px;line-height:1;cursor:pointer}
.mt-stepper b{min-width:14px;text-align:center;font-size:calc(12px*var(--app-text-scale,1));font-variant-numeric:tabular-nums}
.mt-stepper span{font-size:calc(10.5px*var(--app-text-scale,1));color:var(--c-text,#797e85);margin-left:-4px}
.mt-sw{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}
.mt-sw input{position:absolute;opacity:0;width:0;height:0}
.mt-sw i{position:absolute;inset:0;border-radius:999px;background:color-mix(in srgb,var(--c-text,#797e85) 25%,transparent);transition:background .2s}
.mt-sw i::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s}
.mt-sw input:checked + i{background:var(--c-bubble-self,#5b7cfa)}
.mt-sw input:checked + i::after{transform:translateX(16px)}
.mt-sw input:focus-visible + i{outline:2px solid var(--c-bubble-self,#5b7cfa);outline-offset:2px}
.mt-cfoot{margin:6px 0 2px;font-size:calc(9.5px*var(--app-text-scale,1));color:var(--c-text,#797e85);line-height:1.5}
@media (prefers-reduced-motion:reduce){.mt-sw i,.mt-sw i::after{transition:none}}
`;

const DEFAULTS = { arriveMode: "push", leadMinutes: 0, rescheduleByBusy: true, proactive: "sometimes", cooldownDays: 3, declineCooldownDays: 3 };
const CHAR_KEYS = Object.keys(DEFAULTS);
const LIVE = ["pending", "retime", "ask", "agreed", "met"];

const meetupPlugin = {
  manifest: {
    id: "meetup",
    name: "约见面",
    apiVersion: 1,
    version: "1.0.0",
    author: "Float",
    description: "你约TA，或TA看聊天自己约你：定好时间地点，TA会看自己那时的日程决定答应、改时间或推掉。到点推送叫你，去赴约自动切进线下，散场留一句回执。卡片有票根、简约、信笺三种样式，每个角色可以单独设。",
    permissions: ["chat.read", "chat.write", "storage", "ai"],
    settings: [
      { key: "arriveMode", label: "到点叫你", type: "select", default: "push", options: [{ value: "push", label: "推送（App 关着也叫）" }, { value: "card", label: "只把卡片变成「去赴约」" }, { value: "none", label: "不叫" }] },
      { key: "leadMinutes", label: "提前几分钟叫", type: "number", default: 0 },
      { key: "rescheduleByBusy", label: "TA 看日程改时间", type: "boolean", default: true, description: "那时有事，TA 会提一个别的时间；关掉就只答应或推掉。" },
      { key: "proactive", label: "TA 主动约你", type: "select", default: "sometimes", options: [{ value: "off", label: "关" }, { value: "sometimes", label: "偶尔" }, { value: "often", label: "常常" }] },
      { key: "cooldownDays", label: "TA 最多几天约一次", type: "number", default: 3 },
      { key: "declineCooldownDays", label: "你推掉后几天不再约", type: "number", default: 3 },
      { key: "cardStyle", label: "卡片样式", type: "select", default: "ticket", options: [{ value: "ticket", label: "票根" }, { value: "simple", label: "简约" }, { value: "letter", label: "信笺" }], description: "类名都以 mt- 开头（mt-card、mt-when、mt-stub…），可在聊天信息 → 外观 → 自定义 CSS 里改。" },
    ],
  },
  helpers: { parseWhen, takeDirectives },
  setup(ctx) {
    const store = ctx.system.storage;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const clampNum = (v, lo, hi, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb; };
    const normalize = (c) => ({
      arriveMode: ["push", "card", "none"].includes(c.arriveMode) ? c.arriveMode : "push",
      leadMinutes: clampNum(c.leadMinutes, 0, 180, 0),
      rescheduleByBusy: c.rescheduleByBusy !== false,
      proactive: ["off", "sometimes", "often"].includes(c.proactive) ? c.proactive : "sometimes",
      cooldownDays: clampNum(c.cooldownDays, 0, 60, 3),
      declineCooldownDays: clampNum(c.declineCooldownDays, 0, 60, 3),
    });
    const globalCfg = () => {
      const s = ctx.system.settings.all();
      const out = { ...DEFAULTS };
      for (const k of CHAR_KEYS) if (s[k] !== undefined && s[k] !== null && s[k] !== "") out[k] = s[k];
      return normalize(out);
    };
    const ownCfg = (cid) => store.get("char:" + cid);
    const cfgFor = (cid) => { const own = ownCfg(cid); return own && own.override ? normalize({ ...globalCfg(), ...own }) : globalCfg(); };
    const cardStyle = () => { const v = ctx.system.settings.get("cardStyle"); return ["ticket", "simple", "letter"].includes(v) ? v : "ticket"; };
    const charName = (cid) => ctx.data.characters.get(cid)?.name || "TA";

    // ── 存取：约见本体存插件 storage，卡片消息的 mediaData 是它的副本 ──
    const load = (id) => store.get("mt:" + id);
    const activeOf = (sid) => {
      const id = store.get("active:" + sid);
      const m = id && load(id);
      return m && LIVE.includes(m.state) ? m : null;
    };
    const cardText = (m) => {
      const status = {
        pending: "待答复", retime: "改期待定：" + abs(m.proposed), ask: "待答复",
        agreed: m.originalWhen ? "已约定（从 " + hm(m.originalWhen) + " 改过来的）" : "已约定",
        met: "见面中", done: m.receipt ? "已见面：" + m.receipt : "已见面", declined: "没去成", cancelled: "已取消",
      }[m.state] || "";
      if (m.from === "char") return `[约见:${abs(m.when)}|${m.place || ""}|${m.plan || ""}]（${status}）`;
      return `[约见邀请] ${abs(m.when)}${m.place ? " · " + m.place : ""}${m.plan ? " · " + m.plan : ""}（${status}）`;
    };
    const painters = new Set();
    const repaintAll = () => { for (const p of [...painters]) { try { p(); } catch { /* 卡片已卸载 */ } } };
    function save(m) {
      store.set("mt:" + m.id, m);
      if (LIVE.includes(m.state)) store.set("active:" + m.sessionId, m.id);
      else if (store.get("active:" + m.sessionId) === m.id) store.remove("active:" + m.sessionId);
      if (m.msgId) ctx.data.messages.update(m.msgId, { content: cardText(m), mediaData: { meetup: m } });
      repaintAll();
    }
    function pushCard(m, role) {
      const msg = ctx.data.messages.push({ sessionId: m.sessionId, role, content: cardText(m), mediaType: "plugin:meetup", mediaData: { meetup: m } });
      m.msgId = msg.id;
      save(m);
    }
    const newId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── 到点：复用宿主的定时唤醒，App 关着走离线推送 ──
    async function arm(m, { quiet } = {}) {
      ctx.chat.cancelWake(m.id);
      const cfg = cfgFor(m.characterId);
      if (m.state !== "agreed" || cfg.arriveMode !== "push" || !m.when) return;
      const at = m.when - cfg.leadMinutes * 60000;
      if (at < Date.now() + 60000 || at > Date.now() + 7 * DAY) return;
      const intent = `你们约好${abs(m.when)}${m.place ? "在" + m.place : ""}见面${m.plan ? "（" + m.plan + "）" : ""}。`
        + (cfg.leadMinutes ? `还有 ${cfg.leadMinutes} 分钟就到时间了，` : "时间到了，")
        + "按你的性格给对方发消息：说你到了、在路上，或者催对方出门。已经约定好了，别再问要不要见。";
      try {
        const r = await ctx.chat.scheduleWake({ characterId: m.characterId, fireAt: at, intent, key: m.id });
        m.armed = true;
        store.set("mt:" + m.id, m);
        if (!r.armed && !quiet) ctx.ui.toast("离线推送没开：App 关着时到点叫不到你", { durationMs: 3600 });
      } catch (e) { ctx.system.log("到点提醒没排上：" + (e && e.message || e)); }
    }
    const isDue = (m, cfg) => m.state === "agreed" && cfg.arriveMode !== "none" && (!m.when || Date.now() >= m.when - cfg.leadMinutes * 60000);

    // ── 你这边的动作 ──
    function setState(m, state, patch = {}) {
      Object.assign(m, patch, { state, updatedAt: Date.now() });
      save(m);
      if (state !== "agreed") ctx.chat.cancelWake(m.id);
    }
    function goMeet(m) {
      setState(m, "met", { startedAt: Date.now() });
      ctx.chat.offline.set(m.sessionId, true);
    }
    async function leave(m) {
      setState(m, "done", { endedAt: Date.now() });
      ctx.chat.offline.set(m.sessionId, false);
      const turns = ctx.chat.offline.turns(m.sessionId).filter((t) => Date.parse(t.createdAt) >= (m.startedAt || 0) - 1000);
      if (!turns.length) return;
      const name = charName(m.characterId);
      const story = turns.slice(-8).map((t) => t.summary || `${t.userContent}\n${t.assistantContent}`).join("\n").slice(-3000);
      const t = ctx.ui.toast("在记这次见面…", { durationMs: 0 });
      try {
        const out = await ctx.ai.chat({
          system: "你替人记下一次见面，只输出一句话。",
          prompt: `下面是${name}和“你”一次见面的线下剧情。用一句话（40 字以内）记下这次见面里最值得记住的事：称呼对方用“你”，称呼${name}用名字，不加引号、不评价。\n\n${story}`,
          temperature: 0.5, maxTokens: 120,
        });
        const receipt = String(out || "").replace(/\s+/g, " ").replace(/^["“「『]+|["”」』]+$/g, "").trim().slice(0, 60);
        if (receipt) setState(load(m.id) || m, "done", { receipt });
      } catch (e) { ctx.system.log("回执没写成：" + (e && e.message || e)); }
      finally { t.close(); }
    }
    function noteDecline(cid) { const cd = store.get("cd:" + cid) || {}; store.set("cd:" + cid, { ...cd, lastDeclined: Date.now() }); }

    function sheet(mount) {
      return ctx.ui.openModal((el, api) => {
        // 宿主容器只当透明壳，让 .mt-sheet 直接由遮罩居中
        el.style.cssText = "display:contents";
        return mount(el, api);
      });
    }
    function openInvite(sessionId, prefill) {
      const session = ctx.data.sessions.get(sessionId);
      if (!session || session.isGroup) { ctx.ui.toast("约见面只在单聊里用"); return; }
      const live = activeOf(sessionId);
      if (live && !(prefill && prefill.replaces === live.id)) { ctx.ui.toast(live.state === "met" ? "你们正在见面" : "已经有一个约了：点卡片可以取消"); return; }
      const cid = session.contactId;
      const tonight = () => {
        const d = new Date(); const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 30).getTime();
        if (at > Date.now() + 30 * 60000) return at;
        return Math.ceil((Date.now() + 45 * 60000) / (15 * 60000)) * 15 * 60000;
      };
      let mode = prefill ? "pick" : "tonight";
      let at = prefill && prefill.when && prefill.when > Date.now() ? prefill.when : tonight();
      const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const dayLabel = (ms) => { const d = new Date(ms); const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / DAY); return (diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : `${d.getMonth() + 1}月${d.getDate()}日`) + " 周" + WEEK[d.getDay()]; };
      sheet((el, api) => {
        let place = prefill?.place || "", plan = prefill?.plan || "", err = "";
        const paint = () => {
          const timeBox = mode === "now" ? `<div class="mt-time"><span>见面就现在</span><b>现在</b></div>`
            : mode === "pick" ? `<label class="mt-time"><span>挑个时间</span><input type="datetime-local" id="mt-when" value="${local(at)}"></label>`
            : `<div class="mt-time"><span>${dayLabel(at)}</span><b>${hm(at)}</b></div>`;
          el.innerHTML = `<div class="mt-sheet" role="dialog" aria-label="约见面">
            <div class="mt-sheet-head"><span class="mt-sheet-title">${prefill ? "换个时间" : "约见面"}</span><span class="mt-sheet-sub">约 ${esc(charName(cid))}</span></div>
            <div class="mt-field"><div class="mt-label">什么时候</div>
              <div class="mt-chips">${[["now", "现在"], ["tonight", "今晚"], ["pick", "挑个时间"]].map(([v, l]) => `<button type="button" class="mt-chip" data-mode="${v}"${mode === v ? " data-on" : ""}>${l}</button>`).join("")}</div>
              ${timeBox}</div>
            <div class="mt-field"><label class="mt-label" for="mt-place">在哪<i>可不填</i></label><input class="ui-input" id="mt-place" maxlength="40" placeholder="比如：老街那家火锅" value="${esc(place)}"></div>
            <div class="mt-field"><label class="mt-label" for="mt-plan">想做什么<i>可不填</i></label><input class="ui-input" id="mt-plan" maxlength="60" placeholder="比如：吃完去江边走走" value="${esc(plan)}"></div>
            ${err ? `<div class="mt-err">${esc(err)}</div>` : ""}
            <button type="button" class="mt-send">约 TA</button>
            <div class="mt-hint">TA 会看自己那时有没有空，再回你</div>
          </div>`;
          el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
            place = el.querySelector("#mt-place").value; plan = el.querySelector("#mt-plan").value;
            mode = b.getAttribute("data-mode"); if (mode === "tonight") at = tonight(); err = ""; paint();
          }));
          const input = el.querySelector("#mt-when");
          if (input) input.addEventListener("change", () => {
            const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(input.value);
            if (m) at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
          });
          el.querySelector(".mt-send").addEventListener("click", () => {
            const when = mode === "now" ? null : at;
            if (when && when < Date.now() - 5 * 60000) { err = "这个时间已经过了"; place = el.querySelector("#mt-place").value; plan = el.querySelector("#mt-plan").value; paint(); return; }
            if (prefill && prefill.replaces) { const old = load(prefill.replaces); if (old) setState(old, "cancelled", { note: "你提了别的时间" }); }
            const m = {
              id: newId(), from: "user", sessionId, characterId: cid, when,
              place: el.querySelector("#mt-place").value.trim().slice(0, 40), plan: el.querySelector("#mt-plan").value.trim().slice(0, 60),
              state: "pending", createdAt: Date.now(),
            };
            pushCard(m, "user");
            api.close();
            ctx.chat.requestReply(sessionId);
          });
        };
        paint();
      });
    }
    function openActions(m) {
      const cfg = cfgFor(m.characterId);
      const acts = [];
      if (m.state === "agreed") acts.push(["go", isDue(m, cfg) ? "去赴约" : "现在就去", true]);
      if (m.state === "met") { acts.push(["resume", "回到见面", true]); acts.push(["leave", "散场"]); }
      if (["pending", "agreed", "retime"].includes(m.state)) acts.push(["cancel", m.state === "agreed" ? "取消这次约见" : "取消邀请", false, true]);
      if (!acts.length) return;
      sheet((el, api) => {
        el.innerHTML = `<div class="mt-sheet"><div class="mt-sheet-head"><span class="mt-sheet-title">${m.when ? abs(m.when) : "现在见面"}</span><span class="mt-sheet-sub">${esc(m.place || "")}</span></div>
          <div class="mt-acts">${acts.map(([a, l, p, d]) => `<button type="button" data-a="${a}"${p ? " data-primary" : ""}${d ? " data-danger" : ""}>${l}</button>`).join("")}<button type="button" data-a="close">算了</button></div></div>`;
        el.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
          api.close();
          act(load(m.id) || m, b.getAttribute("data-a"));
        }));
      });
    }
    function act(m, a) {
      if (a === "go") goMeet(m);
      else if (a === "resume") ctx.chat.offline.set(m.sessionId, true);
      else if (a === "leave") void leave(m);
      else if (a === "cancel") setState(m, "cancelled", { note: "你取消了" });
      else if (a === "acceptRetime") { setState(m, "agreed", { originalWhen: m.when, when: m.proposed, proposed: null }); void arm(m); }
      else if (a === "dropRetime") setState(m, "cancelled", { note: "没谈拢时间" });
      else if (a === "accept") { setState(m, "agreed"); void arm(m); ctx.chat.requestReply(m.sessionId); }
      else if (a === "counter") openInvite(m.sessionId, { replaces: m.id, when: m.when, place: m.place, plan: m.plan });
      else if (a === "decline") { setState(m, "declined", { note: "你说下次吧" }); noteDecline(m.characterId); ctx.chat.requestReply(m.sessionId); }
    }

    // ── 卡片 ──
    const PILL = { pending: "等TA回", retime: "TA 想改时间", ask: "等你回", agreed: "约好了", due: "到点了", met: "见面中", done: "散了", declined: "没去成", cancelled: "取消了" };
    function cardHtml(m) {
      const cfg = cfgFor(m.characterId);
      const view = isDue(m, cfg) ? "due" : m.state;
      const bigMs = view === "retime" ? m.proposed : m.when;
      const d = new Date(bigMs || m.startedAt || m.createdAt || Date.now());
      const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / DAY);
      const dayWord = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : dayDiff === 2 ? "后天" : dayDiff > 2 && dayDiff < 7 ? "周" + WEEK[d.getDay()] : "";
      const was = view === "retime" && m.when ? `<s class="mt-was">${hm(m.when)}</s>`
        : m.originalWhen && ["agreed", "due"].includes(view) ? `<s class="mt-was">${hm(m.originalWhen)}</s>`
        : dayWord && bigMs ? `<span class="mt-day">${dayWord}</span>` : "";
      const note = {
        retime: `TA 那时有事，想改到 ${bigMs ? hm(bigMs) : "别的时间"}`,
        agreed: m.originalWhen ? `TA 改到了 ${hm(m.when)} · 你已答应` : m.from === "char" ? "你答应了" : "TA 答应了",
        due: m.when ? "时间到了" : "说走就走",
        met: m.startedAt ? hm(m.startedAt) + " 起 · 见面中" : "见面中",
        done: m.startedAt && m.endedAt ? `${hm(m.startedAt)} – ${hm(m.endedAt)}` : "",
        declined: m.note || (m.from === "char" ? "你说下次吧" : "TA 这次去不了"),
        cancelled: m.note || "",
      }[view] || "";
      const rows = (m.place ? `<div class="mt-row mt-place">${ICON.pin}<span>${esc(m.place)}</span></div>` : "")
        + (m.plan ? `<div class="mt-row mt-plan">${ICON.spark}<span>${esc(m.plan)}</span></div>` : "")
        + (!m.place && !m.plan ? `<div class="mt-row mt-plan">${ICON.pin}<span>地方还没定</span></div>` : "");
      const bar = {
        retime: [["acceptRetime", "就这个时间", 1], ["dropRetime", "算了"]],
        ask: [["accept", "答应", 1], ["counter", "换个时间"], ["decline", "下次吧"]],
        due: [["go", "去赴约", 1]],
        met: [["resume", "回到见面", 1], ["leave", "散场"]],
      }[view];
      return `<div class="mt-card" data-style="${cardStyle()}" data-state="${view}" data-from="${m.from}">
        <div class="mt-body"><div class="mt-main">
          <div class="mt-kind">${ICON.cal()}<span>${m.from === "char" ? "TA 约你" : "约见"}</span><em class="mt-pill">${PILL[view] || ""}</em></div>
          <div class="mt-when"><b>${bigMs ? hm(bigMs) : "现在"}</b>${was}</div>
          ${rows}${note ? `<div class="mt-note">${esc(note)}</div>` : ""}
        </div><div class="mt-stub"><span class="mt-stub-m">${d.getMonth() + 1}月</span><b class="mt-stub-d">${d.getDate()}</b><span class="mt-stub-w">周${WEEK[d.getDay()]}</span>${view === "done" ? '<i class="mt-stamp">已赴约</i>' : ""}</div></div>
        ${bar ? `<div class="mt-bar">${bar.map(([a, l, p]) => `<button type="button" data-a="${a}"${p ? " data-primary" : ""}>${l}</button>`).join("")}</div>` : ""}
        ${view === "done" && m.receipt ? `<div class="mt-receipt"><em>这次见面</em>${esc(m.receipt)}</div>` : ""}
      </div>`;
    }
    ctx.ui.injectCSS(CSS);
    ctx.ui.messageKind("meetup", (el, msg) => {
      const base = msg.mediaData && msg.mediaData.meetup;
      if (!base || !base.id) { el.textContent = msg.content || "[约见]"; return; }
      let stopTimer = null;
      const paint = () => {
        const m = load(base.id) || base;
        el.innerHTML = cardHtml(m);
        el.querySelectorAll("[data-a]").forEach((b) => {
          b.addEventListener("pointerdown", (e) => e.stopPropagation());
          b.addEventListener("click", (e) => { e.stopPropagation(); act(load(base.id) || m, b.getAttribute("data-a")); });
        });
        el.querySelector(".mt-body").addEventListener("click", () => openActions(load(base.id) || m));
        if (stopTimer) { stopTimer(); stopTimer = null; }
        const cfg = cfgFor(m.characterId);
        if (m.state === "agreed" && m.when && !isDue(m, cfg)) {
          const wait = m.when - cfg.leadMinutes * 60000 - Date.now() + 500;
          if (wait < DAY) stopTimer = ctx.system.timers.setTimeout(paint, Math.max(1000, wait));
        }
      };
      painters.add(paint);
      paint();
      return () => { painters.delete(paint); if (stopTimer) stopTimer(); };
    });

    // ── TA 那边：提示词 + 回复里的标记 ──
    function canPropose(cid, cfg) {
      if (cfg.proactive === "off") return false;
      const cd = store.get("cd:" + cid) || {};
      return Date.now() - (cd.lastAsk || 0) >= cfg.cooldownDays * DAY && Date.now() - (cd.lastDeclined || 0) >= cfg.declineCooldownDays * DAY;
    }
    function scheduleNotes(cid, when) {
      const bits = [];
      try {
        const gate = ctx.data.replyGate.get(cid);
        const d = new Date(when || Date.now());
        const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (gate && gate.sleep) bits.push(`你的作息：${gate.sleep.bed} 睡，${gate.sleep.wake} 起`);
        if (gate && gate.busy && gate.busy.date === ymd && gate.busy.windows?.length) bits.push("你那天的安排：" + gate.busy.windows.map((w) => `${w.from}–${w.to} ${w.title || "有事"}`).join("；"));
        const pr = ctx.data.variables.get("presence", "character", cid);
        if (pr && typeof pr === "object" && (pr.doing || pr.asleep)) bits.push("你现在：" + (pr.asleep ? "在睡觉" : pr.doing));
      } catch { /* 没装挂念就没有日程 */ }
      return bits.join("\n");
    }
    const where = (m) => (m.place ? "在" + m.place : "") + (m.plan ? "，" + m.plan : "");
    function promptFor(sid, cid) {
      const m = activeOf(sid);
      if (ctx.chat.offline.get(sid)) {
        if (!m || m.state !== "met") return "";
        const started = ctx.chat.offline.turns(sid).some((t) => Date.parse(t.createdAt) >= (m.startedAt || 0) - 1000);
        return `【这次见面】你和对方约好的见面：${m.when ? abs(m.when) : "说走就走"}${m.place ? "，在" + m.place : ""}${m.plan ? "，想" + m.plan : ""}。`
          + (started ? "继续这次见面的剧情，不要再讨论要不要见面。" : "两人已经见到面了，线下剧情从碰面那一刻写起，按约好的地点和安排展开，不要再讨论要不要见面。");
      }
      const cfg = cfgFor(cid);
      const now = "现在是 " + abs(Date.now()) + "。";
      if (m && m.state === "pending") {
        const notes = cfg.rescheduleByBusy ? scheduleNotes(cid, m.when) : "";
        return [`【约见面】${now}对方约你${m.when ? abs(m.when) : "现在"}见面${where(m) ? "（" + where(m) + "）" : ""}，在等你答复。`,
          "结合你那时的安排、人设和心情决定，正文里自然回应，并在回复最后单独一行写一个标记：",
          "答应写 [约见答应]" + (cfg.rescheduleByBusy ? "；那时有事想换个时间写 [约见改时间:9月20日 19:00]（换成你能去的时间，正文说明原因）" : "") + "；去不了写 [约见推掉]。只写一个标记。",
          notes].filter(Boolean).join("\n");
      }
      if (m && m.state === "retime") return `【约见面】你提议把见面改到${abs(m.proposed)}，在等对方确认，别再改。`;
      if (m && m.state === "ask") return `【约见面】你约了对方${m.when ? abs(m.when) : "现在"}见面${where(m) ? "（" + where(m) + "）" : ""}，对方还没回，别重复约。`;
      if (m && m.state === "agreed") return `【约见面】${now}你们约好了${m.when ? abs(m.when) : "现在"}见面${where(m) ? "（" + where(m) + "）" : ""}。记着这件事，别重复约；真去不了了才在回复最后单独一行写 [约见推掉]，并在正文说明。`;
      if (m && m.state === "met") return "【约见面】你们这次见面还没散场，线上聊天时可以自然提起刚才的事。";
      if (!canPropose(cid, cfg)) return "";
      return [`【约见面】${now}聊到想见面、你记着的日子到了、或者对方难过需要人陪时，你可以主动约对方：正文里自然地说，并在回复最后单独一行写 [约见:时间|地点|想做什么]。`,
        "时间写成「9月20日 19:00」「明天 19:30」这样；地点和想做什么可以空着，竖线要留。",
        cfg.proactive === "often" ? "想见就可以约，不用等特别的理由。" : "一般不主动约，只在真的很想见的时候才约。",
        "不约就不写这个标记。"].join("\n");
    }
    ctx.hooks.transform("prompt.system", (p) => {
      if (p.isGroup || !p.characterId) return p;
      const extra = promptFor(p.sessionId, p.characterId);
      return extra ? { ...p, hint: (p.hint ? p.hint + "\n" : "") + extra } : p;
    });

    // TA 发起的约：等这一轮气泡都出完再把卡片放出来，别插在话前面
    const queued = new Map();
    function queueCard(m, immediate) {
      const q = { m, stop: null };
      const flush = () => { if (queued.get(m.sessionId) !== q) return; queued.delete(m.sessionId); if (q.stop) q.stop(); pushCard(m, "assistant"); };
      q.flush = flush;
      queued.set(m.sessionId, q);
      if (immediate) flush(); else q.stop = ctx.system.timers.setTimeout(flush, 8000);
    }
    ctx.hooks.transform("message.beforeReveal", (p) => {
      const q = queued.get(p.sessionId);
      if (q && p.index === p.total - 1) q.lastBatch = p.responseBatchId;
      return p;
    });
    ctx.hooks.on("message.persisted", ({ message }) => {
      const q = queued.get(message.sessionId);
      if (!q || message.role !== "assistant" || message.mediaType === "plugin:meetup") return;
      if (q.stop) q.stop();
      q.stop = ctx.system.timers.setTimeout(q.flush, q.lastBatch && message.responseBatchId === q.lastBatch ? 400 : 2500);
    });

    ctx.hooks.transform("llm.response", (p) => {
      if (!p.sessionId || typeof p.text !== "string" || !p.text.includes("[约见")) return p;
      const { text, found } = takeDirectives(p.text);
      if (!found.length) return p;
      const session = ctx.data.sessions.get(p.sessionId);
      if (!session || session.isGroup) return { ...p, text };
      const cid = session.contactId;
      const cfg = cfgFor(cid);
      const m = activeOf(session.id);
      for (const { kind, arg } of found) {
        if (kind === "accept" && m && m.from === "user" && m.state === "pending") { setState(m, "agreed"); void arm(m); }
        else if (kind === "decline" && m && ((m.from === "user" && ["pending", "retime"].includes(m.state)) || m.state === "agreed")) {
          setState(m, m.state === "agreed" ? "cancelled" : "declined", { note: m.state === "agreed" ? "TA 说去不了了" : "" });
        } else if (kind === "retime" && m && m.from === "user" && m.state === "pending") {
          const t = parseWhen(arg, Date.now());
          if (!cfg.rescheduleByBusy || !t) { setState(m, "agreed"); void arm(m); }
          else if (Math.abs(t - (m.when || Date.now())) < 60000) { setState(m, "agreed"); void arm(m); }
          else setState(m, "retime", { proposed: t });
        } else if (kind === "invite" && !m && !queued.has(session.id) && canPropose(cid, cfg)) {
          const [w, place, plan] = arg.split(/[|｜]/).map((s) => (s || "").trim());
          const when = parseWhen(w, Date.now());
          if (w && when == null) continue;
          if (when && when < Date.now() - 5 * 60000) continue;
          const cd = store.get("cd:" + cid) || {};
          store.set("cd:" + cid, { ...cd, lastAsk: Date.now() });
          queueCard({ id: newId(), from: "char", sessionId: session.id, characterId: cid, when: when && when > Date.now() + 60000 ? when : null, place: (place || "").slice(0, 40), plan: (plan || "").slice(0, 60), state: "ask", createdAt: Date.now() }, !text);
        }
      }
      return { ...p, text };
    });

    ctx.hooks.on("message.deleted", ({ id, sessionId }) => {
      for (const key of store.keys()) {
        if (!key.startsWith("active:") || (sessionId && key !== "active:" + sessionId)) continue;
        const m = load(store.get(key));
        if (m && m.msgId === id) { ctx.chat.cancelWake(m.id); m.msgId = null; setState(m, "cancelled", { note: "卡片删掉了" }); }
      }
    });
    ctx.hooks.on("session.opened", ({ sessionId, isGroup }) => {
      if (isGroup) return;
      const m = activeOf(sessionId);
      if (m && m.state === "agreed" && !m.armed) void arm(m, { quiet: true });
    });
    ctx.system.settings.onChange(() => repaintAll());

    // ── 入口：「+」面板 ──
    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      if (props.isGroup || !props.sessionId) return;
      const b = document.createElement("div");
      b.className = "chat-plus-menu-item flex flex-col items-center gap-1.5 cursor-pointer";
      b.innerHTML = `<div class="chat-plus-icon-box" style="color:var(--c-text)">${ICON.cal(22, 1.5)}</div><span class="ts-11">约见面</span>`;
      b.onclick = () => openInvite(props.sessionId);
      el.appendChild(b);
    });

    // ── 线下：见面中的一条，散场在这里 ──
    ctx.ui.slot("chat.header", (el, props) => {
      if (props.isGroup || !props.offlineMode || !props.sessionId) return;
      const m = activeOf(props.sessionId);
      if (!m || m.state !== "met") return;
      el.innerHTML = `<div class="mt-strip"><span class="mt-strip-k">这次见面</span><span class="mt-strip-v"><b>${m.when ? hm(m.when) : hm(m.startedAt || Date.now())}</b>${m.place ? " · " + esc(m.place) : ""}${m.plan ? " · " + esc(m.plan) : ""}</span><button type="button">散场</button></div>`;
      el.querySelector("button").addEventListener("click", () => void leave(load(m.id) || m));
    });

    // ── 聊天信息里的一栏：这个角色单独设 ──
    ctx.ui.slot("chatInfo.section", (el, props) => {
      if (props.isGroup || !props.characterId) return;
      const cid = props.characterId;
      const seg = (key, value, opts) => `<span class="mt-seg" role="group">${opts.map(([v, l]) => `<button type="button" data-k="${key}" data-v="${v}"${String(v) === String(value) ? " data-on" : ""}>${l}</button>`).join("")}</span>`;
      const stepper = (key, value) => `<div class="mt-stepper"><button type="button" data-k="${key}" data-step="-1" aria-label="减一天">−</button><b>${value}</b><span>天</span><button type="button" data-k="${key}" data-step="1" aria-label="加一天">+</button></div>`;
      const paint = () => {
        const own = ownCfg(cid);
        const override = !!(own && own.override);
        const cfg = cfgFor(cid);
        const lead = [0, 10, 30].includes(cfg.leadMinutes) ? String(cfg.leadMinutes) : "custom";
        el.dataset.summary = (override ? "单独设 · " : "")
          + { push: "到点推送", card: "到点变卡片", none: "到点不叫" }[cfg.arriveMode] + " · "
          + { off: "TA 不主动约", sometimes: "TA 偶尔主动约你", often: "TA 常常主动约你" }[cfg.proactive];
        el.innerHTML = `<div class="mt-set">
          <div class="mt-crow"><span>这个角色</span>${seg("override", override ? "1" : "0", [["0", "跟随全局"], ["1", "单独设"]])}</div>
          <div class="mt-crow"><span>到点叫你</span>${seg("arriveMode", cfg.arriveMode, [["push", "推送"], ["card", "只变卡片"], ["none", "不叫"]])}</div>
          <div class="mt-crow"><span>提前</span>${seg("leadMinutes", lead, [["0", "准点"], ["10", "10 分"], ["30", "30 分"], ["custom", lead === "custom" ? cfg.leadMinutes + " 分" : "自定"]])}</div>
          <div class="mt-crow"><span>TA 看日程改时间</span><label class="mt-sw"><input type="checkbox" data-k="rescheduleByBusy" aria-label="TA 看日程改时间"${cfg.rescheduleByBusy ? " checked" : ""}><i></i></label></div>
          <div class="mt-crow"><span>TA 主动约你</span>${seg("proactive", cfg.proactive, [["off", "关"], ["sometimes", "偶尔"], ["often", "常常"]])}</div>
          <div class="mt-crow"><span>最多几天约一次</span>${stepper("cooldownDays", cfg.cooldownDays)}</div>
          <div class="mt-crow"><span>推掉后几天不再约</span>${stepper("declineCooldownDays", cfg.declineCooldownDays)}</div>
          <div class="mt-crow"><span>卡片样式</span>${seg("cardStyle", cardStyle(), [["ticket", "票根"], ["simple", "简约"], ["letter", "信笺"]])}</div>
          <p class="mt-cfoot">主动约只在聊到想见、记着的日子到了、你难过时用上。卡片样式对所有角色生效，类名以 mt- 开头，可在「外观 → 自定义 CSS」里改。</p>
        </div>`;
        const write = (key, value) => {
          if (key === "cardStyle") { ctx.system.settings.set("cardStyle", value); return; }
          const cur = ownCfg(cid);
          if (key === "override") {
            store.set("char:" + cid, value === "1" ? { ...(cur && cur.override ? cur : globalCfg()), override: true } : { ...(cur || {}), override: false });
          } else {
            const basis = cur && cur.override ? cur : { ...globalCfg() };
            store.set("char:" + cid, { ...basis, [key]: value, override: true });
          }
          const live = activeOf(props.sessionId);
          if (live && live.state === "agreed") void arm(live, { quiet: true });
          paint(); repaintAll();
        };
        el.querySelectorAll(".mt-seg button").forEach((b) => b.addEventListener("click", () => {
          const key = b.getAttribute("data-k"); let v = b.getAttribute("data-v");
          if (key === "leadMinutes") {
            if (v === "custom") {
              const input = prompt("提前几分钟叫你？（0～180）", String(cfgFor(cid).leadMinutes || 15));
              if (input == null) return;
              v = clampNum(input, 0, 180, 0);
            } else v = Number(v);
          }
          write(key, v);
        }));
        el.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
          const key = b.getAttribute("data-k");
          write(key, clampNum(cfgFor(cid)[key] + Number(b.getAttribute("data-step")), 0, 60, 3));
        }));
        el.querySelector("[data-k=rescheduleByBusy]").addEventListener("change", (e) => write("rescheduleByBusy", e.target.checked));
      };
      paint();
      return ctx.system.settings.onChange(paint);
    });
  },
};

export default meetupPlugin;
