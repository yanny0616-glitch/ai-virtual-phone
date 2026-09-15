  /* ---- 「忙碌回复」插件的固定作息和今天的例外：生成那天时当成日程表上定死的安排 ---- */
  // 作息存 HH:MM + 星期；例外存绝对时间戳（加 / 推迟 / 不去了），过了 until 就作废。
  const ROUTINE_LOCK = { focus: "busy", busy: "busy", distracted: "free", sleep: "busy" };
  const ROUTINE_NAME = { focus: "专注", busy: "忙", distracted: "分神", sleep: "午睡" };
  const ROUTINE_HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const mins = (v) => +v.slice(0, 2) * 60 + +v.slice(3, 5);
  async function routineVar(cx, name) {
    if (!AiPhone.variables || !AiPhone.variables.get) return [];
    try {
      const v = await AiPhone.variables.get(name, { scope: "character", characterId: cx.character.id });
      return v && Array.isArray(v.items) ? v.items.filter((x) => x && typeof x === "object") : [];
    } catch (e) { return []; }
  }
  // 不到 3 小时的「睡觉」当午睡排进日程，够长的才定起床和上床
  async function routineFor(cx, date) {
    const out = { items: [], wake: "", bed: "" };
    if (!S.settings.routineOn || !cx.character) return out;
    const day = dateOf(date);
    const d0 = day.getTime(), d1 = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const item = (id, from, to, title, kind) => ({ id: "routine_" + id, startTime: from, endTime: to, title: title || ROUTINE_NAME[kind], location: "", lock: ROUTINE_LOCK[kind] });
    for (const it of await routineVar(cx, "routine")) {
      if (!ROUTINE_HM.test(it.from) || !ROUTINE_HM.test(it.to) || it.from === it.to || !ROUTINE_LOCK[it.kind]) continue;
      const days = Array.isArray(it.days) ? it.days : [];
      const on = (off) => !days.length || days.includes((day.getDay() + off + 7) % 7);
      const title = String(it.title || "").slice(0, 20);
      if (it.kind === "sleep" && (mins(it.to) - mins(it.from) + 1440) % 1440 >= 180) {
        const cross = it.from > it.to;
        if (!out.wake && on(cross ? -1 : 0)) out.wake = it.to;
        if (!out.bed && on(cross ? 0 : 1)) out.bed = it.from;
      } else if (on(0)) out.items.push(item(it.id || it.from, it.from, it.to, title, it.kind));
    }
    const now = Date.now(), inDay = (ms) => ms >= d0 && ms < d1;
    for (const ex of await routineVar(cx, "routineExceptions")) {
      if (!(+ex.until > now)) continue;
      const title = String(ex.title || "").slice(0, 20), mask = +(ex.maskFrom != null ? ex.maskFrom : ex.from);
      // 推迟睡觉：今晚上床的时刻跟着挪，挪过零点也算今晚
      if (ex.op === "shift" && ex.kind === "sleep") { if (inDay(mask)) out.bed = fmtHM(+ex.from); continue; }
      if ((ex.op === "skip" || ex.op === "shift") && inDay(mask)) {
        const i = out.items.findIndex((x) => x.title === title && x.startTime === fmtHM(mask));
        if (i >= 0) out.items.splice(i, 1);
      }
      if ((ex.op === "add" || ex.op === "shift") && inDay(+ex.from) && ROUTINE_LOCK[ex.kind]) out.items.push(item(ex.id || ex.from, fmtHM(+ex.from), fmtHM(+ex.to), title, ex.kind));
    }
    return out;
  }
  // 日历上本来就有同一时刻的安排时，以日历为准
  function withRoutine(existing, routine) {
    const taken = new Set(existing.map((it) => it.startTime));
    return existing.concat(routine.items.filter((it) => !taken.has(it.startTime)))
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  }
  function routineSleep(routine) {
    return Object.assign({}, routine.wake ? { wake: routine.wake } : {}, routine.bed ? { bed: routine.bed } : {});
  }
