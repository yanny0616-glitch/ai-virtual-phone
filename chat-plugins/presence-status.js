// 在线状态 · 聊天插件（apiVersion 1）
// 像 QQ 那样：聊天列表头像上一个点 + 聊天页名字下面一句话。
// 数据：变量池（scope character）presence（挂念写的此刻快照）/ presenceOverride（本插件面板锁定的）；
// 作息（睡眠窗 + 今天忙时段）是挂念用 chat.setReplyGate 留在宿主的，这里按当前时间实时算，挂念不开也准时变色。
// 装了忙碌回复（1.2+）：固定作息 › 今天的例外 › 挂念日程由它合起来算（bus availability.query），这里只管显示；
// 固定作息（变量 routine）在这个面板里编辑，例外经 bus routine.exception 交给它记。
export default {
  manifest: {
    id: "presence-status",
    name: "在线状态",
    apiVersion: 1,
    version: "1.1.0",
    author: "自制",
    description: "聊天列表头像上的点 + 聊天页名字下的一行小字：在线 / 分神 / 忙碌 / 睡觉中 / 离开 / 隐身。按固定作息、今天的例外和挂念日程实时变；点那行字可以手动锁定、编辑固定作息。",
    permissions: ["chat.read", "ui"],
    settings: [
      { key: "showDoing", label: "在线时把「正在做什么」写在名字下", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const LABELS = { online: "在线", distracted: "分神", busy: "忙碌", sleep: "睡觉中", away: "离开", hidden: "隐身" };
    const STATES = [["", "自动"], ["online", "在线"], ["distracted", "分神"], ["busy", "忙碌"], ["sleep", "睡觉"], ["away", "离开"], ["hidden", "隐身"]];
    const KINDS = [["sleep", "睡觉"], ["focus", "专注"], ["busy", "忙"], ["distracted", "分神"]];
    const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
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
      .pst-dot[data-state="distracted"], .pst-line[data-state="distracted"] i { background:var(--c-page-body-bg, #fff); box-shadow:inset 0 0 0 2px #2dd36f; }
      .pst-sheet { padding:14px 16px 16px; width:min(340px, 86vw); max-height:72vh; overflow-y:auto; font-size:12px; color:var(--c-text); }
      .pst-sheet h4 { margin:0 0 10px; font-size:14px; font-weight:600; color:var(--c-text-title, var(--c-text)); }
      .pst-states { display:grid; grid-template-columns:repeat(7, 1fr); gap:4px; }
      .pst-states .pst-chip { padding:4px 0; text-align:center; font-size:11.5px; }
      .pst-chips { display:flex; flex-wrap:wrap; gap:6px; }
      .pst-chip { border:1px solid var(--c-card-border, #e2e5ea); border-radius:999px; padding:4px 10px; font-size:12px; line-height:1.3; background:transparent; color:inherit; }
      .pst-chip.on { background:var(--c-action-blue, #246bfd); color:#fff; border-color:transparent; }
      .pst-chip.sm { padding:3px 8px; font-size:11px; }
      .pst-now { margin-top:10px; font-size:11.5px; color:var(--c-text-secondary, var(--c-icon)); }
      .pst-sec { margin-top:16px; }
      .pst-head { display:flex; align-items:baseline; gap:8px; margin-bottom:6px; }
      .pst-head b { font-size:12.5px; font-weight:600; }
      .pst-head span { font-size:10.5px; color:var(--c-text-secondary, var(--c-icon)); }
      .pst-link { margin-left:auto; border:0; background:none; padding:0; font-size:11.5px; color:var(--c-action-blue, #246bfd); }
      .pst-list { list-style:none; margin:0; padding:0; border:1px solid var(--c-card-border, rgba(127,127,127,.18)); border-radius:10px; background:var(--c-card, transparent); overflow:hidden; }
      .pst-list > li { display:grid; grid-template-columns:78px 1fr auto; align-items:center; gap:1px 8px; padding:8px 10px; border-top:1px solid var(--c-card-border, rgba(127,127,127,.15)); cursor:pointer; }
      .pst-list > li:first-child { border-top:0; }
      .pst-list time { font-size:12px; font-variant-numeric:tabular-nums; letter-spacing:-.2px; }
      .pst-list .t { font-size:12px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pst-list .d { grid-column:2; font-size:10.5px; color:var(--c-text-secondary, var(--c-icon)); }
      .pst-k { grid-row:1 / span 2; grid-column:3; font-style:normal; font-size:10.5px; padding:1px 7px; border-radius:999px; background:rgba(245,165,36,.16); color:#b7791f; }
      .pst-k[data-k="sleep"] { background:rgba(142,148,155,.18); color:#6b7178; }
      .pst-k[data-k="focus"] { background:rgba(229,72,77,.12); color:#d4393e; }
      .pst-k[data-k="distracted"] { background:rgba(45,211,111,.14); color:#1f9d55; }
      .pst-add { display:block; width:100%; margin-top:6px; border:1px dashed var(--c-card-border, #d6d9de); border-radius:10px; padding:6px; background:none; font-size:11.5px; color:var(--c-text-secondary, var(--c-icon)); }
      .pst-list > li.pst-edit { display:flex; flex-direction:column; align-items:stretch; gap:8px; cursor:default; background:color-mix(in srgb, var(--c-action-blue, #246bfd) 5%, transparent); }
      .pst-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .pst-in { flex:1; min-width:0; border:1px solid var(--c-input-border, #d6d9de); border-radius:7px; padding:5px 8px; font-size:12px; background:var(--c-page-body-bg, #fff); color:inherit; }
      .pst-in[type="time"] { flex:0 0 auto; width:104px; padding:4px 6px; font-variant-numeric:tabular-nums; }
      .pst-lab { font-size:10.5px; color:var(--c-text-secondary, var(--c-icon)); width:100%; }
      .pst-acts { display:flex; gap:8px; justify-content:flex-end; }
      .pst-btn { border:0; border-radius:7px; padding:5px 12px; font-size:12px; background:color-mix(in srgb, var(--c-text, #000) 7%, transparent); color:inherit; }
      .pst-btn.pri { background:var(--c-action-blue, #246bfd); color:#fff; }
      .pst-btn.del { margin-right:auto; background:none; color:#d4393e; padding-left:0; }
      .pst-ex > li { grid-template-columns:1fr auto; cursor:default; }
      .pst-ex b { font-size:12px; font-weight:500; }
      .pst-ex small { grid-column:1; font-size:10.5px; color:var(--c-text-secondary, var(--c-icon)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .pst-x { grid-row:1 / span 2; grid-column:2; border:0; background:none; font-size:15px; line-height:1; padding:2px 4px; color:var(--c-text-secondary, var(--c-icon)); }
      .pst-empty { margin:0; padding:9px 10px; font-size:11px; color:var(--c-text-secondary, var(--c-icon)); }
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

    function availability(cid, nowMs) {
      if (!ctx.system.bus) return null;
      const q = { characterId: cid, nowMs };
      ctx.system.bus.emit("availability.query", q);
      return q.result && typeof q.result === "object" ? q.result : null;
    }
    const ask = (topic, data) => { if (!ctx.system.bus) return undefined; const q = { ...data }; ctx.system.bus.emit(topic, q); return q.result; };

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
      const q = availability(cid, nowMs);
      if (q && (q.state !== "online" || q.label)) return { state: asState(q.state) || "online", label: q.label };
      if (q && q.authoritative) return { state: "online", label: fresh && showDoing && p && !p.asleep ? str(p.doing) : "" };
      if (p && p.managedBy === "guanian-host" && fresh) {
        const state = asState(p.state) || "away";
        return { state, label: str(p.label) || (state === "online" ? (showDoing ? str(p.doing) : "") : LABELS[state] + (state === "busy" && showDoing && p.doing ? " · " + str(p.doing) : "")) };
      }
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
    ctx.hooks.on("session.opened", () => window.dispatchEvent(new Event("guanian-presence-refresh")));
    const WATCHED = ["presence", "presenceOverride", "routine", "routineExceptions"];
    ctx.hooks.on("variables.changed", (p) => { if (WATCHED.includes(p.name)) repaintAll(); });
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

    const hmOf = (ms) => hm(new Date(ms));
    const daysText = (days) => {
      const d = [...new Set((days || []).filter((x) => x >= 0 && x <= 6))].sort();
      if (!d.length || d.length === 7) return "每天";
      if (d.join() === "1,2,3,4,5") return "周一至周五";
      if (d.join() === "0,6") return "周末";
      return d.map((x) => "周" + WEEK[x]).join(" ");
    };
    const routineOf = (cid) => {
      const v = ctx.data.variables.get("routine", "character", cid);
      return v && Array.isArray(v.items) ? v.items.filter((x) => x && typeof x === "object") : [];
    };
    const exceptionsOf = (cid) => {
      const v = ctx.data.variables.get("routineExceptions", "character", cid);
      const now = Date.now();
      return v && Array.isArray(v.items) ? v.items.filter((x) => x && Number(x.until) > now) : [];
    };
    const kindName = (k) => (KINDS.find((x) => x[0] === k) || KINDS[2])[1];

    function openPanel(cid) {
      const ch = ctx.data.characters.get(cid);
      let draft = null;      // 正在编辑的一段固定作息
      let exForm = null;     // 手动加例外：{ target, at } 或 { add: { title, from, to, kind } }
      ctx.ui.openModal((el) => {
        const hasPolicy = () => ask("availability.query", { characterId: cid, nowMs: Date.now() }) !== undefined;
        const syncDraft = () => {
          el.querySelectorAll("[data-f]").forEach((input) => {
            const f = input.getAttribute("data-f");
            if (draft && f in draft) draft[f] = input.value;
            else if (exForm && exForm.add && f.startsWith("add.")) exForm.add[f.slice(4)] = input.value;
            else if (exForm && f === "exat") exForm.at = input.value;
          });
        };
        const editRow = () => `<li class="pst-edit">
            <input class="pst-in" data-f="title" placeholder="做什么，比如 上课" maxlength="20" value="${esc(draft.title)}">
            <div class="pst-row"><input class="pst-in" type="time" data-f="from" value="${esc(draft.from)}"> – <input class="pst-in" type="time" data-f="to" value="${esc(draft.to)}"></div>
            <div class="pst-row"><span class="pst-lab">星期几（都不选就是每天）</span>${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="pst-chip sm ${draft.days.includes(d) ? "on" : ""}" data-day="${d}">${WEEK[d]}</button>`).join("")}</div>
            <div class="pst-row"><span class="pst-lab">算作</span>${KINDS.map(([k, l]) => `<button class="pst-chip sm ${draft.kind === k ? "on" : ""}" data-kind="${k}">${l}</button>`).join("")}</div>
            <div class="pst-acts">${draft.id ? '<button class="pst-btn del" data-act="rt-del">删除</button>' : ""}<button class="pst-btn" data-act="rt-cancel">取消</button><button class="pst-btn pri" data-act="rt-save">完成</button></div>
          </li>`;
        const exFormHtml = () => {
          const agenda = ask("routine.agenda", { characterId: cid }) || [];
          const t = exForm.target;
          let body = `<div class="pst-row"><span class="pst-lab">改哪一段</span>${agenda.map((o, i) => `<button class="pst-chip sm ${t && t.from === o.from && t.title === o.title ? "on" : ""}" data-pick="${i}">${esc((o.from >= new Date().setHours(24, 0, 0, 0) ? "明天 " : "") + hmOf(o.from) + " " + o.title)}</button>`).join("")}<button class="pst-chip sm ${exForm.add ? "on" : ""}" data-pick="add">临时加一段</button></div>`;
          if (t) body += `<div class="pst-row"><button class="pst-btn" data-act="ex-skip">这次不做了</button></div>
            <div class="pst-row"><span class="pst-lab" style="width:auto">或推迟到</span><input class="pst-in" type="time" data-f="exat" value="${esc(exForm.at || "")}"><button class="pst-btn pri" data-act="ex-shift">推迟</button></div>`;
          if (exForm.add) body += `<input class="pst-in" data-f="add.title" placeholder="做什么" maxlength="20" value="${esc(exForm.add.title)}">
            <div class="pst-row"><input class="pst-in" type="time" data-f="add.from" value="${esc(exForm.add.from)}"> – <input class="pst-in" type="time" data-f="add.to" value="${esc(exForm.add.to)}">${KINDS.map(([k, l]) => `<button class="pst-chip sm ${exForm.add.kind === k ? "on" : ""}" data-addkind="${k}">${l}</button>`).join("")}</div>
            <div class="pst-acts"><button class="pst-btn" data-act="ex-cancel">取消</button><button class="pst-btn pri" data-act="ex-add">加上</button></div>`;
          else body += `<div class="pst-acts"><button class="pst-btn" data-act="ex-cancel">取消</button></div>`;
          return `<li class="pst-edit">${body}</li>`;
        };
        const paint = () => {
          const ov = ctx.data.variables.get("presenceOverride", "character", cid);
          const cur = ov && typeof ov === "object" && asState(ov.state) ? ov.state : "";
          const auto = presenceOf(cid, true);
          const q = availability(cid, Date.now());
          const policy = hasPolicy();
          const items = routineOf(cid).slice().sort((a, b) => String(a.from).localeCompare(String(b.from)));
          const exs = exceptionsOf(cid).sort((a, b) => (a.maskFrom ?? a.from) - (b.maskFrom ?? b.from));
          const rows = items.map((it) => draft && draft.id === it.id ? editRow() : `<li data-rt="${esc(it.id)}"><time>${esc(it.from)}–${esc(it.to)}</time><span class="t">${esc(it.title || kindName(it.kind))}</span><em class="pst-k" data-k="${esc(it.kind)}">${kindName(it.kind)}</em><span class="d">${daysText(it.days)}</span></li>`);
          if (draft && !draft.id) rows.push(editRow());
          const exRows = exs.map((x) => `<li><b>${esc(x.label || x.title)}</b><button class="pst-x" data-ex="${esc(x.id)}" aria-label="撤销">×</button><small>${esc(x.via || "")} · ${hmOf(x.at)}${x.quote ? "「" + esc(x.quote) + "」" : ""}</small></li>`);
          if (exForm) exRows.push(exFormHtml());
          el.innerHTML = `<div class="pst-sheet"><h4>${esc(ch ? ch.name : "")}的在线状态</h4>
            <div class="pst-states">${STATES.map(([v, l]) => `<button class="pst-chip ${v === cur ? "on" : ""}" data-pres="${v}">${l}</button>`).join("")}</div>
            <div class="pst-now">自动判定：${esc(auto.label || LABELS[auto.state])}${q && q.origin && (q.state !== "online" || q.label) ? "（来自" + esc(q.origin) + "）" : ""}${cur ? " · 已锁定为「" + LABELS[cur] + "」" : ""}</div>
            <div class="pst-sec"><div class="pst-head"><b>固定作息</b><span>${policy ? "没装挂念也按这个判断" : "装上「忙碌回复」插件后才会按这个延后回复"}</span></div>
              ${rows.length ? `<ul class="pst-list">${rows.join("")}</ul>` : ""}
              ${draft ? "" : '<button class="pst-add" data-act="rt-new">＋ 加一段</button>'}</div>
            ${policy ? `<div class="pst-sec"><div class="pst-head"><b>今天的例外</b><span>只管当天</span>${exForm ? "" : '<button class="pst-link" data-act="ex-new">＋ 手动加</button>'}</div>
              <ul class="pst-list pst-ex">${exRows.join("") || '<li style="display:block;cursor:default"><p class="pst-empty">剧情里改了安排（熬夜陪你、翘课）会记在这里，第二天回到固定作息</p></li>'}</ul></div>` : ""}
          </div>`;
        };
        const saveRoutine = (list) => ctx.data.variables.set("routine", { items: list, updatedAt: Date.now() }, "character", cid);
        const onClick = (e) => {
          const b = e.target.closest("button, li[data-rt]");
          if (!b || !el.contains(b)) return;
          syncDraft();
          const act = b.getAttribute("data-act");
          if (b.hasAttribute("data-pres")) {
            const v = b.getAttribute("data-pres");
            if (v) ctx.data.variables.set("presenceOverride", { state: v, at: Date.now() }, "character", cid);
            else ctx.data.variables.unset("presenceOverride", "character", cid);
          } else if (b.hasAttribute("data-rt")) {
            if (draft) return;
            const it = routineOf(cid).find((x) => x.id === b.getAttribute("data-rt"));
            if (it) draft = { id: it.id, title: it.title || "", from: it.from, to: it.to, days: Array.isArray(it.days) ? [...it.days] : [], kind: it.kind };
          } else if (b.hasAttribute("data-day")) {
            const d = Number(b.getAttribute("data-day"));
            draft.days = draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d];
          } else if (b.hasAttribute("data-kind")) draft.kind = b.getAttribute("data-kind");
          else if (act === "rt-new") draft = { id: "", title: "", from: "09:00", to: "11:00", days: [], kind: "busy" };
          else if (act === "rt-cancel") draft = null;
          else if (act === "rt-del") { saveRoutine(routineOf(cid).filter((x) => x.id !== draft.id)); draft = null; }
          else if (act === "rt-save") {
            if (!/^\d{2}:\d{2}$/.test(draft.from) || !/^\d{2}:\d{2}$/.test(draft.to) || draft.from === draft.to) { ctx.ui.toast("开始和结束时间要不一样"); return; }
            const item = { id: draft.id || "rt" + Date.now().toString(36), title: draft.title.trim().slice(0, 20), from: draft.from, to: draft.to, days: draft.days.slice().sort(), kind: draft.kind };
            const list = routineOf(cid);
            const idx = list.findIndex((x) => x.id === item.id);
            if (idx >= 0) list[idx] = item; else list.push(item);
            saveRoutine(list); draft = null;
          } else if (b.hasAttribute("data-ex")) {
            const id = b.getAttribute("data-ex");
            const v = ctx.data.variables.get("routineExceptions", "character", cid);
            ctx.data.variables.set("routineExceptions", { items: (v && Array.isArray(v.items) ? v.items : []).filter((x) => x && x.id !== id) }, "character", cid);
          } else if (act === "ex-new") exForm = {};
          else if (act === "ex-cancel") exForm = null;
          else if (b.hasAttribute("data-pick")) {
            const i = b.getAttribute("data-pick");
            if (i === "add") exForm = { add: { title: "", from: hm(new Date()), to: hm(new Date(Date.now() + 3600000)), kind: "busy" } };
            else exForm = { target: (ask("routine.agenda", { characterId: cid }) || [])[Number(i)], at: "" };
          } else if (b.hasAttribute("data-addkind")) exForm.add.kind = b.getAttribute("data-addkind");
          else if (act === "ex-skip" || act === "ex-shift") {
            if (act === "ex-shift" && !/^\d{2}:\d{2}$/.test(exForm.at || "")) { ctx.ui.toast("先选推迟到几点"); return; }
            const r = ask("routine.exception", { characterId: cid, op: act === "ex-skip" ? "取消" : "推迟", arg: act === "ex-shift" ? "|" + exForm.at : "", target: exForm.target });
            if (!r) { ctx.ui.toast(act === "ex-shift" ? "推迟的时间要在原来之后" : "没改成"); return; }
            exForm = null;
          } else if (act === "ex-add") {
            const a = exForm.add;
            const r = ask("routine.exception", { characterId: cid, op: "加", arg: `${a.from}-${a.to}|${a.title.trim() || kindName(a.kind)}|${kindName(a.kind)}` });
            if (!r) { ctx.ui.toast("时间没填对"); return; }
            exForm = null;
          } else return;
          paint();
        };
        el.addEventListener("click", onClick);
        paint();
        return () => el.removeEventListener("click", onClick);
      });
    }
  },
};
