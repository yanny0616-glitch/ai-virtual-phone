  /* ---- 此刻的状态：日程记账 + 会自己淡掉的「情况」 ---- */
  // day.conds 是一摞此刻还在起作用的事（目前只有聊天判出来的），每条带
  // energyDelta（正=回血 负=消耗）和半衰期，随时间指数衰减到没有。
  // 日程的 cost 是走过就永久记账的，两条路各记各的，不重复计。
  function condWeight(c, ms) {
    const half = Math.max(10, +c.halfLifeMin || 180) * 60000;
    return Math.pow(0.5, Math.max(0, (ms || Date.now()) - (+c.startAt || 0)) / half);
  }
  function activeConds(day, ms) {
    const at = ms || Date.now();
    return ((day && day.conds) || [])
      .map((c) => ({ c: c, w: condWeight(c, at) }))
      .filter((x) => x.w > 0.08 && x.c && x.c.startAt <= at)
      .sort((a, b) => (b.w * (+b.c.intensity || 50)) - (a.w * (+a.c.intensity || 50)));
  }
  // 已经走过的最后一条日程，以及它过去了多久
  function lastDone(day, ms) {
    if (!day || !Array.isArray(day.schedule)) return null;
    const at = ms || Date.now(), nowHM = fmtHM(at);
    let hit = null;
    for (const it of day.schedule) { if (it && it.time && String(it.time) <= nowHM) hit = it; }
    return hit ? { it: hit, ago: Math.max(0, at - (timeToMs(hit.time, at) || at)) } : null;
  }
  function nextSched(day, ms) {
    if (!day || !Array.isArray(day.schedule)) return null;
    const nowHM = fmtHM(ms || Date.now());
    return day.schedule.find((it) => it && it.time && String(it.time) > nowHM) || null;
  }
  // 睡眠窗：day.bed 起到 day.wake 止，允许过零点。没生成过 wake/bed 的旧数据退回免打扰时段。
  function sleepWindow(day) {
    return GuaNianTime.getSleepWindow(day, S.settings);
  }
  function asleepAt(day, hm) {
    return GuaNianTime.isAsleep(day, hm, S.settings);
  }
  // 零点一过今天就换了记录，可TA的一夜还没过完。今天没生成之前，睡没睡、几点醒
  // 都按昨天那条记录里的作息来，别一到零点就当TA凭空消失了。
  function nightBridge(cx) {
    if (cx.day || !cx.prev) return null;
    const sw = sleepWindow(cx.prev);
    if (!sw) return null;
    const hm = fmtHM(Date.now());
    const asleep = asleepAt(cx.prev, hm);
    const upLate = sw.overnight && hm < sw.bed; // 过了零点还没上床
    return {
      asleep: asleep, wake: sw.wake, bed: sw.bed,
      doing: asleep ? "睡觉" : (upLate ? "还没睡，快上床了" : "刚起床，今天的安排还没定"),
      next: asleep ? sw.wake + " 起床" : (upLate ? sw.bed + " 睡觉" : ""),
    };
  }
  // 此刻处在一天的哪一段：sleep 睡着 / gap 两件事之间自己待着 / pre 最后一件事做完到上床之间 / on 正做着某条
  function phaseAt(day, ms) {
    const at = ms || Date.now(), hm = fmtHM(at);
    if (asleepAt(day, hm)) return { kind: "sleep" };
    const done = lastDone(day, at);
    if (!done) { // 过零点还没睡的那段也是睡前；否则是刚起床还没开始第一件事
      const sw = sleepWindow(day);
      return { kind: sw && sw.overnight && hm < sw.bed ? "pre" : "gap", it: null };
    }
    const it = done.it;
    if (it.end && it.end > it.time && hm >= it.end) return { kind: nextSched(day, at) ? "gap" : "pre", it: it };
    return { kind: "on", it: it };
  }
  // 精力不是全天一个静态数：day.energy 是TA今天刚醒时的基线，
  // 日程 cost 带符号（负=消耗，正=回血），只累计已经发生过的；再叠上聊天带来的
  // conds，最后减一条随醒着时长的缓降，22 点后陡降。凌晨 5 点前算作前一晚的延长，
  // 否则熬到 1 点反而显示精神饱满。
  function energyAt(day, ms) {
    const base = day && day.energy != null ? +day.energy : 60;
    if (!day || !Array.isArray(day.schedule)) return Math.max(0, Math.min(100, Math.round(base)));
    const at = new Date(ms || Date.now());
    const h = at.getHours() + at.getMinutes() / 60;
    const hh = h < 5 ? h + 24 : h;
    let v = base;
    const nowHM = fmtHM(at.getTime());
    // 一件事的 cost 随做的进度慢慢记账：刚开始只扣一点，做完才扣满；没有 end 的到点一次记满
    for (const it of day.schedule) {
      if (!it || !it.time) continue;
      if (h >= 5 && String(it.time) > nowHM) continue;
      const a = timeToMs(it.time, at), b = it.end ? timeToMs(it.end, at) : null;
      const prog = a && b && b > a ? Math.max(0, Math.min(1, (at.getTime() - a) / (b - a))) : 1;
      v += (+it.cost || 0) * prog;
    }
    // 身上的状况再多也不该把人直接压到 0：负向合计最多 -25
    let cd = 0;
    for (const x of activeConds(day, at.getTime())) cd += (+x.c.energyDelta || 0) * x.w;
    v += Math.max(-25, cd);
    // 醒着的缓降从 TA 自己起床的时刻算起，不是固定早上 7 点
    const wk = /^(\d{1,2}):(\d{2})$/.exec(String(day.wake || ""));
    const wakeH = wk ? +wk[1] + +wk[2] / 60 : 7;
    v -= Math.max(0, Math.min(hh, 22) - wakeH) * 1.2 + Math.max(0, hh - 22) * 8;
    return Math.max(0, Math.min(100, Math.round(v)));
  }
  // 情绪底色 = 早上生成的 day.mood；上面盖着聊天判出来的情绪、和刚做完那件事的余味，
  // 谁分量重显示谁，都淡掉了就露回底色。
  function moodNow(day, ms) {
    const at = ms || Date.now();
    const cand = [];
    const top = activeConds(day, at)[0];
    if (top && top.c.mood) cand.push({ text: String(top.c.mood), from: String(top.c.cause || "刚才聊的"), w: top.w * (+top.c.intensity || 50) / 100 });
    const done = lastDone(day, at);
    if (done && done.it.mood) cand.push({ text: String(done.it.mood), from: String(done.it.title || ""), w: Math.pow(0.5, done.ago / (90 * 60000)) * 0.6 });
    cand.sort((a, b) => b.w - a.w);
    const hit = cand.find((x) => x.text && x.w > 0.15);
    return hit ? { text: hit.text, from: hit.from, base: false } : { text: String((day && day.mood) || ""), from: "", base: true };
  }
  // 记一条新的「情况」；顺手把已经淡没的清掉，别让 days 记录无限长
  async function pushCond(cx, c) {
    if (!cx.day || !c || !c.mood) return;
    const now = Date.now();
    const conds = ((cx.day.conds || []).filter((x) => condWeight(x, now) > 0.08)).concat([c]).slice(-8);
    cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
      { date: todayStr(), characterId: cx.character.id, conds: conds });
  }
  function inQuiet(hm) {
    return GuaNianTime.isInTimeWindow(hm, S.settings.quietStart, S.settings.quietEnd);
  }

  /* ================= 聊天上下文 ================= */
  // 读最近的聊天记录（chat.read 权限）；未授权/无会话时返回空数组，不打断主流程
  async function readRecentChat(cx, limit) {
    try {
      const r = await AiPhone.chat.readHistory({ characterId: cx.character.id, limit: limit || 60 });
      if (r && r.sessionId) cx._session = r.sessionId; // 云端预约记录只认会话 id，撤孤儿预约时靠它认人
      return (r && r.messages || [])
        .filter((m) => !m.isRetracted && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, t: new Date(m.createdAt).getTime() || 0, c: String(m.content || "").replace(/\s+/g, " ").trim() }))
        .filter((m) => m.c);
    } catch (e) {
      await log(cx, "读聊天记录失败（不影响编排，只是少了聊天上下文）：" + (e && e.message || e));
      return [];
    }
  }
  // 把最近聊天压成给模型看的几行摘录
  function chatExcerpt(msgs, maxLines) {
    return msgs.slice(-(maxLines || 24)).map((m) =>
      (m.role === "user" ? "我：" : "TA：") + (m.c.length > 200 ? m.c.slice(0, 200) + "…" : m.c));
  }
