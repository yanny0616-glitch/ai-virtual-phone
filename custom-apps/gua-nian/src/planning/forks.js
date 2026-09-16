  /* ---- 变数：生成日程时埋在某件事上的岔子，到点揭晓；发生了就改写当天后面的安排，说不说看关系 ---- */
  const FORK_SAY = { burst: "忍不住", hint: "聊到才说", keep: "憋着" };
  function forkSeedOf(cx) {
    return (cx.day && cx.day.forkSeed) || ((cx.day && cx.day.date) || todayStr()) + "|" + cx.character.id;
  }
  // 过去的日子挂念可能一整天没开、没结算过：按固定种子补算，和那天云端看到的一样
  function forkHits(day, cid) {
    if (!day || !Array.isArray(day.forks)) return [];
    const forks = day.date && day.date < todayStr()
      ? GuaNianForks.applyDueForks(day, "23:59", { seed: day.forkSeed || day.date + "|" + cid }).day.forks
      : day.forks;
    return forks.filter((f) => f && f.state === "hit");
  }
  function forkBrief(day) {
    const hits = forkHits(day, day.characterId);
    return hits.length ? "；那天碰上的事：" + hits.map((f) => f.what).join("；") : "";
  }
  function forkEffect(f) {
    const parts = [];
    if (f.add) parts.push("插进「" + f.add.title + "」");
    for (const m of f.move || []) parts.push(m.time + " 的" + (m.title || "安排") + "推到 " + m.to);
    for (const d of f.drop || []) parts.push("「" + (d.title || d.time) + "」不做了");
    return parts.join("，");
  }
  function forkBlock(f, it, open) {
    const eff = forkEffect(f) || (f.mood ? "心情变成「" + f.mood + "」" : "");
    const say = f.state
      ? FORK_SAY[f.say] + (f.say === "burst" && f.wakeAt ? " · " + fmtHM(f.wakeAt) + " 来找你" : "")
      : FORK_SAY[f.tell] || "";
    return '<div class="tl-var' + (f.state ? "" : " pre") + '" data-fid="' + esc(f.id) + '"' + (open ? "" : " hidden") + ">"
      + '<div class="vh">' + (f.state
        ? "✦ 变数 · " + esc(f.at) + "<i>已发生</i>"
        : "可能的岔子 · " + esc(addMin(it.time, +f.off || 0)) + " 揭晓<i>约 " + (+f.p || 0) + "%</i>") + "</div>"
      + '<div class="vt">' + esc(f.what) + "</div>"
      + (eff || say ? '<div class="vf">' + (eff ? "<span>" + (f.state ? "→ " : "发生了会：") + esc(eff) + "</span>" : "")
        + (say ? '<span class="say">' + esc(say) + "</span>" : "") + "</div>" : "")
      + "</div>";
  }
  async function revealForks(cx) {
    if (!cx.character || !cx.day || cx.day.date !== todayStr() || cx.busy || cx._planLock) return 0;
    if (!Array.isArray(cx.day.forks) || !cx.day.forks.some((f) => f && !f.state)) return 0;
    const nowMs = Date.now();
    const r = GuaNianForks.applyDueForks(cx.day, fmtHM(nowMs), {
      seed: forkSeedOf(cx), score: cx.aff ? cx.aff.score : undefined, at: (hm) => timeToMs(hm, nowMs),
    });
    if (!r.revealed.length) return 0;
    cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
      { schedule: r.day.schedule, conds: r.day.conds, forks: r.day.forks });
    const hits = r.revealed.filter((f) => f.state === "hit");
    for (const f of r.revealed) {
      await log(cx, f.state === "hit" ? "变数 · " + f.at + " 发生了：" + f.what + (forkEffect(f) ? "（" + forkEffect(f) + "）" : "") + "，" + FORK_SAY[f.say]
        : f.state === "miss" ? "变数 · " + f.at + " 没发生，「" + f.item + "」平平过去"
        : "变数作废：「" + f.item + "」已经不在今天的日程里");
    }
    if (hits.some((f) => f.add || (f.move || []).length || (f.drop || []).length)) {
      await syncCalendar(cx, await readTodayCalendar(cx)).catch(() => { /* 系统日程写不进不影响挂念自己的日程 */ });
    }
    for (const f of hits) {
      if (f.say === "burst") await forkBurst(cx, f, nowMs).catch((e) => log(cx, "变数：约主动消息失败——" + (e && e.message || e)));
    }
    await syncChatContext(cx, true);
    if (hits.length) { cx.archive = null; render(); }
    return hits.length;
  }
  // 忍不住：过一会儿主动来说，走心动时刻的预约，照样占额度、守免打扰和睡眠；约不上就退成聊到才说
  async function forkBurst(cx, f, nowMs) {
    if (!owns(cx) || serverBrainOn()) return;
    const settle = async (patch, note) => {
      cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        { forks: (cx.day.forks || []).map((x) => x.id === f.id ? { ...x, ...patch } : x) });
      await log(cx, note);
    };
    const hint = (why) => settle({ say: "hint", sayNote: why }, "变数：想马上跟你说「" + f.label + "」，但" + why + "，改成聊到再说");
    if (!S.settings.forkBurst) return hint("你关了「忍不住时主动来说」");
    if (!cx.plan || !AiPhone.push || !AiPhone.push.wake) return hint("今天的心动还没编排");
    const revealMs = timeToMs(f.at, nowMs) || nowMs;
    if (nowMs - revealMs > 90 * 60000) return hint("那阵劲儿已经过了");
    const anchor = (cx.day.schedule || []).find((it) => !it.fork && it.title === f.item);
    const busyEnd = anchor && anchor.end && isBusyItem(anchor) ? timeToMs(anchor.end, nowMs) || 0 : 0;
    const wait = (8 + GuaNianForks.forkRoll(forkSeedOf(cx) + "|" + f.id + "|wait") % 18) * 60000;
    const fireAt = Math.max(Math.max(revealMs, busyEnd) + wait, nowMs + 3 * 60000);
    const hm = fmtHM(fireAt);
    if (inQuiet(hm) || asleepAt(cx.day, hm)) return hint("赶上免打扰或睡觉的时候");
    const items = (cx.plan.items || []).slice();
    if (GuaNianPromises.ordinaryQuota(items) >= S.settings.quota) return hint("今天的主动额度用完了");
    if (items.some((w) => w.act && w.kind !== "promise" && w.fireAt > nowMs && Math.abs(w.fireAt - fireAt) < 20 * 60000)) return hint("正好挨着一个想找你的时刻");
    const intent = "刚碰上一件事：" + f.what + "——憋不住想跟用户说说";
    const res = await AiPhone.push.wake({ characterId: cx.character.id, fireAt, intent, source: "tool", cooldownRounds: S.settings.maxUnanswered });
    items.push({
      time: hm, fireAt, until: fireAt + 3 * 3600000, source: "变数·" + f.label, act: true, adj: "fork",
      why: f.what.slice(0, 20), intent, delivery: res.armed ? "push" : "local", reason: res.reason || "", wakeId: res.id,
      sem: "分享", topic: f.label, from: "", score: calcScore(fireAt, GuaNianPromises.ordinaryQuota(items), 0, 0),
      hist: [{ at: nowMs, kind: "fork", note: f.what }],
    });
    items.sort((a, b) => a.fireAt - b.fireAt);
    cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id, { items });
    await settle({ wakeAt: fireAt }, "变数：憋不住，" + hm + " 来找你说「" + f.label + "」");
    uploadPlanCloud(cx, false).catch(() => { /* 同步结果在页面上显示 */ });
  }
