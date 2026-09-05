  /* ================= 惦记账本：跨天记住话头、约定、日子 =================
     一行一件事 { id, kind: topic|promise|date, text, due, yearly, since, at, by, done, nudge }。
     云端 push-recheck 有 threadAlive / threadDueMs / threadLines 的 tz 算术版副本，改这里要同步那边。 */
  const THREAD_KIND = { topic: "话头", promise: "约定", date: "日子" };
  function threadAlive(t, nowMs, days) {
    if (!t || !t.text) return false;
    if (t.done) return nowMs - (+t.at || 0) < 7 * 86400000; // 了结的留一周，「已了结」里还能翻回来恢复
    const due = +t.due || 0;
    if (t.kind === "date") return t.yearly ? true : (due ? nowMs < due + 86400000 : false);
    if (t.kind === "promise") return due ? nowMs < due + 86400000 : nowMs - (+t.since || 0) < 7 * 86400000;
    return nowMs - (+t.at || +t.since || 0) < (days || 3) * 86400000;
  }
  // 每年的日子折算到最近的一次
  function threadDueMs(t, nowMs) {
    const due = +t.due || 0;
    if (!due || !t.yearly) return due;
    const d = new Date(due), n = new Date(nowMs);
    d.setFullYear(n.getFullYear());
    if (d.getTime() < nowMs - 86400000) d.setFullYear(n.getFullYear() + 1);
    return d.getTime();
  }
  function threadWhen(t, nowMs) {
    const due = threadDueMs(t, nowMs);
    if (!due) return "";
    const diff = due - nowMs, d = new Date(due), n = new Date(nowMs);
    const hm = t.kind === "date" ? "" : " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (t.kind !== "date" && Math.abs(diff) < 3600000) return "就在这会儿";
    if (sameDay(d, n)) return "今天" + hm;
    if (diff < 0) return diff > -86400000 * 1.5 ? "昨天" + hm : Math.round(-diff / 86400000) + " 天前";
    if (sameDay(d, new Date(nowMs + 86400000))) return "明天" + hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + hm + " · " + Math.round(diff / 86400000) + " 天后";
  }
  // 「几天前」：详情里说清这条是什么时候记下的
  function dateBrief(ms) {
    const d = Math.floor((Date.now() - (+ms || 0)) / 86400000);
    if (d <= 0) return "今天";
    if (d === 1) return "昨天";
    if (d < 30) return d + " 天前";
    const t = new Date(+ms);
    return (t.getMonth() + 1) + "/" + t.getDate();
  }
  function liveThreads(cx, nowMs) {
    const now = nowMs || Date.now();
    return (cx.threads || []).filter((t) => !t.done && threadAlive(t, now, S.settings.threadDays));
  }
  function threadPace(t, nowMs) {
    if (t.kind === "topic" && nowMs - (+t.since || 0) < 4 * 3600000) return "刚记下，先别提";
    if (/said:/.test(String(t.nudge || "")) && nowMs - (+t.at || 0) < 36 * 3600000) return "刚提过，先别再提";
    return "";
  }
  function threadLines(cx, nowMs) {
    const now = nowMs || Date.now();
    return liveThreads(cx, now).slice(0, 12).map((t) => {
      const notes = [threadWhen(t, now), threadPace(t, now)].filter(Boolean);
      return "[" + t.id + "] " + (THREAD_KIND[t.kind] || "话头") + "·" + t.text + (notes.length ? "（" + notes.join("，") + "）" : "");
    });
  }
  const THREAD_TASK = "惦记账本：上面带 [id] 的是TA心里还挂着的事。keep 里写这次聊天里新冒出来、值得跨天记住的：没聊完的话头（topic）、约好或答应了的事（promise，when 给时间）、重要的日子（date，when 给日期）。只写用户明确说过的，随口一提的不算，账本里已有的不要重复写；一次最多 2 条。why 写为什么值得记（15字内，用户当时的原话或场景），面板上给用户看。settle 写已经了结、过时或说开了的 id：用户说某件事做完了、办好了、不做了、不用管了，对应那条必须写进 settle，别让它继续挂着。都没有就给空数组。";
  // 时刻上的 from 指向账本某条：模型给的 id 可能带方括号或是编的，这里核一遍
  function threadIdOf(cx, raw) {
    const id = String(raw || "").replace(/[\[\]\s]/g, "");
    return id && (cx.threads || []).some((t) => t.id === id) ? id : "";
  }
  /**
   * 发出去的时刻回写账本：话头说完就了结；约定和日子只标「提过了」——话还没说完，
   * 到点还得问结果，不该就此从心里划掉。没有这一步的话，账本要等模型下一轮自己想起来
   * settle，不 settle 就一直挂着，用户看到的是「明明聊过了还在惦记里」。
   */
  // 只认真说出去的才推进账本。凭据是云端预约自己的执行结果（result_note 以 generated / sent 开头），
  // 押后作罢、发送前拦下、睡着没发的都不算；没配云的本地预约拿不到结果，只能退回看聊天记录（粗）。
  // 云端按预约 id 精确查结果；暂未查到保留重试。本地的粗略聊天匹配最多等 6 小时。
  async function settleFired(cx) {
    if (!S.settings.threadsOn || !cx.plan || !Array.isArray(cx.plan.items) || !(cx.threads || []).length) return;
    const now = Date.now(), list = (cx.threads || []).slice(), notes = [];
    const due = cx.plan.items.filter((w) => w.act && w.from && w.fireAt < now && !w.thDone);
    if (!due.length) return;
    let jobs = null, said = null;
    if (cloudCfg()) {
      try {
        jobs = [];
        const keys = [...new Set(due.filter((w) => w.wakeId).map((w) => "timedwake:" + w.wakeId))];
        for (let i = 0; i < keys.length; i += 20) {
          const batch = keys.slice(i, i + 20);
          const jr = await cloudFetch("jobs", { method: "GET" }, { kind: "timed_task", triggerKeys: JSON.stringify(batch) });
          // 旧网关会忽略新参数仍回最近 20 条；未经确认的结果不能用来结算。
          if (!jr || !Array.isArray(jr.queriedTriggerKeys) || batch.some((key) => !jr.queriedTriggerKeys.includes(key))) {
            if (!cx._jobLookupWarned) { cx._jobLookupWarned = true; await log(cx, "预约结算等待更新个人云：请重新部署离线推送，以支持按预约查询结果"); }
            return;
          }
          jobs.push(...(jr.jobs || []));
        }
      }
      catch (e) { return; } // 读不到就下一分钟再看
    } else {
      said = (await readRecentChat(cx, 80)).filter((m) => m.role === "assistant").map((m) => m.t);
    }
    let marked = 0;
    for (const w of due) {
      let spoke = false;
      if (jobs) {
        const j = w.wakeId ? jobs.find((x) => x.triggerKey === "timedwake:" + w.wakeId) : null;
        if (j && (j.status === "pending" || j.status === "running")) continue; // 押后中
        if (!j) continue; // 查不到不等于没发送，不永久放弃这条。
        spoke = !!j && j.status === "done" && /^(generated|sent)/.test(String(j.resultNote || ""));
      } else {
        spoke = said.some((t) => t >= w.fireAt - 60000 && t <= w.fireAt + 6 * 3600000);
        if (!spoke && now - w.fireAt <= 6 * 3600000) continue;
      }
      w.thDone = true; marked++; // 只回写一次
      if (!spoke) continue;
      const t = list.find((x) => x.id === w.from);
      if (!t || t.done) continue;
      if (t.kind === "topic") { t.done = true; t.at = now; t.by = "app"; notes.push("说完了，了结「" + t.text + "」"); }
      else if (String(t.nudge || "").indexOf("said:") < 0) { t.nudge = (String(t.nudge || "") + " said:" + w.time).trim().slice(-200); t.at = now; notes.push("提过了「" + t.text + "」"); }
    }
    if (!marked) return;
    if (notes.length) await saveThreads(cx, list);
    cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id, { items: cx.plan.items });
    if (notes.length) await log(cx, "惦记账本：" + notes.join("，"));
  }
  // 了结或删掉一条惦记时，由它起的、还没到点的时刻一起撤掉——不然人在面板上把事划掉了，
  // 到点TA还照着这条由头发消息。
  async function dropThreadSlots(cx, id, why) {
    if (!cx.plan || !Array.isArray(cx.plan.items)) return 0;
    const now = Date.now(); let n = 0;
    for (const w of cx.plan.items) {
      if (w.from !== id || !w.act || w.fireAt <= now) continue;
      if (w.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ } }
      w.act = false; w.wakeId = ""; w.why = why;
      (w.hist = w.hist || []).push({ at: now, kind: "recheck", note: why });
      n++;
    }
    if (n) {
      cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id, { items: cx.plan.items });
      await log(cx, "惦记账本：" + why + "，撤掉 " + n + " 个时刻");
    }
    return n;
  }

  async function saveThreads(cx, list) {
    cx.threads = list;
    await upsert("threads", (x) => x.characterId === cx.character.id, { characterId: cx.character.id, items: list });
  }
  // 模型给的时间几种写法都收：2026-09-10 15:00 / 09-10 / 9月10日 / 15:00 / 明天 15:00
  function parseWhen(when, nowMs) {
    const w = String(when || "").trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(w);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0).getTime();
    m = /^(\d{1,2})[-/月](\d{1,2})日?$/.exec(w);
    if (m) { const d = new Date(new Date(nowMs).getFullYear(), +m[1] - 1, +m[2], 12, 0); if (d.getTime() < nowMs - 86400000) d.setFullYear(d.getFullYear() + 1); return d.getTime(); }
    m = /^(?:(今天|明天|后天)\s*)?(\d{1,2}):(\d{2})$/.exec(w);
    if (m) {
      const d = new Date(nowMs); d.setDate(d.getDate() + (m[1] === "明天" ? 1 : m[1] === "后天" ? 2 : 0)); d.setHours(+m[2], +m[3], 0, 0);
      if (!m[1] && d.getTime() < nowMs - 3600000) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    return 0;
  }
  function newThread(kind, text, due, nowMs, by, why) {
    return { id: "t" + Math.random().toString(36).slice(2, 6), kind, text, due, yearly: kind === "date" && /生日|纪念/.test(text), since: nowMs, at: nowMs, by, done: false, why: String(why || "").slice(0, 40) };
  }
  // 把复核回来的 keep / settle 并进账本
