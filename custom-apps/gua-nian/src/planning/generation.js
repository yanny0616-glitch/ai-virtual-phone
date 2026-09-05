  async function applyThreads(cx, parsed, nowMs, by) {
    if (!S.settings.threadsOn || !parsed) return 0;
    const list = (cx.threads || []).slice(), notes = [];
    for (const id of (Array.isArray(parsed.settle) ? parsed.settle : []).slice(0, 6)) {
      const t = list.find((x) => x.id === String(id).replace(/[\[\]]/g, "").trim());
      if (t && !t.done) { t.done = true; t.at = nowMs; t.by = by; notes.push("了结「" + t.text + "」"); }
    }
    for (const k of (Array.isArray(parsed.keep) ? parsed.keep : []).slice(0, 2)) {
      const text = String((k && k.text) || "").trim().slice(0, 60);
      if (!text) continue;
      const kind = THREAD_KIND[k.kind] ? k.kind : "topic";
      const dup = list.find((x) => !x.done && (x.text === text || x.text.includes(text) || text.includes(x.text)));
      if (dup) { dup.at = nowMs; continue; } // 又提起了：续命，不重复记
      const due = parseWhen(k.when, nowMs);
      if (kind !== "topic" && !due) continue; // 约定和日子没时间就不算
      list.push(newThread(kind, text, due, nowMs, by, (k && k.why) || ""));
      notes.push("记下" + THREAD_KIND[kind] + "「" + text + "」");
    }
    const alive = list.filter((t) => threadAlive(t, nowMs, S.settings.threadDays)).slice(-30);
    if (notes.length || alive.length !== list.length) await saveThreads(cx, alive);
    if (notes.length) await log(cx, "惦记账本：" + notes.join("，"));
    return notes.length;
  }

  async function recentDaysBrief(cx, n, forDate) {
    const upto = forDate || todayStr();
    try {
      const rows = await AiPhone.db.list("days", { limit: 60 });
      const past = (rows || []).filter((r) => r.characterId === cx.character.id && r.date && r.date < upto)
        .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, n || 5);
      const lines = past.map((r) => "- " + r.date + (r.mood ? " 心情「" + r.mood + "」" : "") + "："
        + ((r.schedule || []).map((it) => it.title).filter(Boolean).join("、") || "没生成日程")
        + (r.bed ? "（" + r.bed + " 睡）" : ""));
      const yd = dateOf(upto); yd.setDate(yd.getDate() - 1);
      const y = past.find((r) => r.date === yd.getFullYear() + "-" + pad(yd.getMonth() + 1) + "-" + pad(yd.getDate()));
      const residue = [];
      if (y && y.bed && y.bed < "06:00") residue.push("昨晚 " + y.bed + " 才睡");
      if (y && Array.isArray(y.conds)) {
        const c = y.conds.slice().sort((a, b) => (+b.startAt || 0) - (+a.startAt || 0))[0];
        if (c && c.mood) residue.push("昨天最后一次聊完的情绪「" + c.mood + "」（" + (c.cause || "聊天") + "）");
      }
      return { lines: lines, residue: residue };
    } catch (e) { return { lines: [], residue: [] }; }
  }
  // 生成指令：本地生成和云端生成（push-recheck 里有一份逐字对照的副本）共用这段文字，改这里要同步那边。
  function buildDayInstruction(cal, nowHM, past, existing, threads) {
    let inst = [
      "【后台系统任务，不是聊天：不要以角色口吻说话，不要解释，只输出 JSON】",
      "以当前角色的人设、职业、近期记忆和最近的聊天为依据，想象TA今天真实会过的一天：先定今天的身体底子和情绪底色，再排日程。",
      "今天：" + cal.label + "，" + cal.season + "季，现在时刻 " + nowHM + "。身份决定默认作息（学生上课、上班族通勤、店主开门），日历决定这套作息今天到底发不发生：周末、假期不上班不上课，除非人设是轮班、服务业、演艺这类越放假越忙的；季节要影响户外活动和穿着。夜猫子可以很晚睡，上早班的就得早起。",
      past.lines.length ? "前几天TA过的日子（别重复同一套骨架；昨天开了头的事今天要有下文，做完的事要有余韵；跨好几天的事——项目、备考、排练、等结果——按筹备、进行、收尾、余波的顺序往下走，让这几天连成线）：\n" + past.lines.join("\n") : null,
      past.residue.length ? "昨天留下的余波：" + past.residue.join("；") + "。睡得晚、聊得不痛快、约了事，都可以轻微影响今天的睡眠、精力、胃口和心情；但不要为了戏剧性硬让今天出事，可以毫无影响。" : null,
      threads && threads.length ? "TA心里还挂着这些事（约好在今天的必须落进 schedule；到日子的要影响今天的心情和安排；只是话头的不用硬排）：\n" + threads.join("\n") : null,
      "最近聊天里如果提过今天要发生的事、约好的事、没做完的承诺，必须落进 schedule；用户没明确说定的不要当真。",
      "输出严格 JSON，第一个字符必须是 {，不要代码块标记，字段名必须一字不差用下面这些：",
      '{"sleep":"昨晚睡得怎样（一句具体的：踏实/浅、半夜醒/失眠/一直做梦/赖床）","mood":"今天刚醒时的情绪底色（8字内，具体，不要「心情不错」这种空话）","moodEmoji":"一个最贴切的emoji","energy":今天刚醒来时的精力基线0到100的整数,"body":[{"label":"此刻身上的小状况（8字内：饿、胃口差、头闷、腰酸、犯困、嗓子哑之类）","mood":"它带来的情绪（4字内）","energy":对精力的影响-20到20的整数,"hours":大概几小时淡一半（1到12）}],"doing":"此刻正在做的事","location":"此刻所在的地点","wake":"今天起床的时刻HH:MM","bed":"今晚上床睡觉的时刻HH:MM（可以过零点，如 00:30）","schedule":[{"time":"HH:MM","end":"这件事大概结束的时刻HH:MM","title":"日程标题（8字内）","place":"做这件事时人在哪（6字内：家里书房/公司/地铁上/医院）","note":"一句具体的细节","mood":"做完这件事之后TA的情绪（8字内）","cost":这件事做完对精力的影响-40到40的整数,"busy":做这件事时顾不上看手机吗（上课/开会/开车/考试/训练/排练之类为true，吃饭/通勤/闲着/看剧为false）}]}',
      "body 是今天真实带在身上的状况，多数日子是空数组，最多两条；睡得不好、昨天太累、生病、天气才会有。",
      "情绪写法：用可感的状态词（迷糊、清爽、松弛、专注、疲惫、烦躁、雀跃、低落、发紧、放空、粘人）再带一点原因或身体感受，例如「开完会后脑子发紧」；一天里要有起伏，别每条都差不多；情绪要和 cost 对得上，耗神的事之后不该是「轻松」，回血的事之后不该是「疲惫」；底色 mood 要能从 sleep 和昨天的余波推出来。",
      "energy 是身体的电量，和情绪底色是两回事：心情差但睡饱了 energy 照样高，心情好但熬了夜 energy 照样低。不要把「今天不开心」「性格沉闷」翻译成「精力低」。",
      "energy 基线通常落在 55 到 85；只有生病、通宵、连着几天连轴转、或昨晚睡得很差，才低于 50。低于 40 是少见的坏日子，不该天天出现。",
      "cost 负数=消耗（开会、通勤、应酬、体力活），正数=回血（午睡、吃饭、散步、发呆），平淡的事给 0；一天累计下来别把人耗到负数太多。",
      "schedule 给 5 到 9 条，从起床后第一件事到睡前最后一件事；有主线也有琐碎，时间不均匀；不用把每个小时填满，事与事之间可以留空档（空档里TA就是自己待着）；有的日子轻（3、4 条），有的日子满；最后一件事结束到 bed 之间是TA自己的睡前时间；「睡觉」本身不要写成一条日程。",
    ].filter(Boolean).join("\n");
    if (existing.length) {
      inst += "\nTA的日程表上今天已经定了这些安排（必须原样出现在 schedule 里，时间与标题不要改动，带 busy 的照抄 busy，围绕它们补全其余的一天）：\n" +
        JSON.stringify(existing.map((it) => Object.assign({ time: it.startTime, title: it.title, note: it.location || "" }, it.lock ? { busy: it.lock === "busy" } : {})));
    }
    return inst;
  }
  // 把模型返回的 JSON 归一成 day 记录（不含 date/characterId）；云端 push-recheck 有逐字对照的副本，改这里要同步那边。
  function parseDayResult(d, existing, settings, nowMs) {
    const schedRaw = pickField(d, ["schedule", "日程", "日程表"]);
    if (!Array.isArray(schedRaw)) throw new Error("日程缺失（模型返回的字段：" + Object.keys(d || {}).slice(0, 10).join("/") + "）");
    const sched = schedRaw.slice(0, 10).map((it) => ({
      time: normHM(pickField(it, ["time", "时间", "at"])),
      end: normHM(pickField(it, ["end", "endTime", "结束", "到"])),
      title: String(pickField(it, ["title", "标题", "事项", "name"]) || ""),
      place: String(pickField(it, ["place", "地点", "位置", "在哪"]) || "").slice(0, 16),
      note: String(pickField(it, ["note", "备注", "细节", "desc"]) || ""),
      mood: String(pickField(it, ["mood", "情绪", "心情"]) || "").slice(0, 24),
      cost: Math.max(-40, Math.min(40, Math.round(+pickField(it, ["cost", "精力影响", "消耗"]) || 0))),
      busy: isTrue(pickField(it, ["busy", "顾不上", "忙"])),
    }));
    for (const it of existing) { // 模型漏掉的已定安排补回来；定死了忙闲的以日程表为准
      const hit = sched.find((x) => x.time === it.startTime);
      if (!hit) sched.push({ time: it.startTime, title: it.title, place: it.location || "", note: it.location || "日程表上的安排", busy: it.lock === "busy" });
      else if (it.lock) hit.busy = it.lock === "busy";
    }
    sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    for (const it of sched) if (it.end && it.end <= it.time) it.end = ""; // 结束早于开始的当没写
    // 模型没给作息时退到日程首尾：起床 = 第一件事，上床 = 最后一件事结束后半小时
    const last = sched[sched.length - 1];
    const wake = normHM(pickField(d, ["wake", "起床", "wakeUp"])) || (sched[0] && sched[0].time) || settings.quietEnd;
    // 身上的小状况走 conds 那条路：和聊天判出来的情绪一样按半衰期淡掉，精力和情绪都会自动算进去
    const bodyRaw = pickField(d, ["body", "身体", "状况"]);
    const bodyConds = (Array.isArray(bodyRaw) ? bodyRaw : []).slice(0, 2)
      .filter((b) => b && String(b.label || "").trim())
      .map((b) => ({
        mood: String(b.mood || b.label).trim().slice(0, 24),
        cause: String(b.label).trim().slice(0, 20),
        energyDelta: Math.max(-20, Math.min(20, Math.round(+b.energy || 0))),
        intensity: 60,
        halfLifeMin: Math.max(1, Math.min(12, Math.round(+b.hours || 4))) * 60,
        startAt: nowMs,
      }));
    const bed = normHM(pickField(d, ["bed", "睡觉", "bedtime"])) || (last ? addMin(last.end || last.time, last.end ? 30 : 90) : settings.quietStart);
    return {
      wake: wake, bed: bed,
      mood: String(pickField(d, ["mood", "心情", "情绪"]) || ""),
      moodEmoji: String(pickField(d, ["moodEmoji", "emoji", "表情"]) || "🌙").slice(0, 4),
      energy: Math.max(0, Math.min(100, +pickField(d, ["energy", "精力", "体力"]) || 60)),
      doing: String(pickField(d, ["doing", "正在做", "当前"]) || ""),
      location: String(pickField(d, ["location", "位置", "地点"]) || ""),
      sleep: String(pickField(d, ["sleep", "睡眠", "昨晚"]) || "").slice(0, 40),
      schedule: sched,
      conds: bodyConds,
    };
  }
  async function generateDay(cx) {
    if (cx.busy || cx._planLock) { if (cx._planLock) toast("TA正在复核，稍等几秒再试"); return; }
    if (!await claimOwner(cx)) { toast("今天由「" + ownerLabel(cx) + "」负责，要改用这台就去诊断页「今天谁在管」"); render(); return; }
    cx.busy = true; cx._planLock = true; render();
    try {
      const existing = await readTodayCalendar(cx); // 日程 app 里TA今天已定的安排
      const cal = calendarReality(new Date());
      const past = await recentDaysBrief(cx, 7);
      const inst = buildDayInstruction(cal, fmtHM(Date.now()), past, existing, S.settings.threadsOn ? threadLines(cx) : []);
      const d = await generateJson(cx, {
        characterId: cx.character.id,
        appTags: ["companion", "daily"],
        instruction: inst,
      });
      const parsed = parseDayResult(d, existing, S.settings, Date.now());
      const sched = parsed.schedule, wake = parsed.wake, bed = parsed.bed, bodyConds = parsed.conds;
      cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        Object.assign({ date: todayStr(), characterId: cx.character.id, by: "local" }, parsed));
      const wrote = await syncCalendar(cx, existing);
      await log(cx, "生成今日生活面：" + sched.length + " 条日程（日程表已定 " + existing.length + " 条，写回系统日程 " + wrote + " 条），作息 " + wake + " 起 " + bed + " 睡，心情「" + cx.day.mood + "」" + (cx.day.sleep ? "，昨晚" + cx.day.sleep : "") + (bodyConds.length ? "，身上：" + bodyConds.map((c) => c.cause).join("、") : "")
        + (cx.day.mood ? "" : "（心情为空，模型顶层字段：" + Object.keys(d || {}).slice(0, 10).join("/") + "）"));
      cx.busy = false; cx._planLock = false;
      await orchestrate(cx); // 生活面就绪后立即编排心动时刻
      await syncChatContext(cx, true);
    } catch (e) {
      cx.busy = false; cx._planLock = false;
      toast("生成失败：" + (e && e.message || e));
      await log(cx, "生成今日失败：" + (e && e.message || e));
      render();
    }
  }

  // 起念判断的指令：本地编排和云端生成后的编排共用这段文字（push-recheck 有逐字副本），改这里要同步那边。
  function buildImpulseInstruction(day, outlook, nowHM, lines, settings, biasLine, threads) {
    const anchors = [
      settings.anchorMorning ? "早上刚过免打扰那会儿，TA可能会想问一句早" : null,
      settings.anchorSleep ? "睡前那段，TA可能会想说句晚安或白天没说完的话" : null,
    ].filter(Boolean);
    return [
      "【后台系统任务，不是聊天：不要以角色口吻说话、不要直接写消息内容，只输出判断 JSON】",
      "你是当前角色的内心。现在是 " + nowHM + "。想一想：今天剩下的时间里，TA会在哪些时刻想给用户发消息？",
      "念头是TA自己冒出来的，不必挂在日程上——刚做完一件事想说、路上看见什么、忽然惦记、白天没聊完的话头、单纯想搭句话，都算；一件事也可以不产生任何念头。按TA的性格克制判断，宁可少也别硬凑。",
      '输出严格 JSON，第一个字符必须是 {，字段名一字不差：{"impulses":[{"time":"这个念头最想说出口的时刻HH:MM","until":"过了这个时刻这话就不新鲜了、不必再发HH:MM","about":"这个念头的由头（8字内，例：路过花店/刚开完会/昨晚那事没聊完）","sem":"接触类型：问候/关心/追话题/分享/惦记 选一","topic":"想聊的话题（8字内）","intent":"TA当时的第一人称心理动机（40字内，不写台词）","why":"为什么这会儿会想起（20字内）"}]}',
      "impulses 按时刻从早到晚排；一个也没有就给空数组，不要为了填满而编。",
      "until 是这个念头的保质期：接话头、约好的事可以短（半小时到一小时），单纯想分享的可以长（两三小时）。不写就按一个半小时算。",
      "TA今天的生活面（背景，不是候选时刻）：", JSON.stringify({ mood: day.mood, energy: day.energy, schedule: day.schedule }),
      "（energy 是TA刚醒时的基线，不是此刻的）",
      "", "今天剩下的时间长这样（按TA的日程逐段列出，end 是这段结束的时刻，空档也单列一行；精力越低越懒得开口，busy=true 那几段顾不上看手机，别把念头排在里面——排在它结束之后反而正好）：",
      JSON.stringify(outlook),
      lines.length ? "\n最近和用户的聊天（「我」=用户，「TA」=角色，从旧到新）：\n" + lines.join("\n") : null,
      lines.length ? "结合聊天氛围判断：正聊得火热就不必刻意再约时刻；有没接完的话头、刚闹过别扭、或很久没联系，都会真实影响TA想不想主动、以及动机的内容。动机要能接上最近聊的事，不要凭空另起炉灶。" : null,
      threads && threads.length ? "\nTA心里还挂着这些事（约定快到点想打个气、过了点想问结果、到日子的想说一句、话头没接完想续上，都是很自然的由头）：\n" + threads.join("\n") : null,
      anchors.length ? "\n用户希望留意这几段：" + anchors.join("；") + "。想不起来就不用勉强。" : null,
      "", "约束：最多给 " + (settings.quota + 3) + " 个念头，今天最多真的发 " + settings.quota + " 条（多出来的会被记成「想过但没发」）；"
        + "时刻必须晚于 " + nowHM + "；免打扰时段 " + settings.quietStart + "–" + settings.quietEnd + " 内不要排"
        + (settings.minGapMin > 0 ? "；相邻两个念头至少隔 " + settings.minGapMin + " 分钟" : "") + "。",
      (settings.moodGate && day.energy < 30) ? "TA今天精力只有 " + day.energy + "%，很低。这种时候TA更想缩着，明显减少主动。" : null,
      biasLine || null,
    ].filter((s) => s !== null).join("\n");
  }
