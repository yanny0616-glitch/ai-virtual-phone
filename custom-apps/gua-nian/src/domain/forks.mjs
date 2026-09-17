// 变数：生成日程时埋在某件事上的岔子，到那件事开始后揭晓。发没发生只看固定种子，
// App 和云端各算各的、结果一样，不用互相同步，也不用补报。
// push-recheck / push-generate 里有带类型的副本（scripts/check-gua-nian-forks.mjs 逐条对照），改这里要同步那边。

const LEVELS = [{ n: 1, mult: 0.45 }, { n: 2, mult: 1 }, { n: 3, mult: 1.35 }];
const TELL = { 忍不住: "burst", 聊到才说: "hint", 憋着: "keep", burst: "burst", hint: "hint", keep: "keep" };
const SAYS = ["keep", "hint", "burst"];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function forkRoll(seed) {
  return hash(String(seed)) % 100;
}
function hm(v) {
  const m = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(String(v == null ? "" : v));
  return m ? String(Math.min(23, +m[1])).padStart(2, "0") + ":" + String(Math.min(59, +(m[2] || 0))).padStart(2, "0") : "";
}
function minsOf(t) {
  return +t.slice(0, 2) * 60 + +t.slice(3, 5);
}
function hmOf(n) {
  const t = Math.max(0, Math.min(n, 23 * 60 + 59));
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return v !== "" && v != null && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
export function forkLevel(level) {
  return typeof level === "number" && [0, 1, 2].includes(level) ? level : 1;
}

export function normalizeForks(raw, schedule, level) {
  const lv = LEVELS[forkLevel(level)];
  const sched = (Array.isArray(schedule) ? schedule : []).filter((it) => it && typeof it.time === "string");
  const out = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (out.length >= lv.n) break;
    if (!f || typeof f !== "object") continue;
    const at = hm(f.at), what = String(f.what || "").trim().slice(0, 60);
    const item = at ? sched.find((it) => it.time === at) : null;
    if (!item || !what || out.some((x) => x.at === at)) continue;
    const span = item.end && item.end > at ? minsOf(item.end) - minsOf(at) : 120;
    const rv = hm(f.time);
    const off = rv && rv >= at ? Math.min(minsOf(rv) - minsOf(at), span) : Math.min(10, span);
    const reveal = hmOf(minsOf(at) + off);
    const later = (t) => {
      const x = hm(t);
      return x && x >= reveal && x !== at && sched.some((it) => it.time === x) ? x : "";
    };
    const titleAt = (t) => String((sched.find((it) => it.time === t) || {}).title || "");
    let add = null;
    if (f.add && typeof f.add === "object" && String(f.add.title || "").trim()) {
      const t = hm(f.add.time), time = t && t >= reveal ? t : reveal, end = hm(f.add.end);
      add = {
        time, end: end > time ? end : "", title: String(f.add.title).trim().slice(0, 16),
        place: String(f.add.place || "").trim().slice(0, 16), cost: clampInt(f.add.cost, -15, 15, 0),
        busy: f.add.busy === true || /^(true|是|1)$/i.test(String(f.add.busy || "").trim()),
      };
    }
    const move = (Array.isArray(f.move) ? f.move : []).slice(0, 3)
      .map((m) => ({ time: later(m && m.time), to: hm(m && (m.newTime || m.to)) }))
      .filter((m) => m.time && m.to > m.time)
      .map((m) => ({ time: m.time, to: m.to, title: titleAt(m.time) }));
    const drop = (Array.isArray(f.drop) ? f.drop : []).slice(0, 2).map(later)
      .filter((t) => t && !move.some((m) => m.time === t))
      .map((t) => ({ time: t, title: titleAt(t) }));
    out.push({
      id: "f" + hash(at + "|" + item.title + "|" + what).toString(36),
      at, item: String(item.title || ""), off, what,
      label: String(f.label || "").trim().slice(0, 10) || what.slice(0, 8),
      p: Math.max(3, Math.min(90, Math.round(clampInt(f.p, 0, 100, 30) * lv.mult))),
      mood: String(f.mood || "").trim().slice(0, 24),
      energy: clampInt(f.energy, -10, 10, 0),
      tell: TELL[String(f.tell || "").trim()] || "hint",
      add, move, drop, state: "",
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// 说不说：模型给的倾向再按好感挪一档。没装好感插件就照模型的。
export function forkSay(tell, score) {
  let i = SAYS.indexOf(TELL[String(tell || "")] || "hint");
  if (typeof score === "number" && Number.isFinite(score)) {
    if (score >= 80) i += 1;
    else if (score >= 60 && i === 0) i = 1;
    else if (score < 15) i -= 1;
    else if (score < 35 && i === 2) i = 1;
  }
  return SAYS[Math.max(0, Math.min(2, i))];
}

// 只结算还没结算、且到了揭晓时刻的岔子；已结算的原样保留，所以重复调用结果不变。
// 锚点按标题找、找不到再按原时刻找：聊天改过日程也跟得上，那件事被删了就作废。
export function applyDueForks(day, nowHM, opts) {
  const forks = day && Array.isArray(day.forks) ? day.forks : [];
  const now = hm(nowHM), o = opts || {};
  if (!now || !forks.some((f) => f && !f.state)) return { day, revealed: [] };
  let sched = (Array.isArray(day.schedule) ? day.schedule : []).filter((it) => it && typeof it.time === "string").map((it) => ({ ...it }));
  let conds = Array.isArray(day.conds) ? day.conds.slice() : [];
  const revealed = [];
  const next = forks.map((f) => {
    if (!f || f.state) return f;
    const anchor = sched.find((it) => !it.fork && it.title === f.item) || sched.find((it) => !it.fork && it.time === f.at);
    if (!anchor) {
      const gone = { ...f, state: "void" };
      revealed.push(gone);
      return gone;
    }
    const reveal = hmOf(minsOf(anchor.time) + (Number(f.off) || 0));
    if (reveal > now) return f;
    const done = { ...f, at: reveal, state: forkRoll(String(o.seed || "") + "|" + f.id) < (Number(f.p) || 0) ? "hit" : "miss" };
    revealed.push(done);
    if (done.state !== "hit") return done;
    done.say = forkSay(f.tell, o.score);
    const own = (it, t) => it !== anchor && !it.fork && it.time === t && t >= reveal;
    for (const d of f.drop || []) sched = sched.filter((it) => !own(it, d.time));
    for (const m of f.move || []) {
      const it = sched.find((x) => own(x, m.time));
      if (!it) continue;
      const shift = minsOf(m.to) - minsOf(it.time);
      if (it.end && it.end > it.time) it.end = hmOf(minsOf(it.end) + shift);
      it.time = m.to;
      it.moved = true;
    }
    if (f.add) {
      const t = f.add.time > reveal ? f.add.time : reveal;
      sched.push({ time: t, end: f.add.end > t ? f.add.end : "", title: f.add.title, place: f.add.place, note: "", cost: Number(f.add.cost) || 0, busy: !!f.add.busy, fork: f.id });
    }
    sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const ms = f.mood && typeof o.at === "function" ? o.at(reveal) : 0;
    if (ms) conds = conds.concat([{ mood: f.mood, cause: f.label, energyDelta: Number(f.energy) || 0, intensity: 70, halfLifeMin: 240, startAt: ms }]).slice(-8);
    return done;
  });
  return revealed.length ? { day: { ...day, schedule: sched, conds, forks: next }, revealed } : { day, revealed };
}

export function forkNotes(day) {
  return (day && Array.isArray(day.forks) ? day.forks : []).filter((f) => f && f.state === "hit").slice(-3)
    .map((f) => "今天 " + f.at + " 碰上一件事：" + f.what + (f.say === "keep"
      ? "。你不想主动提，用户问起或聊到很贴近的事才可能说。"
      : f.say === "burst"
        ? "。你憋不住想跟用户说：还没说过的话，找个空当说出来；说过了别重复。"
        : "。还没跟用户说过的话，聊到相关的自然提起；说过了别重复。"));
}
