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
  async function publishMoments(cx) {
    if (!cx.character || !AiPhone.variables || !AiPhone.variables.set) return;
    const opts = { scope: "character", characterId: cx.character.id };
    try {
      if (!momentsReady()) { await AiPhone.variables.unset("moments", opts); return; }
      const st = moState(cx);
      await AiPhone.variables.set("moments", { by: "gua-nian", at: Date.now(), weeklyTarget: S.settings.momentsWeekly, minGapHours: S.settings.momentsGapH, lastPostAt: st.lastAt, weekN: st.weekN }, opts);
    } catch (e) { /* 变量池不可用就算了 */ }
  }
  function momentRecords(cx) {
    return ((S.settings.momentHistory || {})[cx.character.id] || []).slice();
  }
  async function saveMomentRecord(cx, record) {
    await patchSettings((s) => {
      const records = ((s.momentHistory || {})[cx.character.id] || []).slice();
      const previous = records.find(item => item.id === record.id);
      const next = records.filter(item => item.id !== record.id).concat(record).slice(-60);
      const patch = { momentHistory: Object.assign({}, s.momentHistory, { [cx.character.id]: next }) };
      if (record.status === "sent" && (!previous || previous.status !== "sent")) {
        const st = moState(cx);
        patch.momentsState = Object.assign({}, s.momentsState, { [cx.character.id]: {
          lastAt: Math.max(st.lastAt, record.at), weekStart: st.weekStart, weekN: st.weekN + 1,
        } });
      }
      return patch;
    });
    cx.archive = null;
  }
  async function postMoment(cx, hint, atMs, by, requestId) {
    hint = String(hint || "").trim().slice(0, 120);
    if (!hint || !cx.character || !momentsReady() || cx._momentBusy) return false;
    const id = requestId || "local:" + atMs;
    const previous = momentRecords(cx).find(item => item.id === id);
    if (previous && ["sent", "skipped"].includes(previous.status)) return true;
    const record = { id, hint, by, intendedAt: atMs, at: Date.now() };
    if (!moCanPost(cx)) {
      await saveMomentRecord(cx, { ...record, status: "pending", note: "等待发圈间隔或周额度恢复" });
      return false;
    }
    cx._momentBusy = true;
    try {
      await saveMomentRecord(cx, { ...record, status: "pending", note: "正在生成，尚未确认发布" });
      // 用实际发布时间；旧起意时间单独留在记录里，避免补发伪装成早已发布。
      const r = await AiPhone.moments.post({ characterId: cx.character.id, hint, createdAt: record.at, requestId: id });
      if (!r || !r.postId) {
        await saveMomentRecord(cx, { ...record, status: "skipped", note: "宿主未创建帖子，可能内容重复或生成未完成" });
        await log(cx, "朋友圈未发布：「" + hint + "」，宿主未返回帖子编号");
        return true;
      }
      await saveMomentRecord(cx, { ...record, status: "sent", postId: r.postId, note: "已取得帖子编号" });
      await publishMoments(cx);
      await log(cx, "发朋友圈 ✓ " + fmtHM(record.at) + "「" + hint + "」");
      return true;
    } catch (e) {
      const note = String(e && e.message || e).slice(0, 200);
      await saveMomentRecord(cx, { ...record, status: "failed", note });
      await log(cx, "发朋友圈失败：" + note);
      return false;
    } finally { cx._momentBusy = false; }
  }
  // 一次只考虑最新的一条云端起意；旧起意合并为未发布记录，不集中补发。
  async function consumeOutbox(cx, ctx) {
    if (!cx.plan || cx._outboxBusy) return;
    cx._outboxBusy = true;
    try {
      const list = Array.isArray(ctx.outbox) ? ctx.outbox.filter(o => o && o.id && o.hint) : [];
      const posted = Array.isArray(cx.plan.postedIds) ? cx.plan.postedIds.slice() : [];
      for (const o of list) {
        if (momentRecords(cx).some(r => r.id === "cloud:" + o.id && ["sent", "skipped"].includes(r.status)) && !posted.includes(o.id)) posted.push(o.id);
      }
      const fresh = [...new Map(list.filter(o => !posted.includes(o.id)).map(o => [o.id, o])).values()]
        .sort((a, b) => (+b.at || 0) - (+a.at || 0));
      if (!fresh.length) {
        if (list.length) cx.plan = await upsert("plans", x => x.date === todayStr() && x.characterId === cx.character.id,
          { postedIds: posted.slice(-60), outbox: [] });
        return;
      }
      const latest = fresh[0];
      const left = [];
      for (const o of fresh.slice(1)) {
        await saveMomentRecord(cx, { id: "cloud:" + o.id, hint: String(o.hint).slice(0, 120), by: "cloud",
          intendedAt: +o.at || 0, at: Date.now(), status: "skipped", note: "积压起意已合并，仅保留最新一条" });
        posted.push(o.id);
      }
      // 云端的 momentsLast/WeekN 是预留起意，不是已发布回执；不能并成已发数量。
      if (!momentsReady()) {
        left.push(latest);
        await saveMomentRecord(cx, { id: "cloud:" + latest.id, hint: String(latest.hint).slice(0, 120), by: "cloud",
          intendedAt: +latest.at || 0, at: Date.now(), status: "pending", note: "发圈已关闭或宿主接口不可用" });
      } else if (await postMoment(cx, latest.hint, +latest.at || Date.now(), "cloud", "cloud:" + latest.id)) posted.push(latest.id);
      else left.push(latest);
      cx.plan = await upsert("plans", x => x.date === todayStr() && x.characterId === cx.character.id,
        { postedIds: posted.slice(-60), outbox: left });
    } finally { cx._outboxBusy = false; }
  }
