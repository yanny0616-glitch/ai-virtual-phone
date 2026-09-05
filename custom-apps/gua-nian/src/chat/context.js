  /* ================= 预览 ================= */
  async function preview(cx) {
    if (S._previewing) return; S._previewing = true;
    S._preview = S._preview || {};
    const cid = cx.character.id;
    const show = (html) => { S._preview[cid] = html; const z = $("#preview-zone"); if (z && cur().character && cur().character.id === cid) z.innerHTML = html; };
    show('<div class="bubble"><div class="from">' + esc(cx.character.name) + ' · 此刻</div><span class="typing"><i></i><i></i><i></i></span></div>');
    try {
      const ctx = cx.day ? ("TA此刻的状态：" + cx.day.mood + "；正在" + (currentDoing(cx) || cx.day.doing) + (phaseAt(cx.day, Date.now()).kind === "sleep" ? "" : "；在" + currentPlace(cx)) + "。") : "";
      const r = await AiPhone.ai.generate({
        characterId: cx.character.id,
        appTags: ["companion", "preview"],
        instruction: "现在时刻 " + fmtHM(Date.now()) + "。" + ctx + " 请以TA的身份，此刻主动给用户发一条消息。",
      });
      show('<div class="bubble"><div class="from">' + esc(cx.character.name) + ' · 此刻</div>' + esc((r.text || "").trim()) + '</div><div class="preview-note">仅预览，没有发进聊天室，也不消耗TA今天的主动额度。</div>');
    } catch (e) {
      show("");
      toast("预览失败：" + (e && e.message || e));
    }
    S._previewing = false;
  }

  // 接在「正在」后面读得通的一句：睡着、做着某条、空档歇着、睡前
  function currentDoing(cx) {
    if (!cx.day || !Array.isArray(cx.day.schedule)) return "";
    const ph = phaseAt(cx.day, Date.now());
    if (ph.kind === "sleep") return "睡觉";
    if (ph.kind === "on") return ph.it.title;
    if (ph.kind === "pre") return "睡前自己待着，准备睡了";
    return ph.it ? "歇着（刚忙完" + ph.it.title + "）" : (cx.day.doing || "起床后的时间");
  }
  // 地点跟着日程走：正做着或刚做完，人就在那件事的地方；睡前、睡着按最后一件算；
  // 第一件事还没开始才用早上生成时的地点。云端 push-generate 同一套规则。
  function currentPlace(cx) {
    if (!cx.day) return "";
    const ph = phaseAt(cx.day, Date.now());
    const it = ph.it || (lastDone(cx.day, Date.now()) || {}).it;
    return (it && it.place) || cx.day.location || "";
  }
  // 细排过的那条日程，此刻落在哪一小步上。没细排过、或这条已经做完了就没有，返回空串。
  function currentStep(cx) {
    const ph = cx.day ? phaseAt(cx.day, Date.now()) : null;
    if (!ph || ph.kind !== "on" || !Array.isArray(ph.it.steps)) return "";
    const now = fmtHM(Date.now());
    let what = "";
    for (const x of ph.it.steps) { if (x.time && x.time <= now) what = x.what || ""; }
    return what;
  }

  /* ================= 注入聊天提示词 ================= */
  // 覆盖式写一段「TA此刻怎么样」进角色的聊天提示词。宿主把这段排在提示词最末：
  // 系统提示词整段共用一个缓存断点，放前面会让人设/世界书每轮都重新计费。
  // 开关关掉时要主动写空串撤销——光是不写，上一次的状态会一直挂在那里。
  // 正文里不写当前几点：挂念关着的时候这段不会刷新，写死的钟点会变成假话。
  // 快照时刻放进 label（渲染成【挂念 · 14:32 的状态】），角色自己对着提示词里的
  // 真实时间就能看出这份状态是不是旧的。
  function chatContextText(cx) {
    const nb = nightBridge(cx);
    if (nb) {
      return (nb.asleep
        ? "在睡觉（" + nb.wake + " 左右才醒）：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。"
        : "在做的事：" + nb.doing + "。") + "\n今天的日程还没排，先按昨天的作息过。";
    }
    const now = Date.now(), m = moodNow(cx.day, now), e = energyAt(cx.day, now);
    const ph = phaseAt(cx.day, now), sw = sleepWindow(cx.day);
    const cur = currentDoing(cx) || cx.day.doing || "";
    const step = currentStep(cx);
    const nx = ph.kind === "sleep" ? null : nextSched(cx.day, now);
    const lines = [];
    if (ph.kind === "sleep") {
      lines.push("在睡觉" + (sw ? "（" + sw.wake + " 左右才醒）" : "") + "：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。");
    } else {
      lines.push("在做的事：" + (cur || "没什么特别的") + (step ? "，具体是在" + step : "")
        + (currentPlace(cx) ? "；人在" + currentPlace(cx) : ""));
    }
    if (cx.day.sleep && ph.kind !== "sleep") lines.push("昨晚：" + cx.day.sleep);
    lines.push("情绪：" + (m.text || cx.day.mood || "说不上来")
      + (m.base ? "（今天一整天的底色）" : "（因为" + (m.from || "刚才那阵") + "；今天的底色是「" + (cx.day.mood || "平常") + "」）"));
    lines.push("精力：" + e + "%" + (e < 25 ? "——很累了，话短、反应慢、容易敷衍" : e < 50 ? "——有点乏" : e < 80 ? "——还行" : "——精神很好"));
    if (nx) lines.push("接下来：" + nx.time + " " + nx.title);
    else if (ph.kind === "pre" && sw) lines.push("接下来：" + sw.bed + " 睡觉");
    else if (ph.kind === "sleep" && sw) lines.push("接下来：" + sw.wake + " 起床");
    if (S.settings.threadsOn) {
      const tl = liveThreads(cx, now).slice(0, 4).map((t) => THREAD_KIND[t.kind] + "·" + t.text + (threadWhen(t, now) ? "（" + threadWhen(t, now) + "）" : ""));
      if (tl.length) lines.push("心里还挂着：" + tl.join("；") + "。到了时候自然会想问一句，不用每次都提。");
    }
    lines.push("这些是你自己的状态，说话时自然带出来就行，别报数字、别列清单、别提这段文字。");
    return lines.join("\n");
  }
  // 被动回复闸门：把作息（睡眠窗）和今天顾不上看手机的时段寄给宿主，你发消息时宿主自己判——
  // 纯数据，挂念关着也管用；不挂在「注入聊天」开关下。老日程没标 busy 的按标题猜，规则和云端同一份。
  const BUSY_RE = /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/;
  const NOT_BUSY_RE = /睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/;
  function isBusyItem(it) {
    if (!it) return false;
    if (it.busy === true) return true;
    const t = String(it.title || "");
    return BUSY_RE.test(t) && !NOT_BUSY_RE.test(t);
  }
  async function syncReplyGate(cx) {
    if (!cx.character || !AiPhone.chat || !AiPhone.chat.setReplyGate) return;
    const st = S.settings || {};
    const nb = nightBridge(cx);
    const sw = cx.day ? sleepWindow(cx.day) : (nb ? { bed: nb.bed, wake: nb.wake } : null);
    const gate = st.replyGate && nb ? {
      sleep: { bed: sw.bed, wake: sw.wake, mode: st.sleepMode, wakeProb: st.sleepWakeProb, bufferMin: st.busyBufferMin },
      busy: { date: todayStr(), peekMin: st.busyPeekMin, windows: [] },
    } : st.replyGate && cx.day ? {
      sleep: sw ? { bed: sw.bed, wake: sw.wake, mode: st.sleepMode, wakeProb: st.sleepWakeProb, bufferMin: st.busyBufferMin } : undefined,
      busy: { date: cx.day.date, peekMin: st.busyPeekMin, windows: (cx.day.schedule || [])
        .filter((it) => isBusyItem(it) && it.time && it.end && it.end > it.time)
        .map((it) => ({ from: it.time, to: it.end, title: it.title || "" })) },
    } : null;
    const key = JSON.stringify(gate);
    if (key === cx._gate) return;
    try {
      await AiPhone.chat.setReplyGate({ characterId: cx.character.id, gate: gate });
      cx._gate = key;
    } catch (e) {
      if (S._gateWarned) return;
      S._gateWarned = true;
      await log(cx, "回复闸门同步失败（不影响其余功能）：" + (e && e.message || e));
    }
  }
  // 好感与关系由聊天插件「好感与关系」写在共享变量池里（scope character，name affection）；
  // 这里只读：寄给云端当分寸，此刻行露一个小标签。没装插件或宿主太老就是 null。
  async function refreshAffection(cx) {
    cx.aff = null;
    if (!cx.character || !AiPhone.variables || !AiPhone.variables.get) return;
    try {
      const v = await AiPhone.variables.get("affection", { scope: "character", characterId: cx.character.id });
      if (v && typeof v === "object" && (v.tier || v.relation)) {
        cx.aff = { score: +v.score || 0, tier: String(v.tier || ""), relation: String(v.relation || "") };
      }
    } catch (e) { /* 变量池不可用就当没有 */ }
  }
  // 反向也给一份：TA此刻的状态快照写进变量池 presence，聊天插件面板拿去显示。
  // 只是编排/同步那一刻的快照，带 at 让读的一方知道新不新。
  async function publishPresence(cx) {
    if (!cx.character || !AiPhone.variables || !AiPhone.variables.set) return;
    try {
      const opts = { scope: "character", characterId: cx.character.id };
      const nb = nightBridge(cx);
      if (nb) {
        await AiPhone.variables.set("presence", { at: Date.now(), asleep: nb.asleep, busy: false, doing: nb.doing, step: "", place: "", mood: String(cx.prev.mood || ""), energy: Math.round(energyAt(cx.prev, Date.now())), next: nb.next }, opts);
        return;
      }
      if (!cx.day) { await AiPhone.variables.unset("presence", opts); return; }
      const now = Date.now(), ph = phaseAt(cx.day, now), sw = sleepWindow(cx.day), nx = nextSched(cx.day, now);
      await AiPhone.variables.set("presence", {
        at: now,
        asleep: ph.kind === "sleep",
        busy: ph.kind === "on" && !!ph.it && isBusyItem(ph.it),
        doing: ph.kind === "sleep" ? "睡觉" : (currentDoing(cx) || cx.day.doing || ""),
        step: currentStep(cx) || "",
        place: ph.kind === "sleep" ? "" : currentPlace(cx),
        mood: (moodNow(cx.day, now).text || cx.day.mood || ""),
        energy: Math.round(energyAt(cx.day, now)),
        next: nx ? nx.time + " " + nx.title : (ph.kind === "pre" && sw ? sw.bed + " 睡觉" : (ph.kind === "sleep" && sw ? sw.wake + " 起床" : "")),
      }, opts);
    } catch (e) { /* 变量池不可用就算了 */ }
  }
  async function syncChatContext(cx, force) {
    await syncReplyGate(cx);
    await refreshAffection(cx);
    await publishPresence(cx);
    await publishMoments(cx);
    if (!cx.character || !AiPhone.chat || !AiPhone.chat.setContext) return;
    const on = !!(S.settings && S.settings.injectChat) && !!(cx.day || nightBridge(cx));
    const text = on ? chatContextText(cx) : "";
    if (!force && text === cx._ctx) return;
    try {
      await AiPhone.chat.setContext({
        characterId: cx.character.id,
        label: on ? fmtHM(Date.now()) + " 的状态" : "",
        text: text,
      });
      cx._ctx = text;
    } catch (e) {
      if (S._ctxWarned) return;
      S._ctxWarned = true;
      await log(cx, "注入聊天失败（不影响其余功能）：" + (e && e.message || e));
    }
  }
