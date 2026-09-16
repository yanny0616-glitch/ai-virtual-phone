// ── 主题：四套整体布局不同的壳；字号整体偏小，只给一档「标准」放大 ──
const THEMES = [
  { id: "magazine", name: "杂志", desc: "衬线标题 · 编辑排版", pv: "pv-mag" },
  { id: "sticky", name: "便签墙", desc: "彩色便签 · 手账感", pv: "pv-stk" },
  { id: "terminal", name: "终端", desc: "等宽 · 暗色 · 扫描线", pv: "pv-trm" },
  { id: "script", name: "剧本", desc: "场次 · 台词缩进", pv: "pv-scr" },
];
const LINE_HEIGHTS = { tight: 1.45, mid: 1.55, loose: 1.7 };
const theme = {
  apply() {
    const s = state.settings; const app = $("app");
    app.dataset.theme = THEMES.some(t => t.id === s.theme) ? s.theme : "magazine";
    app.style.setProperty("--fs-scale", String(Number(s.fontScale) || 1));
    app.style.setProperty("--lh", String(LINE_HEIGHTS[s.lineHeight] || 1.55));
    app.dataset.motion = s.motion === false ? "off" : "on";
    const d = new Date();
    $("hdr-date").textContent = `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, "0")} · ${String(d.getDate()).padStart(2, "0")}`;
    $("hdr-no").textContent = `No. ${String(Math.max(1, Number(s.issueNo) || 1)).padStart(3, "0")}`;
  },
};
