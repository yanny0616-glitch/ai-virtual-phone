  /* ---- 日程条目详情：细化 / 重新生成 / 删除 ---- */
  function schedDetailHtml(i) {
    const cx = cur();
    const it = ((cx.day && cx.day.schedule) || [])[i];
    if (!it) return '<div class="kvs">' + kv("这条日程", "已经不在了", "dim") + "</div>";
    const cost = +it.cost || 0;
    const w = cx.plan && (cx.plan.items || []).find((x) => x.time === it.time);
    return '<div class="kvs">'
      + kv("时间", esc(it.time) + (it.end ? " – " + esc(it.end) : ""))
      + kv("这件事", esc(it.title))
      + (it.note ? kv("细节", esc(it.note)) : "")
      + (it.from === "chat" ? kv("这条哪来的", "聊天里" + esc(it.why || "说定的"), "hi") : "")
      + (it.mood ? kv("做完之后的情绪", esc(it.mood), "hi") : "")
      + kv("精力影响", cost ? (cost > 0 ? "回血 +" + cost : "消耗 " + cost) : "没什么影响", cost ? "" : "dim")
      + kv("做完之后", esc(String(energyAt(cx.day, timeToMs(it.time) || Date.now()))) + "% 精力")
      + (w ? kv("挂着的心动时刻", (w.act ? "♥ " : "○ ") + esc(w.intent || w.why || ""), w.act ? "hi" : "dim") : "")
      + "</div>"
      + (it.detail ? '<div class="d-sec"><div class="d-t">细 化</div><div class="d-why">' + esc(it.detail) + "</div></div>" : "")
      + (Array.isArray(it.steps) && it.steps.length
        ? '<div class="d-sec"><div class="d-t">细 排</div>' + it.steps.map((x) =>
            '<div class="step"><span class="tm">' + esc(x.time) + "</span><span>" + esc(x.what) + "</span></div>").join("") + "</div>"
        : "")
      + '<div class="sd-ask"><button class="ghost-btn" id="sd-steps" style="width:100%">'
      + (Array.isArray(it.steps) && it.steps.length ? "↻ 重新细排这段时间" : "⋯ 细排这段时间在做什么") + "</button>"
      + '<input id="sd-ask" style="margin-top:10px" placeholder="想怎么改？例如「改成下午、别那么累」；留空就让TA自己换个写法">'
      + '<div class="row"><button class="ghost-btn" id="sd-refine">↻ 重新生成这一条</button>'
      + '<button class="tgl" id="sd-del">删除这一条</button></div></div>';
  }
  function reopenSchedDetail(i) {
    const cx = cur();
    if (!document.body.classList.contains("dsheet-open") || S._detailSi < 0) return;
    S._detailSi = i;
    $("#dsheet-body").innerHTML = schedDetailHtml(i);
    bindSchedDetail(i);
  }
  function openSchedDetail(i) {
    const cx = cur();
    S._detailW = null; S._detailSi = i;
    $("#dsheet-title").textContent = "日 程 详 情";
    $("#dsheet-body").innerHTML = schedDetailHtml(i);
    document.body.classList.add("dsheet-open");
    bindSchedDetail(i);
  }
  function bindSchedDetail(i) {
    const cx = cur();
    const rf = $("#sd-refine"), dl = $("#sd-del"), st = $("#sd-steps");
    if (st) st.onclick = () => {
      st.disabled = true; st.textContent = "细排中…";
      refineSchedSteps(cx, i)
        .then((ni) => { reopenSchedDetail(ni >= 0 ? ni : i); })
        .catch((e) => { toast("细排不出来：" + (e && e.message || e)); reopenSchedDetail(i); });
    };
    if (rf) rf.onclick = () => {
      const ask = ($("#sd-ask") && $("#sd-ask").value || "").trim();
      rf.disabled = dl.disabled = true; rf.textContent = "重写中…";
      // 重写后时间可能变，这一条在 schedule 里的下标跟着变，得用返回的新下标重画
      refineSchedItem(cx, i, ask)
        .then((ni) => { reopenSchedDetail(ni >= 0 ? ni : i); })
        .catch((e) => { toast("改不动：" + (e && e.message || e)); reopenSchedDetail(i); });
    };
    if (dl) dl.onclick = () => {
      const sched = (cx.day && cx.day.schedule) || [];
      const it = sched[i]; if (!it) return;
      if (dl.dataset.sure !== "1") { dl.dataset.sure = "1"; dl.textContent = "再点一次删掉"; return; }
      const rest = sched.slice(0, i).concat(sched.slice(i + 1));
      closeDetail();
      saveSchedule(cx, rest, "删掉了「" + it.title + "」").catch((e) => toast("删不掉：" + (e && e.message || e)));
    };
  }
  // 改完日程照旧写回系统日程（清掉自己写入的、保留手动条目），但不自动重排：
  // 重排要花一次模型调用，还会取消已挂的预约，得用户自己按
  async function saveSchedule(cx, sched, note, planStale) {
    sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
      { date: todayStr(), characterId: cx.character.id, schedule: sched });
    try { await syncCalendar(cx, await readTodayCalendar(cx)); } catch (e) { await log(cx, "日程改动写回系统日程失败：" + (e && e.message || e)); }
    await log(cx, note);
    await syncChatContext(cx);
    await pullCloudDecisions(cx); // 同 recheck：不先并会把云端回填的 wakeId 盖掉
    await uploadPlanCloud(cx, false);
    render();
    toast(planStale === false || liveMode() ? note : note + "；心动时刻还是按旧日程排的，要跟上就点「♥ 重新编排」");
  }
  async function refineSchedItem(cx, i, ask) {
    const sched = ((cx.day && cx.day.schedule) || []).slice();
    const it = sched[i]; if (!it) return -1;
    const others = sched.filter((x, k) => k !== i).map((x) => ({ time: x.time, title: x.title }));
    const d = await generateJson(cx, {
      characterId: cx.character.id,
      appTags: ["companion", "daily"],
      instruction: [
        "【后台系统任务，不是聊天：不要以角色口吻说话，不要解释，只输出 JSON】",
        "以当前角色的人设、作息和职业为依据，改写TA今天日程里的这一条。",
        "当前这条：" + JSON.stringify({ time: it.time, title: it.title, note: it.note || "", cost: +it.cost || 0 }),
        "同一天其余日程（不要撞时间、不要写成重复的事）：" + JSON.stringify(others),
        ask ? "用户的要求：" + ask : "没有具体要求，换一个更贴合TA的写法，时间可以微调。",
        '输出严格 JSON，第一个字符必须是 {：{"time":"HH:MM","title":"日程标题（8字内）","place":"做这件事时人在哪（6字内：家里书房/公司/地铁上/医院）","note":"一句具体的细节","mood":"做完之后TA的情绪（8字内）","detail":"这件事的细化描写（60字内，写具体发生了什么、TA注意到了什么，第三人称）","cost":这件事做完对精力的影响-40到40的整数}',
        "cost 负数=消耗（开会、通勤、应酬、体力活），正数=回血（午睡、吃饭、散步、发呆），平淡的事给 0。",
        "mood 用可感的状态词（清爽、松弛、专注、疲惫、烦躁、雀跃、低落、发紧、放空）带一点原因或身体感受，要和 cost 对得上。",
      ].filter(Boolean).join("\n"),
    });
    const time = normHM(pickField(d, ["time", "时间", "at"])) || it.time;
    sched[i] = {
      time: time,
      title: String(pickField(d, ["title", "标题", "事项", "name"]) || it.title),
      place: String(pickField(d, ["place", "地点", "位置", "在哪"]) || it.place || "").slice(0, 16),
      note: String(pickField(d, ["note", "备注", "细节", "desc"]) || ""),
      mood: String(pickField(d, ["mood", "情绪", "心情"]) || it.mood || "").slice(0, 24),
      detail: String(pickField(d, ["detail", "细化", "描写"]) || "").slice(0, 200),
      cost: Math.max(-40, Math.min(40, Math.round(+pickField(d, ["cost", "精力影响", "消耗"]) || 0))),
    };
    const moved = sched[i];
    await saveSchedule(cx, sched, "重写了 " + it.time + "「" + it.title + "」→ " + moved.time + "「" + moved.title + "」");
    return ((cx.day && cx.day.schedule) || []).findIndex((x) => x.time === moved.time && x.title === moved.title);
  }

  // 聊天里说定 / 取消的安排，直接落到今天的日程上。只动还没到点的条目：
  // 过去的日程已经计进精力账了，回头改等于篡改已经发生的事。
  async function applyChatSchedEdits(cx, raw, nowMs) {
    if (!S.settings.chatEditsDay || !Array.isArray(raw) || !raw.length || !cx.day) return;
    const sched = ((cx.day && cx.day.schedule) || []).slice();
    const nowHM = fmtHM(nowMs);
    let touched = 0;
    for (const x of raw.slice(0, 2)) {
      const op = String(x && x.op || "").toLowerCase();
      const why = String(x && x.why || "聊天里说定的").slice(0, 20);
      if (op === "add") {
        const at = normHM(x.newTime) || normHM(x.time);
        const title = String(x.title || "").slice(0, 16);
        if (!at || at <= nowHM || !title || sched.some((y) => y.time === at)) continue;
        sched.push({
          time: at, title: title, note: String(x.note || "").slice(0, 40),
          mood: String(x.mood || "").slice(0, 24),
          cost: Math.max(-40, Math.min(40, Math.round(+x.cost || 0))),
          from: "chat", why: why,
        });
        touched++;
        await log(cx, "聊天改日程：新增 " + at + "「" + title + "」——" + why);
        continue;
      }
      const hm = normHM(x && x.time);
      const k = hm ? sched.findIndex((y) => y.time === hm) : -1;
      if (k < 0 || sched[k].time <= nowHM) continue;
      if (op === "drop") {
        await log(cx, "聊天改日程：删掉 " + hm + "「" + sched[k].title + "」——" + why);
        sched.splice(k, 1); touched++;
      } else if (op === "move") {
        const at = normHM(x.newTime);
        if (!at || at <= nowHM || sched.some((y) => y.time === at)) continue;
        const moved = Object.assign({}, sched[k], { time: at, from: "chat", why: why });
        delete moved.steps; // 细排是按原时段排的，挪了时间就不再成立
        sched[k] = moved; touched++;
        await log(cx, "聊天改日程：" + hm + "「" + moved.title + "」挪到 " + at + "——" + why);
      }
    }
    if (touched) await saveSchedule(cx, sched, "聊天里的事改了 " + touched + " 条日程", false);
  }

  // 细排：把这条日程占的那段时间拆成几件具体在做的事。结束时间取下一条日程，
  // 没有下一条就按 60 分钟算——和 syncCalendar 写回系统日程时的口径一致。
  async function refineSchedSteps(cx, i) {
    const sched = ((cx.day && cx.day.schedule) || []).slice();
    const it = sched[i]; if (!it) return -1;
    const nx = sched[i + 1];
    const end = (it.end && it.end > it.time) ? it.end : (nx && nx.time > it.time) ? nx.time : addMin(it.time, 60);
    const d = await generateJson(cx, {
      characterId: cx.character.id,
      appTags: ["companion", "daily"],
      instruction: [
        "【后台系统任务，不是聊天：不要以角色口吻说话，不要解释，只输出 JSON】",
        "把当前角色今天日程里的这一条，按时间拆成这段时间里TA具体在做的几件事。",
        "这条日程：" + JSON.stringify({ time: it.time, title: it.title, note: it.note || "", mood: it.mood || "" }),
        "时间段：" + it.time + " 到 " + end + "，每条的时间都要落在这个区间里，按先后排列。",
        "写TA真实会做的琐碎动作、和当下会注意到的东西；不要复述标题，不要写空泛的心理独白。",
        '输出严格 JSON，第一个字符必须是 {：{"steps":[{"time":"HH:MM","what":"这会儿在做什么（16字内）"}]}',
        "steps 给 3 到 5 条。",
      ].join("\n"),
    });
    const raw = pickField(d, ["steps", "细排", "分解"]);
    if (!Array.isArray(raw)) throw new Error("模型没给出 steps");
    const steps = raw.slice(0, 6).map((x) => ({
      time: normHM(pickField(x, ["time", "时间"])) || it.time,
      what: String(pickField(x, ["what", "事", "内容", "title"]) || "").slice(0, 30),
    })).filter((x) => x.what).sort((a, b) => a.time.localeCompare(b.time));
    if (!steps.length) throw new Error("模型给的 steps 是空的");
    sched[i] = Object.assign({}, it, { steps: steps });
    await saveSchedule(cx, sched, "细排了 " + it.time + "「" + it.title + "」" + steps.length + " 条", false);
    return ((cx.day && cx.day.schedule) || []).findIndex((x) => x.time === it.time && x.title === it.title);
  }
