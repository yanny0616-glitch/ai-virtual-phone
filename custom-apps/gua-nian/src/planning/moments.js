  // ─── 发朋友圈 ───
  // 帖子只能由宿主在前台入库；云端起的意先记在计划 context.outbox 里，下次打开补成 at 那个时间点的帖子。
  // 配速只有这一套（一周几条、至少隔几小时），本机和云端共用；发圈账写进变量池 moments，「朋友圈节奏」插件看到就让位。
  function momentsReady() { return !!(S.settings.momentsOn && AiPhone.moments && AiPhone.moments.post); }
  function weekStartMs(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }
  function moState(cx) {
    const s = (S.settings.momentsState || {})[cx.character ? cx.character.id : ""] || {};
    const ws = weekStartMs(Date.now());
    return { lastAt: +s.lastAt || 0, weekStart: ws, weekN: +s.weekStart === ws ? (+s.weekN || 0) : 0 };
  }
  function moCanPost(cx) {
    const st = moState(cx);
    return momentsReady() && st.weekN < (+S.settings.momentsWeekly || 0) && Date.now() - st.lastAt >= (+S.settings.momentsGapH || 0) * 3600000;
  }
  async function moNote(cx, atMs, weekN) {
    const st = moState(cx);
    const next = { lastAt: Math.max(st.lastAt, atMs || 0), weekStart: st.weekStart, weekN: Math.max(st.weekN, weekN == null ? st.weekN + 1 : weekN) };
    if (next.lastAt === st.lastAt && next.weekN === st.weekN) return;
    await patchSettings((x) => ({ momentsState: Object.assign({}, x.momentsState || {}, { [cx.character.id]: next }) }));
    await publishMoments(cx);
  }
  async function publishMoments(cx) {
    if (!cx.character || !AiPhone.variables || !AiPhone.variables.set) return;
    const opts = { scope: "character", characterId: cx.character.id };
    try {
      if (!momentsReady()) { await AiPhone.variables.unset("moments", opts); return; }
      const st = moState(cx);
      await AiPhone.variables.set("moments", { by: "gua-nian", at: Date.now(), weeklyTarget: S.settings.momentsWeekly, minGapHours: S.settings.momentsGapH, lastPostAt: st.lastAt, weekN: st.weekN }, opts);
    } catch (e) { /* 变量池不可用就算了 */ }
  }
  async function postMoment(cx, hint, atMs, by) {
    hint = String(hint || "").trim().slice(0, 120);
    if (!hint || !cx.character || !momentsReady()) return false;
    const who = by === "cloud" ? "云端起意" : "复核起意";
    try {
      const r = await AiPhone.moments.post({ characterId: cx.character.id, hint: hint, createdAt: atMs });
      await log(cx, who + "发朋友圈 " + (r && r.postId ? "✓ " : "") + fmtHM(atMs) + "「" + hint + "」" + (r && r.postId ? "" : "——撞上近期重复内容，没发"));
      return true;
    } catch (e) { await log(cx, "发朋友圈失败：" + (e && e.message || e)); return false; }
  }
  // 云端 outbox：按 id 去重（回执前 App 可能多次拉到同一条），发过的记在 plan.postedIds；发不了（宿主太旧）留在 plan.outbox 原样带回云端。
  // 云端记的发圈账（momentsLast / momentsWeekN）也在这里并回来。
  async function consumeOutbox(cx, ctx) {
    const list = Array.isArray(ctx.outbox) ? ctx.outbox.filter((o) => o && o.id && o.hint) : [];
    const posted = Array.isArray(cx.plan.postedIds) ? cx.plan.postedIds.slice() : [];
    const fresh = list.filter((o) => posted.indexOf(o.id) < 0);
    const st = moState(cx);
    if (+ctx.momentsLast > st.lastAt || (+ctx.momentsWeekStart === st.weekStart && +ctx.momentsWeekN > st.weekN)) {
      await moNote(cx, +ctx.momentsLast || 0, +ctx.momentsWeekStart === st.weekStart ? +ctx.momentsWeekN : st.weekN);
    }
    if (!fresh.length) return;
    const left = [];
    for (const o of fresh) {
      if (!momentsReady()) { left.push(o); continue; }
      if (await postMoment(cx, o.hint, +o.at || Date.now(), "cloud")) posted.push(o.id); else left.push(o);
    }
    if (left.length && !momentsReady()) await log(cx, "云端起意发朋友圈 " + left.length + " 条没发出去：" + (S.settings.momentsOn ? "宿主版本太旧，没有发朋友圈接口" : "已关闭发朋友圈"));
    cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id, { postedIds: posted.slice(-20), outbox: left.slice(-5) });
  }
