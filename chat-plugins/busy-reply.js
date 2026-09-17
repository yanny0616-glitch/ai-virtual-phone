// 忙碌回复：规则由插件提供；宿主负责计时、云同步、生成与回填。
// 谁说了算：手动状态 › 今天的例外 › 固定作息 › 挂念日程。固定作息（routine）和今天的例外（routineExceptions）
// 放在变量池的角色维度：在线状态面板编辑，挂念排日程时也读。
const busyReplyPlugin = {
  manifest: {
    id: "busy-reply",
    name: "忙碌回复",
    apiVersion: 1,
    version: "1.2.0",
    author: "Float",
    description: "忙时延后、专注时按概率偷空回复，分神时回得快但话短，也允许角色根据情境选择本轮不回。按固定作息、今天的例外和挂念日程判断；你打电话时决定接不接，睡着时连打几通能叫醒。离线执行复用小手机个人云。首次读取时导入旧挂念设置。",
    permissions: ["chat.read", "storage"],
    settings: [
      { key: "enabled", label: "启用忙碌、睡眠和不回复规则", type: "boolean", default: true },
      { key: "allowSilence", label: "允许角色选择不回复", type: "boolean", default: true, description: "结合人设、关系、情绪和上下文选择沉默；不生成气泡、不安排补回，新消息到来后重新判断。仍会调用模型。" },
      { key: "adaptive", label: "根据日程找空档", type: "boolean", default: true },
      { key: "peekMin", label: "偷空等待／检查间隔（分钟）", type: "number", default: 3, description: "0 不等待；按此间隔上下浮动四成，连续发送不会重置计时。" },
      { key: "focusedPeekProb", label: "专注中偷空回复的概率（%）", type: "number", default: 25, description: "每次检查抽一次。0 只等休息或结束，100 首次检查时回；没有细排也适用。" },
      { key: "sleepMode", label: "睡着时收到消息", type: "select", default: "wait", options: [{ value: "wait", label: "醒来后回复" }, { value: "chance", label: "概率醒来回复" }, { value: "ignore", label: "不因睡眠延后" }] },
      { key: "wakeProb", label: "被消息吵醒的概率（%）", type: "number", default: 18 },
      { key: "wakeBufferMin", label: "醒来后再等（分钟）", type: "number", default: 10 },
      { key: "urgentBypass", label: "紧急消息优先回复", type: "boolean", default: true, description: "识别救命、医院、快回等紧急词；已有云端等待须先确认取消。" },
      { key: "manualBusyMin", label: "手动忙碌／睡觉有效期（分钟）", type: "number", default: 60, description: "在「在线状态」里手动设为忙碌、分神或睡觉时使用；从设置该状态的时刻起计算，不因发消息续期。" },
      { key: "distracted", label: "分神时回得快但话短", type: "boolean", default: true, description: "日程里正在做饭、看剧这类「在做但不算忙」的事，或固定作息里标了分神。" },
      { key: "distractedMinSec", label: "分神时最快多久回（秒）", type: "number", default: 30 },
      { key: "distractedMaxSec", label: "分神时最慢多久回（秒）", type: "number", default: 120 },
      { key: "pullCount", label: "连发几条让TA放下手里的事", type: "number", default: 3, description: "0 表示不会被拽走。" },
      { key: "exceptions", label: "剧情可以改今天的作息", type: "boolean", default: true, description: "TA 说「陪你看完再睡」「明早的课翘了」时记成今天的例外，只管当天。关掉就只认固定作息和挂念日程。" },
      { key: "callRingSec", label: "打电话响多久算没人接（秒）", type: "number", default: 20 },
      { key: "callWake1", label: "TA睡着时，第一通叫醒的概率（%）", type: "number", default: 35 },
      { key: "callWake2", label: "连着打第二通叫醒的概率（%）", type: "number", default: 70 },
      { key: "callWake3", label: "第三通及以后叫醒的概率（%）", type: "number", default: 100 },
      { key: "callChainMin", label: "几分钟内再打算「连着打」", type: "number", default: 5 },
      { key: "callBusyAnswer", label: "一般忙时接电话的概率（%）", type: "number", default: 50, description: "和偷空回复分开调。开会、上课这类专注时段会直接拒接。" },
      { key: "callCallback", label: "专注中拒接后，忙完回过来", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    if (ctx.data.replyGate.policyVersion !== 1) throw new Error("请先更新小手机宿主，再启用忙碌回复插件。");
    if (ctx.data.replyGate.silenceVersion !== 1) throw new Error("请先更新小手机宿主，再使用支持不回复的忙碌回复插件。");
    const fields = ["enabled", "adaptive", "peekMin", "focusedPeekProb", "sleepMode", "wakeProb", "wakeBufferMin", "urgentBypass", "manualBusyMin"];
    const num = (key, fallback, lo, hi) => {
      const n = Number(ctx.system.settings.get(key));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };
    const hm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    let observed = JSON.stringify(ctx.system.settings.all());
    function migrate(source) {
      if (ctx.system.storage.get("migrationDone") || !source) return;
      if (JSON.stringify(ctx.system.settings.all()) !== observed) { ctx.system.storage.set("migrationDone", true); return; }
      const old = source.legacyReplySettings || (!source.availabilityOnly ? {
        enabled: true, adaptive: source.busy?.adaptive === true, peekMin: source.busy?.peekMin ?? 3,
        focusedPeekProb: source.busy?.focusedPeekProb ?? 0,
        sleepMode: source.sleep?.mode === 2 ? "chance" : "wait", wakeProb: source.sleep?.wakeProb ?? 18,
        wakeBufferMin: source.sleep?.bufferMin ?? 10,
      } : null);
      if (!old) return;
      ctx.system.storage.set("migrationDone", true);
      for (const key of fields) if (old[key] != null) ctx.system.settings.set(key, old[key]);
      observed = JSON.stringify(ctx.system.settings.all());
    }
    // Import once, before rendering plugin settings. Later APP uploads cannot overwrite edits.
    for (const character of ctx.data.characters.list()) migrate(ctx.data.replyGate.get(character.id));
    ctx.system.settings.onChange(settings => {
      const next = JSON.stringify(settings);
      if (next !== observed) ctx.system.storage.set("migrationDone", true);
      observed = next;
    });
    const on = key => ctx.system.settings.get(key) !== false;
    const sourceOf = cid => typeof ctx.data.replyGate.get === "function" ? ctx.data.replyGate.get(cid) : null;
    const KINDS = ["sleep", "focus", "busy", "distracted"];
    const KIND_NAME = { sleep: "睡觉", focus: "专注", busy: "忙", distracted: "分神" };
    const RANK = { sleep: 0, focus: 1, busy: 2, distracted: 3 };
    const FOCUS_RE = /专注|开会|会议|例会|晨会|周会|月会|上课|课堂|考试|测验|开车|驾驶|手术|面试|汇报|训练|排练|实验|演出|上台/;
    const DISTRACT_RE = /做饭|煮饭|烧饭|炒菜|看剧|追剧|看电视|看综艺|看电影|逛超市|逛街|买菜|排队|收拾|洗碗|打扫|晾衣服|散步|遛狗|吃饭|吃早饭|吃午饭|吃晚饭|通勤|坐地铁|坐公交|打游戏/;
    const URGENT_RE = /救命|出事|紧急|急事|报警|医院|受伤|流血|不舒服|害怕|崩溃|不想活|马上回|立刻回|快回|现在就回/;
    const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const dayOf = (ms, off = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + off).getTime(); };
    const at = (dayMs, v) => { const d = new Date(dayMs); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +v.slice(0, 2), +v.slice(3, 5)).getTime(); };
    const span = (dayMs, from, to) => { const s = at(dayMs, from); const e = at(dayMs, to); return [s, e > s ? e : at(dayOf(dayMs, 1), to)]; };
    const hmOf = ms => hm(new Date(ms));
    const hmIn = text => {
      const m = /(\d{1,2})\s*[:：点]\s*(\d{1,2})?/.exec(String(text || ""));
      if (!m || +m[1] > 23 || (m[2] && +m[2] > 59)) return "";
      return String(+m[1]).padStart(2, "0") + ":" + String(m[2] ? +m[2] : 0).padStart(2, "0");
    };
    const kindOf = word => /睡/.test(word) ? "sleep" : /专注/.test(word) ? "focus" : /分神/.test(word) ? "distracted" : /忙/.test(word) ? "busy" : "";
    const focusedOf = win => typeof win.focused === "boolean" ? win.focused : FOCUS_RE.test(win.title || "");
    const listVar = (name, cid) => {
      const v = ctx.data.variables.get(name, "character", cid);
      return v && typeof v === "object" && Array.isArray(v.items) ? v.items.filter(x => x && typeof x === "object") : [];
    };
    const routineItems = cid => listVar("routine", cid).filter(it => HM_RE.test(it.from) && HM_RE.test(it.to) && it.from !== it.to && KINDS.includes(it.kind));
    const exceptionsOf = (cid, t) => on("exceptions") ? listVar("routineExceptions", cid).filter(ex => Number(ex.until) > t) : [];

    function routineOcc(cid, t) {
      const out = [];
      for (const it of routineItems(cid)) {
        const days = Array.isArray(it.days) ? it.days : [];
        for (let off = -1; off <= 1; off++) {
          const day = dayOf(t, off);
          if (days.length && !days.includes(new Date(day).getDay())) continue;
          const [from, to] = span(day, it.from, it.to);
          out.push({ origin: "routine", title: String(it.title || KIND_NAME[it.kind]).slice(0, 20), kind: it.kind, from, to });
        }
      }
      return out;
    }
    // 挂念日程；固定作息里写了睡觉，就不再用挂念的作息时间
    function appOcc(source, t, skipSleep) {
      const out = [];
      if (!source) return out;
      const sl = source.sleep;
      if (sl && !skipSleep && HM_RE.test(sl.bed) && HM_RE.test(sl.wake) && sl.bed !== sl.wake) {
        for (let off = -1; off <= 1; off++) { const [from, to] = span(dayOf(t, off), sl.bed, sl.wake); out.push({ origin: "app", title: "睡觉", kind: "sleep", from, to }); }
      }
      const busy = source.busy;
      if (busy && /^\d{4}-\d{2}-\d{2}$/.test(busy.date || "")) {
        const [y, m, d] = busy.date.split("-").map(Number);
        for (const win of busy.windows || []) {
          if (!HM_RE.test(win.from) || !HM_RE.test(win.to) || win.from === win.to) continue;
          const [from, to] = span(new Date(y, m - 1, d).getTime(), win.from, win.to);
          out.push({ origin: "app", title: win.title || "忙", kind: focusedOf(win) ? "focus" : "busy", from, to, win });
        }
      }
      return out;
    }
    const exAdds = exs => exs.filter(ex => KINDS.includes(ex.kind) && Number.isFinite(ex.from) && Number.isFinite(ex.to))
      .map(ex => ({ origin: "exception", title: ex.title, kind: ex.kind, from: ex.from, to: ex.to, ex }));
    const pick = (list, t) => list.filter(o => o.from <= t && t < o.to).sort((a, b) => RANK[a.kind] - RANK[b.kind])[0] || null;
    function layers(cid, t, source) {
      const exs = exceptionsOf(cid, t), routine = routineOcc(cid, t);
      return { exs, adds: exAdds(exs), routine, app: appOcc(source, t, routine.some(o => o.kind === "sleep")) };
    }

    // 某一刻的作息（不含手动状态）：kind = sleep / focus / busy / distracted / free
    function stateAt(cid, t, source) {
      const L = layers(cid, t, source);
      const add = pick(L.adds, t);
      if (add) return add;
      const mask = L.exs.find(ex => Number(ex.maskFrom) <= t && t < Number(ex.maskTo));
      if (mask) return { kind: "free", origin: "exception", title: mask.title, was: mask.was, from: mask.maskFrom, to: mask.maskTo, ex: mask };
      const hit = pick(L.routine, t) || pick(L.app, t);
      if (hit) return hit;
      const pr = ctx.data.variables.get("presence", "character", cid);
      if (pr && typeof pr === "object" && pr.managedBy === "guanian-host" && (!pr.state || pr.state === "online")
          && (!Number(pr.at) || t - Number(pr.at) <= 6 * 3600000) && DISTRACT_RE.test(String(pr.doing || ""))) {
        return { kind: "distracted", origin: "app", title: String(pr.doing).trim().slice(0, 20) };
      }
      return { kind: "free" };
    }
    function manualState(cid, t) {
      const ov = ctx.data.variables.get("presenceOverride", "character", cid);
      if (!ov || typeof ov !== "object" || !ov.state) return null;
      const from = Number(ov.at), to = from + num("manualBusyMin", 60, 1, 720) * 60000;
      if (!["busy", "sleep", "distracted"].includes(ov.state) || !Number.isFinite(from) || t < from || t >= to) return { kind: "free", origin: "manual" };
      const title = String(ov.label || "");
      return { kind: ov.state === "busy" && /专注|开会|会议|上课|考试|驾驶|开车/.test(title) ? "focus" : ov.state, title, from, to, origin: "manual" };
    }
    const stateNow = (cid, t) => manualState(cid, t) || stateAt(cid, t, sourceOf(cid));

    // 接下来的安排（已按例外改过），给提示词、面板和找「改哪一段」用
    function upcoming(cid, t, source, hours, limit) {
      const L = layers(cid, t, source), end = t + hours * 3600000, out = [];
      const fullyMasked = o => L.exs.some(ex => Number(ex.maskFrom) <= o.from && o.to <= Number(ex.maskTo));
      for (const o of [...L.adds, ...L.routine, ...L.app]) {
        if (o.to <= t || o.from >= end || (o.origin !== "exception" && fullyMasked(o))) continue;
        if (out.some(x => x.from < o.to && o.from < x.to)) continue;
        out.push(o);
      }
      return out.sort((a, b) => a.from - b.from).slice(0, limit || 99);
    }
    function busyWindows(cid, t, source, current) {
      const d0 = dayOf(t), d1 = dayOf(t, 1);
      const list = [current, ...upcoming(cid, d0, source, 24).filter(o => (o.kind === "busy" || o.kind === "focus") && !(o.from < current.to && current.from < o.to))];
      return list.sort((a, b) => a.from - b.from).map(o => ({
        from: o.from <= d0 ? "00:00" : hmOf(o.from), to: o.to >= d1 ? "23:59" : hmOf(o.to), title: o.title, focused: o.kind === "focus",
        ...(o.win && Array.isArray(o.win.breaks) ? { breaks: o.win.breaks } : {}),
      })).filter(w => w.from < w.to);
    }
    function findOcc(cid, text, t, source) {
      const s = String(text || ""), when = hmIn(s), tomorrow = /明天|明早|明晚/.test(s), sleepy = /睡/.test(s);
      const core = s.replace(/明天|明早|明晚|今天|今晚|今早|这次|那节|的|\d{1,2}\s*[:：点]\s*\d{0,2}/g, "").trim();
      const list = upcoming(cid, t, source, 30).filter(o => sleepy ? o.kind === "sleep"
        : (!when || hmOf(o.from) === when) && (!core || o.title.includes(core) || core.includes(o.title)) && !!(core || when));
      const d1 = new Date(t).getHours() < 5 ? dayOf(t) : dayOf(t, 1), d2 = dayOf(d1, 1);
      const scoped = tomorrow ? list.filter(o => o.from >= d1 && o.from < d2) : list;
      return (scoped.length ? scoped : list)[0] || null;
    }
    const dayWord = (ms, t) => ms >= dayOf(t, 1) ? "明天 " : "";
    function labelOf(ex, t) {
      if (ex.op === "add") return `临时加 ${hmOf(ex.from)}–${hmOf(ex.to)} ${ex.title}`;
      if (ex.op === "shift") return `${ex.title}推迟到 ${dayWord(ex.from, t)}${hmOf(ex.from)}`;
      return ex.was === "sleep" ? `${hmOf(ex.maskFrom)}–${hmOf(ex.maskTo)} 不睡了` : `${dayWord(ex.maskFrom, t)}${hmOf(ex.maskFrom)} ${ex.title}，不去了`;
    }
    function saveException(cid, rec, t) {
      const same = ex => ex.op === rec.op && ex.title === rec.title && Math.abs(Number(ex.maskFrom ?? ex.from) - Number(rec.maskFrom ?? rec.from)) < 60000;
      const list = listVar("routineExceptions", cid).filter(ex => Number(ex.until) > t && !same(ex) && ex.id !== rec.replaces);
      delete rec.replaces;
      list.push(rec);
      ctx.data.variables.set("routineExceptions", { items: list.slice(-20) }, "character", cid);
      return rec;
    }
    // 推迟 / 取消 / 加：target 是面板里点选的那一段，剧情标记里靠文字找
    function applyException(cid, op, arg, meta, target) {
      const t = Date.now(), source = sourceOf(cid);
      const parts = String(arg || "").split(/[|｜]/).map(x => x.trim());
      let rec;
      if (op === "加" || op === "add") {
        const m = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(parts[0] || "");
        const f = m && hmIn(m[1] + ":" + m[2]), e = m && hmIn(m[3] + ":" + m[4]);
        if (!f || !e || f === e) return null;
        let [from, to] = span(dayOf(t), f, e);
        if (to <= t) [from, to] = span(dayOf(t, 1), f, e);
        const kind = kindOf(parts[2] || "") || (FOCUS_RE.test(parts[1] || "") ? "focus" : DISTRACT_RE.test(parts[1] || "") ? "distracted" : "busy");
        rec = { op: "add", title: (parts[1] || KIND_NAME[kind]).slice(0, 20), kind, from, to };
      } else {
        const occ = target && Number.isFinite(target.from) ? target : findOcc(cid, parts[0], t, source);
        if (!occ) return null;
        const base = { title: occ.title, was: occ.kind, maskFrom: occ.ex ? Number(occ.ex.maskFrom ?? occ.from) : occ.from, replaces: occ.ex ? occ.ex.id : undefined };
        const when = hmIn(parts[1] || (op === "推迟" || op === "shift" ? parts[0] : ""));
        let start = when ? at(dayOf(t), when) : NaN;
        if (start < t - 30 * 60000) start = at(dayOf(t, 1), when);
        if ((op === "推迟" || op === "shift") && !(start > occ.from)) return null;
        rec = (op === "推迟" || op === "shift") && start < occ.to
          ? { op: "shift", ...base, kind: occ.kind, from: start, to: occ.to, maskTo: start }
          : { op: "skip", ...base, maskTo: occ.to };
      }
      rec.id = "ex" + t.toString(36) + Math.random().toString(36).slice(2, 5);
      rec.via = meta.via || "聊天"; rec.quote = String(meta.quote || "").slice(0, 30); rec.at = t;
      rec.until = Math.max(Number(rec.to) || 0, Number(rec.maskTo) || 0);
      rec.label = meta.label || labelOf(rec, t);
      return saveException(cid, rec, t);
    }
    function agendaHint(cid, t) {
      if (!on("exceptions")) return "";
      const list = upcoming(cid, t, sourceOf(cid), 18, 8);
      if (!list.length) return "";
      const d1 = dayOf(t, 1);
      const when = o => (o.from <= t ? "现在" : dayWord(o.from, t) + hmOf(o.from)) + "–" + (o.from < d1 && o.to > d1 ? "明天 " : "") + hmOf(o.to);
      const changed = exceptionsOf(cid, t).map(ex => ex.label || labelOf(ex, t));
      return [
        "你接下来的安排：",
        ...list.map(o => `- ${when(o)} ${o.title}（${KIND_NAME[o.kind]}）`),
        changed.length ? "今天已经改过：" + changed.join("；") : "",
        "如果剧情让你真的改了安排（决定晚点睡陪对方、这次不去做某件事、临时要去做别的），在这轮回复最后附一个对方看不到的标记，一次写一件：",
        "[作息:推迟|睡觉|03:00] 把某件事推到几点开始",
        "[作息:取消|上课] 这一次不做了（可以写上「明天」或开始时间，指明是哪一次）",
        "[作息:加|14:00-16:00|去医院|忙] 临时加一段，最后写 睡觉/专注/忙/分神",
        "安排没变就不写，正文里也不要提这个标记。",
      ].filter(Boolean).join("\n");
    }
    function availability(cid, t) {
      const st = stateAt(cid, t, sourceOf(cid));
      let state = "online", label = "";
      if (st.kind === "sleep") { state = "sleep"; label = "睡觉中"; }
      else if (st.kind === "busy" || st.kind === "focus") { state = "busy"; label = "忙碌" + (st.title ? " · " + st.title : ""); }
      else if (st.kind === "distracted") { state = "distracted"; label = "分神 · " + (st.title ? "一边" + st.title + "一边看手机" : "手上有事"); }
      else if (st.origin === "exception") label = st.was === "sleep" ? (st.ex.via === "来电" ? "被电话叫醒 · 还醒着" : "本该睡了 · 还在陪你") : `本该${st.title} · 没去`;
      return {
        state, label, until: st.to || null,
        origin: { routine: "固定作息", exception: "今天的例外", app: "挂念日程" }[st.origin] || "",
        authoritative: routineItems(cid).length > 0 || exceptionsOf(cid, t).length > 0,
      };
    }

    function describeReplyState(characterId) {
      const record = name => {
        const value = ctx.data.variables.get(name, "character", characterId);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      };
      const text = value => {
        if (typeof value !== "string") return "";
        const clean = value.replace(/\s+/g, " ").trim();
        return clean.length > 180 ? clean.slice(0, 180) + "…" : clean;
      };
      const lines = [];
      const add = (label, value) => { const content = text(value); if (content) lines.push(label + "：" + content); };
      const labels = { online: "在线", busy: "忙碌", sleep: "睡觉中", away: "离开", hidden: "隐身" };
      const presence = record("presence");
      add("日程状态", labels[presence.state] || (presence.asleep ? "睡觉中" : presence.busy ? "忙碌" : ""));
      add("状态说明", presence.label);
      add("正在做", presence.doing);
      add("当前进展", presence.step);
      add("地点", presence.place);
      add("心情", presence.mood);
      if (typeof presence.energy === "number" && Number.isFinite(presence.energy)) lines.push("精力：" + presence.energy + "/100");
      add("接下来", presence.next);
      const override = record("presenceOverride");
      const timed = ["busy", "sleep"].includes(override.state);
      const at = Number(override.at), now = Date.now();
      if (!timed || Number.isFinite(at) && at <= now && now < at + num("manualBusyMin", 60, 1, 1440) * 60000) {
        add("手动状态", labels[override.state]);
        if (labels[override.state]) add("手动状态说明", override.label);
      }
      return lines.join("\n");
    }
    const calls = new Map(); // sessionId → 这通电话接通前的判断，挂断时用
    ctx.hooks.transform("prompt.system", raw => {
      if (raw.isGroup || ctx.system.settings.get("enabled") === false) return raw;
      const call = calls.get(raw.sessionId);
      const extra = [raw.characterId ? agendaHint(raw.characterId, Date.now()) : "",
        call && call.hint && !call.ended && Date.now() - call.at < 2 * 3600000 ? call.hint : ""].filter(Boolean).join("\n");
      const p = extra ? { ...raw, hint: raw.hint + "\n" + extra } : raw;
      if (p.replyText == null || ctx.system.settings.get("allowSilence") === false) return p;
      if (ctx.system.settings.get("urgentBypass") !== false && URGENT_RE.test(p.replyText.replace(/\s+/g, ""))) return p;
      const states = describeReplyState(p.characterId);
      return { ...p, allowSilence: true, hint: p.hint + "\n" + [
        "是否回应由你结合人设、关系、已有剧情、情绪、当前状态和整段待回应消息判断，不是每条消息都必须回复。",
        "既可以在确认、道别、明确不用回时结束对话，也可以因生气、不知如何回答、需要独处、不愿继续话题，或错过回应时机而选择沉默；这些必须有上下文依据，不要凭空制造矛盾、机械按关键词或随机漏回。即使对方提出问题，也不代表你在任何情境下都必须回答。",
        "新消息到来时重新判断，既不强制补答此前每条消息，也不自动结束符合当前情境的沉默。明确求助或紧急情况应优先回应。",
        "忙碌或睡眠的时间说明只代表现在有机会看消息，不强制你回应。选择不回时不承诺稍后补回，不写沉默旁白、解释或省略号气泡。",
        states ? "状态参考（结合当前时间和对话判断）：\n" + states : "",
      ].filter(Boolean).join("\n") };
    });
    ctx.hooks.transform("chat.replyGate", p => {
      migrate(p.source);
      if (ctx.system.settings.get("enabled") === false) return { ...p, gate: null };
      const source = p.source;
      const mode = ctx.system.settings.get("sleepMode");
      const sleepPolicy = { mode: mode === "chance" ? 2 : 1, wakeProb: num("wakeProb", 18, 0, 100), bufferMin: num("wakeBufferMin", 10, 0, 120) };
      const busyPolicy = { peekMin: num("peekMin", 3, 0, 60), adaptive: ctx.system.settings.get("adaptive") !== false, focusedPeekProb: num("focusedPeekProb", 25, 0, 100) };
      const gate = { urgentBypass: ctx.system.settings.get("urgentBypass") !== false, updatedAt: p.nowMs };
      const distractedPolicy = title => ({ title: title || "", minSec: num("distractedMinSec", 30, 0, 600), maxSec: num("distractedMaxSec", 120, 0, 900), pullCount: num("pullCount", 3, 0, 20) });
      const override = ctx.data.variables.get("presenceOverride", "character", p.characterId);
      if (override && typeof override === "object" && override.state) {
        // Explicit online/away/hidden cancels inherited busy/sleep; expired overrides do not become permanent gates.
        if (!["busy", "sleep", "distracted"].includes(override.state)) return { ...p, gate: null };
        const fromMs = Number(override.at);
        const toMs = fromMs + num("manualBusyMin", 60, 1, 720) * 60000;
        if (!Number.isFinite(fromMs) || p.nowMs < fromMs || p.nowMs >= toMs) return { ...p, gate: null };
        const now = new Date(p.nowMs), from = new Date(fromMs), to = new Date(toMs);
        gate.startsAt = fromMs; gate.expiresAt = toMs;
        if (override.state === "sleep" && mode !== "ignore") gate.sleep = { bed: hm(from), wake: hm(to), ...sleepPolicy };
        if (override.state === "busy") {
          const title = String(override.label || "手动忙碌");
          gate.busy = { date: ymd(now), ...busyPolicy, windows: [{ from: "00:00", to: "23:59", title, focused: /专注|开会|会议|上课|考试|驾驶|开车/.test(title) }] };
        }
        if (override.state === "distracted" && on("distracted")) gate.distracted = distractedPolicy(String(override.label || ""));
      } else if (routineItems(p.characterId).length || exceptionsOf(p.characterId, p.nowMs).length) {
        const st = stateAt(p.characterId, p.nowMs, source);
        if (st.kind === "sleep" && mode !== "ignore") gate.sleep = { bed: hmOf(st.from), wake: hmOf(st.to), ...sleepPolicy };
        if (st.kind === "busy" || st.kind === "focus") gate.busy = { date: ymd(new Date(p.nowMs)), ...busyPolicy, windows: busyWindows(p.characterId, p.nowMs, source, st) };
        if (st.kind === "distracted" && on("distracted")) gate.distracted = distractedPolicy(st.title);
      } else if (source) {
        if (source.sleep && mode !== "ignore") gate.sleep = { bed: source.sleep.bed, wake: source.sleep.wake, ...sleepPolicy };
        if (source.busy) gate.busy = { date: source.busy.date, ...busyPolicy, windows: source.busy.windows.map(win => ({ ...win,
          focused: typeof win.focused === "boolean" ? win.focused : /专注|开会|会议|例会|晨会|周会|月会|上课|课堂|考试|测验|开车|驾驶|手术|面试|汇报|训练|排练|实验|演出|上台/.test(win.title || ""),
        })) };
      }
      if (!override?.state && !gate.sleep && !gate.busy && on("distracted")) {
        const st = stateAt(p.characterId, p.nowMs, source);
        if (st.kind === "distracted") gate.distracted = distractedPolicy(st.title);
      }
      return { ...p, gate: gate.sleep || gate.busy || gate.distracted ? gate : null };
    });

    // 剧情里的 [作息:推迟|睡觉|03:00] / [作息:取消|上课] / [作息:加|14:00-16:00|去医院|忙]：从正文拿掉，记成今天的例外
    const DIRECTIVE_RE = /\[作息[:：]\s*(推迟|取消|加)\s*(?:[|｜]([^\]\n]*))?\]/g;
    const quoteOf = before => (String(before).replace(/\[[^\]]*\]/g, "").split(/[。！？!?\n]/).map(x => x.trim().replace(/^[「“"']+|[」”"']+$/g, "")).filter(Boolean).pop() || "").slice(-24);
    ctx.hooks.transform("llm.response", p => {
      if (typeof p.text !== "string" || !/\[作息[:：]/.test(p.text)) return p;
      const found = [];
      const text = p.text.replace(DIRECTIVE_RE, (_, op, arg, offset) => { found.push({ op, arg: arg || "", quote: quoteOf(p.text.slice(0, offset)) }); return ""; })
        .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!found.length) return p;
      const session = p.sessionId ? ctx.data.sessions.get(p.sessionId) : null;
      if (session && !session.isGroup && on("enabled") && on("exceptions")) {
        const via = ctx.chat && ctx.chat.offline && ctx.chat.offline.get(session.id) ? "线下" : "聊天";
        for (const f of found) { try { applyException(session.contactId, f.op, f.arg, { via, quote: f.quote }); } catch (e) { if (ctx.system.log) ctx.system.log("exception", e && e.message); } }
      }
      return { ...p, text };
    });

    // 你打过去：睡着的看连打几通能不能叫醒，专注的拒接，一般忙的按概率接
    const canWake = () => !!(ctx.chat && typeof ctx.chat.scheduleWake === "function");
    const between = (a, b) => Math.round(a + Math.random() * Math.max(0, b - a));
    function missedChain(cid, t) {
      const gap = num("callChainMin", 5, 1, 30) * 60000, list = ctx.system.storage.get("missed:" + cid) || [];
      let n = 0, last = t;
      for (let i = list.length - 1; i >= 0 && last - list[i] <= gap; i--) { n++; last = list[i]; }
      return n;
    }
    const rejectReason = title => {
      const x = String(title || "").replace(/^(正在|在)/, "");
      return /会议|例会|晨会|周会|月会|开会/.test(x) ? "在开会" : x ? ("在" + x).slice(0, 12) : "在忙";
    };
    ctx.hooks.transform("call.beforeConnect", p => {
      if (ctx.system.settings.get("enabled") === false || !p.characterId) return p;
      const t = Date.now(), cid = p.characterId, ring = num("callRingSec", 20, 10, 60) * 1000;
      const st = stateNow(cid, t), info = { st, at: t };
      calls.set(p.sessionId, info);
      const lastUser = (ctx.data.messages ? ctx.data.messages.list(p.sessionId) : []).filter(m => m.role === "user" && !/^\[我/.test(m.content || "")).pop();
      if (on("urgentBypass") && lastUser && t - Date.parse(lastUser.createdAt) < 15 * 60000 && URGENT_RE.test(String(lastUser.content).replace(/\s+/g, ""))) {
        return { ...p, outcome: "answer", ringMs: 2500 };
      }
      if (st.kind === "sleep") {
        const n = Math.min(missedChain(cid, t), 2);
        if (Math.random() * 100 >= num(["callWake1", "callWake2", "callWake3"][n], [35, 70, 100][n], 0, 100)) return { ...p, outcome: "noAnswer", ringMs: ring };
        info.woken = true;
        info.hint = "你本来在睡觉，被这通电话吵醒了：声音迷糊、反应慢半拍，先弄清楚对方为什么这个点打来。";
        return { ...p, outcome: "answer", ringMs: between(Math.min(6000, ring), ring * 0.8) };
      }
      if (st.kind === "focus") return { ...p, outcome: "reject", ringMs: between(3000, 7000), reason: rejectReason(st.title) };
      if (st.kind === "busy") {
        if (Math.random() * 100 >= num("callBusyAnswer", 50, 0, 100)) return { ...p, outcome: "noAnswer", ringMs: ring };
        info.hint = `你正在${st.title || "忙"}，抽空接的电话：压着声音，说两句就得回去。`;
        return { ...p, outcome: "answer", ringMs: between(4000, 9000) };
      }
      if (st.kind === "distracted") info.hint = `你正一边${st.title || "做事"}一边接电话，偶尔分心顾一下手上的事。`;
      return p;
    });
    if (ctx.hooks.on) ctx.hooks.on("call.ended", e => {
      const info = calls.get(e.sessionId), cid = e.characterId;
      if (info) info.ended = true;
      if (!cid || !info || e.outcome === "cancel") return;
      const t = Date.now(), what = e.kind === "video" ? "视频电话" : "语音电话", st = info.st;
      if (e.outcome === "answer") {
        ctx.system.storage.set("missed:" + cid, []);
        if (canWake()) ctx.chat.cancelWake("missed:" + cid);
        if (info.woken) {
          applyException(cid, "取消", "", { via: "来电", label: `被电话叫醒 · ${hmOf(t)} 起醒着` }, { title: st.title || "睡觉", kind: "sleep", from: t, to: Math.min(st.to || t + 1800000, t + 1800000) });
          ctx.data.variables.set("wokenByCall", { at: t, kind: e.kind }, "character", cid);
        }
        return;
      }
      if (e.outcome === "noAnswer") {
        ctx.system.storage.set("missed:" + cid, [...(ctx.system.storage.get("missed:" + cid) || []), t].slice(-10));
        if (!st.to || !canWake()) return;
        const n = missedChain(cid, t);
        const intent = st.kind === "sleep"
          ? `你睡着时对方打来 ${n} 个${what}都没接到（最后一次 ${hmOf(t)}）。你刚醒看到，第一句先问对方怎么了、出什么事了。`
          : `你刚才在${st.title || "忙"}，没接到对方的${what}（${hmOf(t)}）。现在忙完了，回过去问问什么事。`;
        const fireAt = st.kind === "sleep" ? st.to + num("wakeBufferMin", 10, 0, 120) * 60000 : st.to + 60000;
        void Promise.resolve(ctx.chat.scheduleWake({ characterId: cid, fireAt: Math.max(fireAt, t + 60000), intent, key: "missed:" + cid })).catch(() => {});
      } else if (e.outcome === "reject" && on("callCallback") && st.to && canWake()) {
        const intent = `你刚才在${st.title || "忙"}，拒接了对方的${what}（${hmOf(t)}）。现在忙完了，主动回过去：问问刚才什么事，可以问要不要打回去。`;
        void Promise.resolve(ctx.chat.scheduleWake({ characterId: cid, fireAt: Math.max(st.to + 60000, t + 60000), intent, key: "callback:" + cid })).catch(() => {});
      }
    });

    // 给在线状态面板：此刻的作息、接下来的安排、手动加例外
    const bus = ctx.system.bus;
    if (bus) {
      bus.on("availability.query", q => { if (q && q.characterId) q.result = availability(q.characterId, Number(q.nowMs) || Date.now()); });
      bus.on("routine.agenda", q => {
        if (!q || !q.characterId) return;
        q.result = upcoming(q.characterId, Date.now(), sourceOf(q.characterId), 24, 10)
          .map(o => ({ title: o.title, kind: o.kind, from: o.from, to: o.to, origin: o.origin, exId: o.ex ? o.ex.id : undefined }));
      });
      bus.on("routine.exception", q => {
        if (!q || !q.characterId) return;
        const target = q.target && q.target.exId ? { ...q.target, ex: listVar("routineExceptions", q.characterId).find(ex => ex.id === q.target.exId) } : q.target;
        q.result = applyException(q.characterId, q.op, q.arg, { via: "手动" }, target);
      });
    }
  },
};

export default busyReplyPlugin;
