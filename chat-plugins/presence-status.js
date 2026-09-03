// 在线状态 · 聊天插件（apiVersion 1）
// 像 QQ 那样：聊天列表头像上一个点 + 聊天页名字下面一句话。
// 数据：变量池（scope character）presence（挂念写的此刻快照）/ presenceOverride（本插件面板锁定的）；
// 作息（睡眠窗 + 今天忙时段）是挂念用 chat.setReplyGate 留在宿主的，这里按当前时间实时算，挂念不开也准时变色。
export default {
  manifest: {
    id: "presence-status",
    name: "在线状态",
    apiVersion: 1,
    version: "1.0.0",
    author: "自制",
    description: "聊天列表头像上的点 + 聊天页名字下的一行小字：在线 / 忙碌 / 睡觉中 / 离开 / 隐身。装了挂念就按TA的作息实时变，点那行字可以手动锁定。",
    permissions: ["chat.read", "ui"],
    settings: [
      { key: "showDoing", label: "在线时把「正在做什么」写在名字下", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const LABELS = { online: "在线", busy: "忙碌", sleep: "睡觉中", away: "离开", hidden: "隐身" };
    const STATES = [["", "自动"], ["online", "在线"], ["busy", "忙碌"], ["sleep", "睡觉"], ["away", "离开"], ["hidden", "隐身"]];
    const STALE_MS = 6 * 3600000;
    const ONLINE = { state: "online", label: "" };

    ctx.ui.injectCSS(`
      .pst-dot { position:absolute; bottom:0; right:0; width:8px; height:8px; border-radius:50%; background:#2dd36f; border:1px solid var(--c-page-body-bg); }
      .pst-dot[data-state="busy"], .pst-line[data-state="busy"] i { background:#f5a524; }
      .pst-dot[data-state="sleep"], .pst-line[data-state="sleep"] i { background:#8e949b; }
      .pst-dot[data-state="away"], .pst-line[data-state="away"] i { background:#c9ced4; }
      .pst-dot[data-state="hidden"] { display:none; }
      .pst-line { display:flex; align-items:center; justify-content:center; gap:4px; margin-top:1px; font-size:calc(10.5px * var(--app-text-scale, 1)); font-weight:400; letter-spacing:0; line-height:1.2; color:var(--c-icon); cursor:pointer; }
      .pst-line i { width:6px; height:6px; border-radius:50%; background:#2dd36f; }
      .page-title:has(.pst-line) { line-height:1.15; }
      .pst-sheet { padding:16px; min-width:240px; }
      .pst-sheet h4 { margin:0 0 10px; font-size:14px; }
      .pst-chips { display:flex; flex-wrap:wrap; gap:8px; }
      .pst-chip { border:1px solid var(--c-border, #e2e5ea); border-radius:999px; padding:5px 12px; font-size:13px; background:transparent; color:inherit; }
      .pst-chip.on { background:var(--c-action-blue, #246bfd); color:#fff; border-color:transparent; }
      .pst-now { margin-top:12px; font-size:12px; color:var(--c-icon); }
    `);

    const hm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const asState = (v) => (v in LABELS ? v : null);
    const str = (v) => String(v == null ? "" : v).trim();

    function liveFromGate(cid, now) {
      const gate = ctx.data.replyGate.get(cid);
      if (!gate) return null;
      const cur = hm(now);
      const s = gate.sleep;
      if (s && s.bed !== s.wake) {
        const asleep = s.bed > s.wake ? (cur >= s.bed || cur < s.wake) : (cur >= s.bed && cur < s.wake);
        if (asleep) return { state: "sleep", label: LABELS.sleep };
      }
      const b = gate.busy;
      if (b && b.date === ymd(now)) {
        const win = (b.windows || []).find((w) => cur >= w.from && cur < w.to);
        if (win) return { state: "busy", label: win.title ? LABELS.busy + " · " + win.title : LABELS.busy };
      }
      return { state: "online", label: "" };
    }

    function presenceOf(cid, ignoreOverride) {
      if (!cid) return ONLINE;
      const ov = ignoreOverride ? null : ctx.data.variables.get("presenceOverride", "character", cid);
      if (ov && typeof ov === "object" && asState(ov.state)) {
        const label = str(ov.label);
        return { state: ov.state, label: label || (ov.state === "online" ? "" : LABELS[ov.state]) };
      }
      const showDoing = ctx.system.settings.get("showDoing") !== false;
      const pr = ctx.data.variables.get("presence", "character", cid);
      const p = pr && typeof pr === "object" ? pr : null;
      const nowMs = Date.now();
      const at = p ? Number(p.at) || 0 : 0;
      const fresh = !!p && (!at || nowMs - at <= STALE_MS);
      const live = liveFromGate(cid, new Date(nowMs));
      if (live) {
        if (live.state === "online" && fresh && p) {
          const custom = str(p.label), doing = str(p.doing);
          return { state: "online", label: custom || (showDoing && doing && !p.asleep ? doing : "") };
        }
        return live;
      }
      if (!p) return ONLINE;
      if (!fresh) return { state: "away", label: LABELS.away };
      const state = asState(p.state) || (p.asleep ? "sleep" : p.busy ? "busy" : "online");
      const custom = str(p.label), doing = showDoing ? str(p.doing) : "";
      if (state === "online") return { state, label: custom || doing };
      return { state, label: custom || (doing ? LABELS[state] + " · " + doing : LABELS[state]) };
    }

    // 所有挂着的坑位统一重画：变量池有写入、每分钟到点（「离开」按快照年龄算，没人写也会变）、设置改了
    const painters = new Set();
    const repaintAll = () => { for (const fn of painters) { try { fn(); } catch (e) { ctx.system.log("repaint", e && e.message); } } };
    ctx.hooks.on("variables.changed", (p) => { if (p.name === "presence" || p.name === "presenceOverride") repaintAll(); });
    ctx.system.settings.onChange(repaintAll);
    ctx.system.timers.setInterval(repaintAll, 60000);
    const track = (fn) => { painters.add(fn); fn(); return () => painters.delete(fn); };

    ctx.ui.slot("list.avatar", (el, props) => {
      const cid = props.characterId;
      if (!cid) return;
      const dot = document.createElement("span");
      dot.className = "pst-dot";
      el.appendChild(dot);
      return track(() => { dot.dataset.state = presenceOf(cid).state; });
    });

    ctx.ui.slot("chat.presence", (el, props) => {
      const cid = props.characterId;
      if (!cid) return;
      const line = document.createElement("span");
      line.className = "pst-line";
      line.title = "点一下手动锁定状态";
      line.addEventListener("click", (e) => { e.stopPropagation(); openPanel(cid); });
      el.appendChild(line);
      return track(() => {
        const p = presenceOf(cid);
        line.hidden = p.state === "hidden";
        line.dataset.state = p.state;
        line.innerHTML = "<i></i> " + esc(p.label || LABELS.online);
      });
    });

    function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

    function openPanel(cid) {
      const ch = ctx.data.characters.get(cid);
      ctx.ui.openModal((el, api) => {
        const paint = () => {
          const ov = ctx.data.variables.get("presenceOverride", "character", cid);
          const cur = ov && typeof ov === "object" && asState(ov.state) ? ov.state : "";
          const auto = presenceOf(cid, true);
          el.innerHTML = `<div class="pst-sheet"><h4>${esc(ch ? ch.name : "")}的在线状态</h4>
            <div class="pst-chips">${STATES.map(([v, l]) => `<button class="pst-chip ${v === cur ? "on" : ""}" data-pres="${v}">${l}</button>`).join("")}</div>
            <div class="pst-now">自动判定：${esc(auto.label || LABELS[auto.state])}${cur ? "（已锁定为「" + LABELS[cur] + "」）" : ""}</div></div>`;
          el.querySelectorAll("[data-pres]").forEach((b) => b.addEventListener("click", () => {
            const v = b.getAttribute("data-pres");
            if (v) ctx.data.variables.set("presenceOverride", { state: v, at: Date.now() }, "character", cid);
            else ctx.data.variables.unset("presenceOverride", "character", cid);
            paint();
          }));
        };
        paint();
        return () => {};
      });
    }
  },
};
