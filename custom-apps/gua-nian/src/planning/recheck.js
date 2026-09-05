  /* ================= 核心：动态复核 ================= */
  // 官方陪伴插件式的「判断随状态刷新」：打开小手机时（以及在页时每隔 recheckMin 分钟），
  // 按最新聊天重审今天还没到点的时刻——未回应降速是硬规则，聊崩了会取消，
  // 聊出没聊完的话头时可以临时起一个新念头。
  async function flushJudgeFinish(cx) {
    const receipt = cx.plan && cx.plan.judgeFinish;
    if (!receipt || receipt.cloudUrl !== (cloudCfg() || {}).url || cx._judgeFinishing) return;
    cx._judgeFinishing = true;
    try {
      const result = await cloudFetchBounded("judge-task", { method: "POST", body: JSON.stringify(receipt) });
      if (!result.claimed && result.reason !== "lost" && result.reason !== "no-plan") throw new Error("云端未确认复核结果");
      cx.plan = await upsert("plans", x => x.date === receipt.planDate && x.characterId === cx.character.id, { judgeFinish: null });
      if (!result.claimed) await log(cx, "复核完成回执已过期，本地结果保留；云端是否处理过以最新计划为准");
    } finally { cx._judgeFinishing = false; }
  }
  async function recheck(cx, trigger) {
    if (cx.busy || cx._planLock || !owns(cx)) return;
    if (!S.settings || !(S.settings.recheckMin > 0)) return;
    if (!cx.character || !cx.day || !cx.plan || !Array.isArray(cx.plan.items)) return;
    const over = usageOver();
    if (over) { if (cx._capNoted !== todayStr()) { cx._capNoted = todayStr(); await log(cx, "复核暂停到明天：" + over); } return; }
    const nowMs = Date.now();
    // 判决是重判已排好的时刻，没有待发时刻就无从判起；起念是新开一个时刻，跟有没有
    // 待发时刻无关——日程走完的晚上恰恰最该起念。两组共用同一次调用，任一组能干活就跑。
    const canJudge = cx.plan.items.some((w) => w.fireAt > nowMs + 2 * 60000);
    const canImpulse = !!S.settings.chatCandidates
      && cx.plan.items.filter((w) => w.act).length < S.settings.quota;
    if (!canJudge && !canImpulse) return;
    cx._planLock = true;
    let lease = null, succeeded = false, heartbeat = 0;
    try {
      // 必须先并再判：下面那次 uploadPlanCloud 会整行盖掉计划行的 items，
      // 云端点亮回填的 wakeId 跟着没，那条预约就撤不掉了，到点照发。
      await flushJudgeFinish(cx);
      const pulled = await pullCloudDecisionsBody(cx, true);
      if (pulled) render();
      const since = Math.max(cx.plan.recheckAt || cx.plan.plannedAt || 0, +cx.plan.judgedChatAt || 0);
      const chat = await readRecentChat(cx, 60);
      chat.sort((a, b) => a.t - b.t);
      const fresh = chat.filter((m) => m.role === "user" && m.t > since);
      const streak = unansweredStreak(chat);
      const cooling = S.settings.maxUnanswered > 0 && streak >= S.settings.maxUnanswered;
      if (!fresh.length && !cooling) return; // 没有新信息，维持原判断
      const items = cx.plan.items.slice();
      let changed = 0, added = 0;

      if (cooling) {
        // 硬规则：你一直没回，TA不追着发
        for (const w of items) {
          if (w.act && w.fireAt > nowMs) {
            if (w.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ } }
            w.act = false; w.adj = "cooled"; w.wakeId = ""; w.delivery = "";
            w.why = "你有 " + streak + " 轮消息没回，TA不想追着发";
            (w.hist = w.hist || []).push({ at: nowMs, kind: "cooled", note: "连续 " + streak + " 轮未回，触发降速" });
            changed++;
          }
        }
        if (changed) await log(cx, "复核（" + trigger + "）：连续 " + streak + " 轮未回 ≥ 降速阈值 " + S.settings.maxUnanswered + "，取消 " + changed + " 个待发时刻");
      } else {
        // 打开和定时入口共用持久间隔；不能只靠页面内的 _rcTry。
        // 先记尝试、后调模型：回复后写日程/账本失败时，也不能立刻重复付费判断。
        const lastAttempt = Math.max(+cx.plan.recheckAttemptAt || 0, +cx.plan.recheckAt || 0, +cx.plan.judgedAt || 0);
        if (lastAttempt && nowMs - lastAttempt < Math.max(1, S.settings.recheckMin) * 60000) return;
        if (cloudRecheckOn()) {
          await requireRecheckFeatures(["judge-task-v1"]);
          const task = { characterId: cx.character.id, planDate: todayStr(), token: "app-" + nowMs + "-" + Math.random().toString(36).slice(2), chatAt: Math.max(...fresh.map(m => m.t)) };
          const claim = await cloudFetchBounded("judge-task", { method: "POST", body: JSON.stringify({ ...task, op: "claim" }) });
          if (!claim.claimed) { await log(cx, "本机复核跳过：云端正在处理或已判断过这段聊天"); return; }
          lease = { ...task, active: true };
          const renew = async () => {
            if (!lease) return;
            try {
              const r = await cloudFetchBounded("judge-task", { method: "POST", body: JSON.stringify({ ...task, op: "renew" }) });
              if (lease) lease.active = !!r.claimed;
            } catch (e) { if (lease) lease.active = false; }
            if (lease && lease.active) heartbeat = setTimeout(renew, 60000);
          };
          heartbeat = setTimeout(renew, 60000);
        }
        cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
          { recheckAttemptAt: nowMs });
        await log(cx, "本机复核开始（" + trigger + "）：读取 " + fresh.length + " 条新用户消息");
        const lines = chatExcerpt(chat, S.settings.judgeLines);
        const remaining = items.filter((w) => w.fireAt > nowMs + 2 * 60000);
        const usedQuota = items.filter((w) => w.act).length;
        const canPost = moCanPost(cx);
        const parsed = await generateJson(cx, {
          characterId: cx.character.id,
          appTags: ["companion", "impulse"],
          instruction: [
            "【后台系统任务，不是聊天：不要以角色口吻说话、不要写消息内容，只输出 JSON】",
            canJudge
              ? "你是当前角色的内心。之前TA为今天定过一批想不想给用户发消息的判断；现在聊天有了新进展，请只对下面「还没到点」的时刻重新判断"
                + (canImpulse ? "，并允许临时起最多一个新念头。" : "。")
              : "你是当前角色的内心。当前没有需要复核的候选消息时刻，生活日程仍按原安排继续。只看刚才聊的内容里有没有值得临时起一个新念头的事：聊到一半没说完的话头、约好了要说的、答应了要问的。只是随口聊到、没落实的事不算。",
            "TA今天的生活面：" + JSON.stringify({ mood: cx.day.mood, energy: energyAt(cx.day, nowMs) }),
            "最近聊天（「我」=用户，从旧到新，越靠后越新）：", lines.join("\n"),
            streak ? "注意：TA最近连发了 " + streak + " 条用户还没回。没回就少发、缓发，别显得追着人跑。" : null,
            biasText() || null,
            canJudge ? "还没到点的时刻（act 是之前的判断）：" : null,
            canJudge ? JSON.stringify(remaining.map((w) => ({ time: w.time, source: w.source, act: !!w.act, intent: w.intent || "", energy: energyAt(cx.day, w.fireAt) }))) : null,
            '输出严格 JSON，第一个字符必须是 {，字段名一字不差：{"decisions":[{"time":"HH:MM","act":true或false,"sem":"接触类型：问候/关心/追话题/分享/惦记 选一","topic":"这次想聊的话题（8字内）","why":"维持或改变的理由（20字内）","intent":"act为true时TA的第一人称动机（40字内，不写台词）","defer":"只是这个点不合适、话还想说时，改约到今天更晚的HH:MM；不改约就空字符串"}],"extra":[{"time":"HH:MM","until":"过了这个时刻这话就不新鲜了HH:MM","about":"没聊完的话头或约好的事（8字内）","intent":"第一人称动机","why":"为什么值得临时起念","from":"如果这条出自账本里某件事，填它的 id，否则空字符串"}],"feel":{"mood":"这段聊天下来TA此刻的情绪（8字内，具体，不要「心情不错」这种空话）","cause":"因为什么（12字内）","energy":这段聊天对精力的影响-20到20的整数,"intensity":这个情绪有多强0到100的整数,"hours":大概几小时淡一半（1到12的整数）},"sched":[{"op":"add或move或drop","time":"HH:MM（move/drop 填这条日程原来的时间；add 不用）","newTime":"HH:MM（add 是新日程的时间，move 是挪去的时间）","title":"日程标题（8字内，add 必填）","note":"一句具体的细节","mood":"做完之后的情绪（8字内）","cost":这件事对精力的影响-40到40的整数,"why":"聊天里的依据（15字内）"}],"keep":[{"kind":"topic或promise或date","text":"一句话（20字内）","when":"promise/date 必填：YYYY-MM-DD HH:MM、HH:MM 或 MM-DD；topic 留空","why":"为什么记它（15字内）"}],"settle":["已了结的账本 id"],"post":{"hint":"想发的朋友圈由头或大意（30字内）"}或null}',
            "feel 描述的是聊天带来的情绪变化，不是今天的底色：被安慰/被逗笑/聊得投入给正 energy，被冷落/吵架/说累了给负；聊得平淡就把 intensity 给低分。",
            (S.settings.chatEditsDay
              ? "sched 只在聊天里确实出现了会改变TA今天安排的事才给：约好了几点做什么、临时被叫走、说了某件事不去了。最多 2 条，时间必须晚于现在（" + fmtHM(nowMs) + "）；只是随口聊到、没有落实的事不要写进来，没有就给空数组。"
              : "sched 必须是空数组（用户关掉了聊天改日程）。"),
            "TA今天还没到点的日程：" + JSON.stringify(((cx.day && cx.day.schedule) || []).filter((x) => x.time > fmtHM(nowMs)).map((x) => ({ time: x.time, title: x.title }))),
            S.settings.threadsOn && threadLines(cx, nowMs).length ? "TA心里还挂着的事：\n" + threadLines(cx, nowMs).join("\n") : null,
            S.settings.threadsOn ? THREAD_TASK : "keep 和 settle 一律空数组。",
            canPost
              ? "post：如果此刻更想发一条朋友圈而不是私聊（晒一下刚做的事、随手记一句、发个感慨——给所有人看的，不是说给用户听的），就在 post.hint 里写想发的由头或大意（30字内），由系统按人设成文。这周已发 " + moState(cx).weekN + " 条。私聊和发圈可以只要一个，也可以都不要；不想发就写 null。"
              : "post 一律写 null。",
            "改约：act 给 false 时，如果只是这个时刻不合适（刚聊完太密、这话晚点说更合适、这会儿说了会打断你、TA心思还没到这上面），而话本身还想说，就在 defer 里写一个今天更晚的 HH:MM，整个念头会挪过去，不占新额度；真的不想说了才把 defer 留空。TA到点正忙或在睡觉不用你操心，系统会自动顺延，别为这个改约。只能挪到这个念头的保质期（until）之前——过了那个点这话就不新鲜了，宁可作罢。",
            "decisions 与上面时刻一一对应、顺序一致；没有变化就原样回传。extra 最多 1 条：只有聊天里确实有没聊完的话头、约好的事、或明显被勾起的牵挂才加（账本里快到点的约定、到了的日子也算），没有就给空数组。",
            "extra 和 keep 是两条路，同一件事只能进一边：今天之内说得掉的（下午问一句、晚上接着聊）走 extra 排个时刻；今天说不掉的（要等结果、要到某个日子、隔几天再问才自然）走 keep 记进账本，以后自己会想起来。今天的额度和间隔在上面，说不说得下就按它判。extra 出自账本里已有的某件事时，from 填那条的 id——发出去之后系统会自动把账本那条了结或标成提过了，你不用再写进 settle。"
              + (S.settings.chatCandidates ? "" : "（临时起念已被用户关闭，extra 必须是空数组）"),
            "约束：今天最多 " + S.settings.quota + " 条（已占 " + usedQuota + "）；免打扰 " + S.settings.quietStart + "–" + S.settings.quietEnd
              + (S.settings.minGapMin > 0 ? "；相邻起念至少隔 " + S.settings.minGapMin + " 分钟" : "")
              + "；extra 的时间必须晚于现在（" + fmtHM(nowMs) + "）。",
          ].filter((s) => s !== null).join("\n"),
        });
        if (lease) {
          const renewed = await cloudFetchBounded("judge-task", { method: "POST", body: JSON.stringify({ ...lease, op: "renew" }) });
          if (!renewed.claimed) throw new Error("复核任务租约已失效，本轮结果未应用");
        }
        const feel = parsed && parsed.feel;
        if (feel && String(feel.mood || "").trim()) {
          await pushCond(cx, {
            mood: String(feel.mood).trim().slice(0, 24),
            cause: String(feel.cause || "刚才聊的").slice(0, 20),
            energyDelta: Math.max(-20, Math.min(20, Math.round(+feel.energy || 0))),
            intensity: Math.max(0, Math.min(100, Math.round(+feel.intensity || 50))),
            halfLifeMin: Math.max(1, Math.min(12, Math.round(+feel.hours || 3))) * 60,
            startAt: nowMs,
          });
          await log(cx, "聊完之后TA的情绪：" + feel.mood + "（" + (feel.cause || "") + "，精力 " + (+feel.energy > 0 ? "+" : "") + (Math.round(+feel.energy) || 0) + "）");
        }
        const decs = Array.isArray(parsed.decisions) ? parsed.decisions : [];
        const byTime = {};
        decs.forEach((d) => { const hm = normHM(d && d.time); if (hm) byTime[hm] = d; });
        for (const w of remaining) {
          const d = byTime[w.time]; if (!d) continue;
          if (d.sem) w.sem = String(d.sem);
          if (d.topic) w.topic = String(d.topic);
          const wantAct = !!d.act;
          if (wantAct === !!w.act) { if (wantAct && d.intent) w.intent = String(d.intent); continue; }
          if (!wantAct) {
            // 改约：想说但这个点不合适的，整条挪走而不是丢掉。挪不动（时刻不合法/撞免打扰/
            // 挨太近/离原时刻太远）就退回原来的取消。念头本来就点亮着，挪完不额外占额度。
            // 和「忙与睡」的 held 是同一件事——都是把时刻往后挪——所以复用 held 那套展示，
            // 只在历史里分开记：那边是到点机械顺延，这边是复核时TA自己改的主意。
            const dh = normHM(d.defer), dms = dh ? timeToMs(dh) : null;
            const dgap = (S.settings.minGapMin || 0) * 60000;
            // 挪的上限是念头自己的保质期 until（生成时模型给的，老计划没有就按原时刻 +
            // busyMaxHoldMin 兜底）。不数次数——过了保质期这话就不新鲜了，由头本身不成立。
            const dorig = +w.origFireAt || w.fireAt;
            const dcap = +w.until || dorig + (S.settings.busyMaxHoldMin || 180) * 60000;
            if (dms && dms > nowMs + 2 * 60000 && !inQuiet(dh) && !asleepAt(cx.day, dh) && dms <= dcap
              && !items.some((x) => x !== w && x.time === dh)
              && !(dgap && items.some((x) => x.act && x !== w && Math.abs(x.fireAt - dms) < dgap))) {
              if (w.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 忽略 */ } }
              w.wakeId = "";
              try {
                const res = await AiPhone.push.wake({ characterId: cx.character.id, fireAt: dms, intent: w.intent || String(d.intent || ""), source: "tool", cooldownRounds: S.settings.maxUnanswered });
                const from = w.time;
                w.time = dh; w.fireAt = dms; w.held = true; w.origFireAt = dorig;
                w.wakeId = res.id; w.delivery = res.armed ? "push" : "local"; w.reason = res.reason || "";
                w.why = String(d.why || "这个点不合适");
                (w.hist = w.hist || []).push({ at: nowMs, kind: "defer", note: from + " 改约到 " + dh + "——" + w.why });
                items.sort((a, b) => a.fireAt - b.fireAt);
                changed++;
                await log(cx, "复核：" + from + " 改约到 " + dh + "——" + w.why);
                continue;
              } catch (e) { await log(cx, "复核改约失败 → " + dh + "（改为取消）：" + (e && e.message || e)); }
            }
            if (w.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 忽略 */ } }
            w.act = false; w.adj = "recheck"; w.wakeId = ""; w.delivery = "";
            w.why = String(d.why || "聊过之后TA改了主意");
            (w.hist = w.hist || []).push({ at: nowMs, kind: "recheck", note: "取消——" + w.why });
            changed++;
            await log(cx, "复核：" + w.time + " 取消起念——" + w.why);
          } else {
            if (items.filter((x) => x.act).length >= S.settings.quota) { await log(cx, "复核：" + w.time + " 想点亮但额度已满"); continue; }
            try {
              const res = await AiPhone.push.wake({ characterId: cx.character.id, fireAt: w.fireAt, intent: String(d.intent || w.source || "想到用户"), source: "tool", cooldownRounds: S.settings.maxUnanswered });
              w.act = true; w.adj = "recheck"; w.intent = String(d.intent || ""); w.why = String(d.why || "");
              w.wakeId = res.id; w.delivery = res.armed ? "push" : "local"; w.reason = res.reason || "";
              w.score = calcScore(w.fireAt, items.filter((x) => x.act && x !== w).length, streak, 0);
              (w.hist = w.hist || []).push({ at: nowMs, kind: "lit", note: "复核点亮——" + (w.intent || w.why) });
              changed++;
              await log(cx, "复核：" + w.time + " 新点亮 ✓ " + w.intent);
            } catch (e) { await log(cx, "复核点亮失败 " + w.time + "：" + (e && e.message || e)); }
          }
        }
        // 聊天衍生的临时起念（未完话题/约定）
        // 门禁只放行了判决那一组时，模型仍可能塞回 extra——这里硬拦。
        const extras = (canImpulse && Array.isArray(parsed.extra)) ? parsed.extra.slice(0, 1) : [];
        for (const x of extras) {
          const hm = normHM(x && x.time); const ms = hm ? timeToMs(hm) : null;
          if (!ms || ms <= nowMs + 2 * 60000 || inQuiet(hm) || asleepAt(cx.day, hm)) continue;
          if (items.some((w) => w.time === hm)) continue;
          if (items.filter((w) => w.act).length >= S.settings.quota) { await log(cx, "复核：临时起念 " + hm + " 被今日额度挡下"); continue; }
          const gap = (S.settings.minGapMin || 0) * 60000;
          if (gap && items.some((w) => w.act && Math.abs(w.fireAt - ms) < gap)) { await log(cx, "复核：临时起念 " + hm + " 离已有起念太近，放弃"); continue; }
          try {
            const res = await AiPhone.push.wake({ characterId: cx.character.id, fireAt: ms, intent: String(x.intent || "有句话没说完，想找用户"), source: "tool", cooldownRounds: S.settings.maxUnanswered });
            const xUms = timeToMs(normHM(x.until) || "");
            items.push({
              time: hm, fireAt: ms, until: xUms && xUms > ms ? Math.min(xUms, ms + 6 * 3600000) : ms + 90 * 60000,
              source: "临时·" + String(x.about || "未完话题").slice(0, 10),
              act: true, adj: "extra", why: String(x.why || ""), intent: String(x.intent || ""),
              delivery: res.armed ? "push" : "local", reason: res.reason || "", wakeId: res.id,
              sem: "追话题", topic: String(x.about || "").slice(0, 10),
              from: threadIdOf(cx, x.from),
              score: calcScore(ms, items.filter((w) => w.act).length, streak, 0),
              hist: [{ at: nowMs, kind: "extra", note: "聊天里冒出来的：" + String(x.why || x.intent || "") }],
            });
            items.sort((a, b) => a.fireAt - b.fireAt);
            added++;
            await log(cx, "复核：临时起念 ✓ " + hm + "「" + String(x.about || "") + "」" + String(x.intent || ""));
          } catch (e) { await log(cx, "复核临时起念预约失败：" + (e && e.message || e)); }
        }
        await applyChatSchedEdits(cx, parsed.sched, nowMs);
        await applyThreads(cx, parsed, nowMs, "app", items);
        const postHint = canPost && parsed.post && typeof parsed.post === "object" ? String(parsed.post.hint || "") : "";
        if (postHint) await postMoment(cx, postHint, nowMs, "app");
      }

      cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        { date: todayStr(), characterId: cx.character.id, items, chatUsed: cx.plan.chatUsed || 0, plannedAt: cx.plan.plannedAt || nowMs, recheckAt: nowMs,
          ...(lease ? { judgedChatAt: lease.chatAt, judgedAt: nowMs,
            judgeFinish: { ...lease, op: "finish", success: true, cloudUrl: (cloudCfg() || {}).url } } : {}) });
      succeeded = true;
      await uploadPlanCloud(cx, false);
      if (changed || added) {
        cx.archive = null;
        if (added) toast("TA临时多了一个想找你的时刻");
        else toast(cooling ? "你没回TA，TA今天不追着发了" : "TA按最近的聊天调整了心意");
        render();
      }
    } catch (e) {
      await log(cx, "复核未完成（部分改动可能已保存，将按复核间隔重试）：" + (e && e.message || e));
    } finally {
      clearTimeout(heartbeat);
      if (lease) {
        const finished = lease; lease = null;
        try {
          if (succeeded) await flushJudgeFinish(cx);
          else await cloudFetchBounded("judge-task", { method: "POST", body: JSON.stringify({ ...finished, op: "finish", success: false }) });
        } catch (e) { await log(cx, succeeded ? "复核完成回执待同步，下次打开或分钟检查会重试" : "复核任务释放失败，租约最长 10 分钟后失效"); }
      }
      try { await syncChatContext(cx); }
      catch (e) { await log(cx, "复核后同步聊天上下文失败：" + (e && e.message || e)); }
      finally { cx._planLock = false; }
    }
  }
