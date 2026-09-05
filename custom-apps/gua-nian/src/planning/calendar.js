  /* ================= 系统日程互通 ================= */
  async function readTodayCalendar(cx) { return readCalendarOn(cx, todayStr()); }
  // 日程表条目标题末尾写「·忙」或「·闲」，就是你替TA定死了做这件事时顾不顾得上看手机
  function lockOfTitle(title) {
    const m = /^(.*?)\s*[·・]\s*(忙|闲)\s*$/.exec(String(title || ""));
    return m ? { title: m[1], lock: m[2] === "忙" ? "busy" : "free" } : { title: String(title || ""), lock: "" };
  }
  const addMin = GuaNianTime.addMinutes;
  async function syncCalendar(cx, existing) {
    // 先清掉本 app 之前写入的今日条目，再把新生成的一天写回系统日程
    for (const it of existing) {
      if (/^guanian_/.test(it.id)) {
        try { await AiPhone.calendar.write({ operation: "delete", ownerType: "character", ownerId: cx.character.id, date: todayStr(), itemId: it.id }); } catch (e) { /* 忽略 */ }
      }
    }
    const keep = existing.filter((it) => !/^guanian_/.test(it.id));
    let wrote = 0, firstErr = "";
    const sched = cx.day.schedule;
    for (let i = 0; i < sched.length; i++) {
      const it = sched[i];
      if (!/^\d{1,2}:\d{2}$/.test(it.time)) { if (!firstErr) firstErr = "时间格式不认识：「" + it.time + "」"; continue; }
      if (keep.some((k) => k.startTime === it.time)) continue; // 日程表里已有的安排不重复写
      const end = (it.end && it.end > it.time) ? it.end : (i + 1 < sched.length && sched[i + 1].time > it.time) ? sched[i + 1].time : addMin(it.time, 60);
      try {
        await AiPhone.calendar.write({
          ownerType: "character", ownerId: cx.character.id, date: todayStr(),
          id: "guanian_" + todayStr().replace(/-/g, "") + "_" + i,
          startTime: it.time, endTime: end, title: it.title, location: "", source: "generated",
        });
        wrote++;
      } catch (e) { if (!firstErr) firstErr = String(e && e.message || e); }
    }
    if (!wrote && sched.length && firstErr) await log(cx, "写回系统日程 0 条，首个原因：" + firstErr);
    return wrote;
  }

  /* ================= 核心：生成今天 ================= */
  // 到点自动生成。一天只试一次：失败了留给用户手动按，别每分钟烧一次模型调用。
  async function maybeAutoGen(cx) {
    if (!S.settings || !S.settings.autoGen || !cx.character || cx.day || cx.busy || !owns(cx)) return;
    const at = S.settings.autoGenAt || SET_DEF.autoGenAt;
    if (fmtHM(Date.now()) < at) return;
    if (cx._autoGenDay === todayStr()) return;
    if (cloudGenOn()) {
      // 生成交给了云端：到点后每分钟看一眼有没有生成好；45 分钟还没等到就本地补，别让今天空着
      if (await adoptCloudDay(cx)) { cx._autoGenDay = todayStr(); return; }
      if (fmtHM(Date.now()) < addMin(at, 45)) return;
      await log(cx, "云端到点没生成（设定 " + at + "，等了 45 分钟），本地补生成");
    }
    cx._autoGenDay = todayStr();
    await log(cx, "到点自动生成TA的一天（设定 " + (S.settings.autoGenAt || SET_DEF.autoGenAt) + "）");
    await generateDay(cx);
  }
  // 日历现实：身份决定默认作息，日历决定今天这套作息到底发不发生
  const CN_HOLIDAYS = { "01-01": "元旦", "02-14": "情人节", "03-08": "妇女节", "05-01": "劳动节", "05-04": "青年节", "06-01": "儿童节", "10-01": "国庆", "10-31": "万圣节", "11-11": "双十一", "12-24": "平安夜", "12-25": "圣诞", "12-31": "跨年夜" };
  function calendarReality(d) {
    const m = d.getMonth() + 1, day = d.getDate(), wd = d.getDay();
    const tags = [];
    if (wd === 0 || wd === 6) tags.push("周末");
    const h = CN_HOLIDAYS[pad(m) + "-" + pad(day)] || (m === 10 && day <= 7 ? "国庆假期" : "");
    if (h) tags.push(h);
    if (m === 7 || m === 8) tags.push("学校放暑假"); else if ((m === 1 && day >= 15) || (m === 2 && day <= 20)) tags.push("学校放寒假、春节前后");
    const season = m === 12 || m <= 2 ? "冬" : m <= 5 ? "春" : m <= 8 ? "夏" : "秋";
    return { label: d.getFullYear() + "-" + pad(m) + "-" + pad(day) + " 周" + "日一二三四五六"[wd] + (tags.length ? "（" + tags.join("、") + "）" : ""), season: season };
  }
  // 前几天的生活面：给模型看骨架防止天天一样，也让昨天开了头的事今天有下文
