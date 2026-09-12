// ── 主题：夜航（day/night 自动对）、暖烛、灰雾 ──
const theme = (() => {
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function resolve() {
    const s = state.settings;
    if (s.theme === "candle" || s.theme === "mist") return s.theme;
    const by = s.autoBy || "system";
    if (by === "day") return "day";
    if (by === "night") return "night";
    if (by === "time") { const h = new Date().getHours(); return h >= 7 && h < 19 ? "day" : "night"; }
    return mq && !mq.matches ? "day" : "night";
  }
  function apply() { const name = resolve(); $("app").dataset.theme = name; emit("theme", name); }
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
  setInterval(() => { if (state.settings && state.settings.theme === "auto" && state.settings.autoBy === "time") apply(); }, 60000);
  return { apply, resolve };
})();
