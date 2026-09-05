  /* ================= 设置弹层：schema 驱动 =================
     加一项配置 = 往 SET_SECTIONS 某一节的 groups 里加一条 + 往 SET_DEF 里补个默认值，
     渲染 / 回填 / 读表三处都不用再动。 */
  const SET_SECTIONS = [
    { id: "base", name: "基本", groups: [
      { title: "挂念的人", sub: "可以多选，每位各有自己的一天", fields: [{ type: "chars" }] },
      { title: "模型调用", adv: true, fields: [
        { type: "stepper", key: "apiDailyCap", min: 0, max: 500, step: 5, label: "一天最多", unit: "次" },
        { type: "stepper", key: "tokenDailyCap", min: 0, max: 5000000, step: 50000, label: "一天最多", unit: "token" },
      ], hint: "本机和云端、所有挂念的人合计。生成一天、编排、复核、改日程，以及云端的生成、复核、到点发送，每次调用都记一笔；到了上限当天就不再调，明天自动归零。0 = 不限。「用量」页能看明细。" },
      { title: "免打扰时段", sub: "这段时间TA不会来找你", fields: [{ type: "timeRange", keys: ["quietStart", "quietEnd"] }] },
      { title: "你的睡眠时段", sub: "可选，默认关闭；作息不固定可以不设", fields: [
        { type: "toggles", items: [{ key: "userSleepOn", label: "睡眠时段暂停回音计时" }] },
        { type: "timeRange", keys: ["userSleepStart", "userSleepEnd"] },
      ], hint: "开启后每天按这段时间暂停回音统计的等待计时，醒来后继续累计，满 3 小时再统计。按保存时设备所在时区计算，可跨零点，起止时间不能相同。<br>只影响回音统计，不改变免打扰、TA的作息或未回应降速。未回复仍保持中性；不需要每天操作，也没有手动忙碌按钮。保存并成功同步计划后，对尚未结算的回音生效；旧统计不重算。" },
      { title: "自动生成TA的一天", fields: [
        { type: "toggles", items: [{ key: "autoGen", label: "每天到点自动生成" }, { key: "cloudGen", label: "浏览器关着也生成（云端）" }] },
        { type: "timeRange", keys: ["autoGenAt"], label: "每天几点" },
      ], hint: "到点自动生成TA今天的状态、日程和心动时刻。挂念在后台也算开着。<br>开了「云端」：每次打开挂念会把明天的生成原料和一份和本地同源的提示词模板寄到你的个人云，到点由云函数生成并编排，你打开时直接接管；云端 45 分钟没生成会本地补。需要云连接和离线推送。<br>错过了这个点，下次打开时补。浏览器一整天没开就生成不了，那天只有云端的兜底问候。" },
      { title: "什么时候生效", adv: true, fields: [], hint: "保存后本机设置立即更新；开着云端复核且已有今天的计划时，会同步现有计划的规则，是否成功看页面上的同步结果。<br>随用随判：同步成功后，下一次云端复核按新规则起念，不必为了上传设置而重置今天。<br>已经排好的时刻不会因保存而重排。要按新额度、间隔、免打扰、倾向或锚点重新安排，去「心动」页点「重新编排／重置今天」。切换起念模式会改变后续判断，但不会自动转换已有预约；如需整理今天的预约，也在该页操作。保留的临时起念不会随重排重建，其原预约的未回应降速阈值也不随保存更新。<br>今天的计划同步不等于明日生成原料已更新；明日原料在下次打开挂念或重新编排时刷新。", open: true },
    ] },
    { id: "pace", name: "分寸", groups: [
      { title: "主动倾向", sub: "TA有多想黏着你", fields: [{ type: "seg", key: "bias",
        options: [[-2, "很克制"], [-1, "克制"], [0, "自然"], [1, "热络"], [2, "黏人"]] }] },
      { title: "频率", fields: [
        { type: "stepper", key: "quota", min: 1, max: 6, step: 1, label: "每天最多主动", unit: "次" },
        { type: "stepper", key: "minGapMin", min: 0, max: 240, step: 30, label: "两个时刻至少隔", unit: "分钟 · 0 不限" },
        { type: "stepper", key: "maxUnanswered", min: 0, max: 6, step: 1, label: "未回应降速", unit: "轮 · 0 关" },
      ], hint: "未回应降速：TA连着主动这么多轮你都没回，今天剩下的时刻全部取消，不追着发。<br>一次连发的几条算一轮，最新一轮要晾满 30 分钟才计。" },
      { title: "念头什么时候定", fields: [
        { type: "seg", key: "impulseMode", options: [[1, "随用随判"], [0, "早上定完"]] },
      ], hint: "随用随判：早上只生成生活面，不排念头；白天云端每次醒来看一眼此刻的状态，想起来了才当场排一个近期时刻。更像真人，但要开着云端复核，并把 cron 调密（见 README）。<br>早上定完：编排时一次把今天所有心动时刻定死（老行为）。浏览器不常开、没配云的话选这个。<br>两种模式下额度、免打扰、最小间隔都照旧；随用随判另有配速，防止上午就把额度用光。" },
      { title: "起念来源与克制", adv: true, fields: [{ type: "toggles", items: [
        { key: "anchorSleep", label: "睡前锚点" },
        { key: "anchorMorning", label: "早安锚点" },
        { key: "chatCandidates", label: "聊天里临时冒念头" },
        { key: "moodGate", label: "状态低落时更安静" },
        { key: "momentsOn", label: "想分享时发朋友圈" },
      ] },
        { type: "stepper", key: "momentsWeekly", min: 0, max: 14, step: 1, label: "朋友圈一周最多", unit: "条 · 不占私聊额度" },
        { type: "stepper", key: "momentsGapH", min: 1, max: 48, step: 1, label: "两条至少隔", unit: "小时" },
      ],
      hint: "睡前锚点 / 早安锚点：提醒TA留意睡前那段、早上刚过免打扰那会儿，想不起来也不勉强——不再硬排时刻。<br>聊天临时起念：复核时允许按没聊完的话头临时加一个时刻。<br>状态低落时更安静：精力很低的那天明显少起念。<br>想分享时发朋友圈：TA自己过日子也会想发圈——云端每小时按时段、精力、刚做完的事掷一次骰子（不调模型）；复核判定某件事更像发给所有人看时也会改走朋友圈。都走宿主朋友圈的整条管线；浏览器关着时云端只记下起意和时间点，下次打开补成当时的帖子。<br>一周几条、隔几小时是发圈唯一的一套数：装了挂念，「朋友圈节奏」插件会让位。" },
    ] },
    { id: "chat", name: "聊天", groups: [
      { title: "动态复核", adv: true, fields: [
        { type: "stepper", key: "recheckMin", min: 0, max: 120, step: 5, label: "在页时每隔", unit: "分钟 · 0 关" },
        { type: "stepper", key: "judgeLines", min: 6, max: 40, step: 2, label: "判断时回看", unit: "句" },
      ], hint: "打开小手机时、以及之后每隔这么久，按你们最新的聊天重审今天还没到点的时刻。<br>聊崩了会取消，聊出没完的话头会临时加。每次重审调一次模型。<br>「判断时回看」是编排、复核、云端裁决喂给模型的最近几句，每句最多 200 字。调大更懂来龙去脉，也更费 token。保存即生效，云端那份下次上传计划时跟着更新。" },
      { title: "聊天改日程", adv: true, fields: [{ type: "toggles", items: [{ key: "chatEditsDay", label: "聊出来的安排落到今天的日程上" }] }],
        hint: "复核时顺带看聊天里有没有说定、取消或临时被叫走的安排，有就直接改今天的日程，一次最多 2 条。<br>只改还没到点的，改动写回系统日程，也记进「诊断」。<br>「动态复核」设成 0 时这条不会发生。" },
      { title: "惦记账本", fields: [
        { type: "toggles", items: [{ key: "threadsOn", label: "跨天记住话头、约定和日子" }] },
        { type: "stepper", key: "threadDays", min: 1, max: 14, step: 1, label: "话头几天没再提就淡掉", unit: "天" },
      ], hint: "复核时顺带从聊天里记下没聊完的话头、约好的事、重要的日子；起念、生成明天、注入聊天、到点发消息都会看它。约定快到点、刚过点、到日子了，TA会自己想起来找你（走云端自发起念）。「今天」页能手动记和了结。" },
      { title: "注入聊天", fields: [{ type: "toggles", items: [{ key: "injectChat", label: "让TA聊天时知道自己此刻的状态" }] }],
        hint: "让TA聊天时知道自己此刻在做什么、什么心情、剩多少精力、接下来做什么。<br>每次刷新覆盖上一次，不会堆进聊天记录，也不影响前面人设和世界书的缓存。<br>关掉立刻撤销。" },
    ] },
    { id: "cloud", name: "云端", groups: [
      { title: "云连接", sub: "个人云后端，选填", fields: [
        { type: "text", key: "cloudUrl", placeholder: "https://xxxx.supabase.co" },
        { type: "text", key: "cloudKey", password: true, placeholder: "sb_secret_… 或 service_role key" },
        { type: "cloudTest" },
        { type: "toggles", items: [{ key: "cloudRecheck", label: "浏览器关着也复核" }] },
      ], hint: "填小手机「云服务部署」里那个 Supabase 项目的地址和 Secret key。密钥只存在本机，只发往这个地址。<br>开了「浏览器关着也复核」，今天的计划会寄存到云上，云端每 5 分钟醒一次，按你们最新的聊天重审（先过下面的门禁）。下次打开挂念，TA在云端改的主意会并进来。" },
      { title: "复核门禁", adv: true, sub: "拦下来的不花钱、不占额度", fields: [
        { type: "stepper", key: "gateDailyCap", min: 1, max: 24, step: 1, label: "每天最多判", unit: "次" },
        { type: "stepper", key: "gateGapMin", min: 5, max: 240, step: 5, label: "两次判至少隔", unit: "分钟" },
        { type: "stepper", key: "gateHorizonMin", min: 0, max: 720, step: 30, label: "最近的时刻比这更远就先不判", unit: "分钟 · 0 不限" },
        { type: "stepper", key: "gateFreshMin", min: 0, max: 60, step: 5, label: "你刚说完先等", unit: "分钟 · 0 不等" },
        { type: "stepper", key: "gateMinMsgs", min: 1, max: 10, step: 1, label: "上次判完你至少说", unit: "句" },
        { type: "stepper", key: "selfImpulseCap", min: 0, max: 12, step: 1, label: "自发念头每天最多", unit: "次 · 0 关" },
        { type: "stepper", key: "selfSilenceMin", min: 30, max: 480, step: 30, label: "多久没联系算安静", unit: "分钟" },
        { type: "stepper", key: "missDays", min: 0, max: 14, step: 1, label: "断了几天会想念", unit: "天 · 0 关" },
        { type: "toggles", items: [{ key: "echoOn", label: "想起昨天聊过的小事" }] },
      ], hint: "云端每 5 分钟醒一次（cron 频率，见 README），先过这几道门，全过了才真的调一次模型。拦下来的不花钱，原因记在「诊断」。<br>自发起念分五种由头：刚做完一件要紧的事、惦记到点、安静太久、想念、余韵。安静太久按小时算；断到「想念」那么多天后就不再按小时追，整段断联只在白天掷一次骰子（56%）想不想TA；余韵是每天白天掷一次（24%），想起昨天聊过的一件轻松小事顺手提一句。TA自己起的念头发出去没回音时，这三种都不追。每次都调模型，所以单独限次，重新编排后清零。<br>保存并成功同步今天的计划后，下一次云端复核使用新门禁；仅调整数值无需重新部署云函数。" },
      { title: "发送前复核", adv: true, sub: "到点真发之前再判一次", fields: [
        { type: "stepper", key: "presendMax", min: 30, max: 100, step: 5, label: "不合时宜度超过就不发", unit: "% · 100 从不拦" },
        { type: "stepper", key: "presendTalkingMin", min: 0, max: 120, step: 5, label: "你最后一句在多久内算正聊着", unit: "分钟" },
        { type: "stepper", key: "presendGapMin", min: 0, max: 240, step: 15, label: "离TA上一条主动多近算太密", unit: "分钟" },
      ], hint: "到点真发之前再算一次「不合时宜度」：你一直没回、你正聊着、TA刚主动过，都会加分。超过阈值这条就悄悄作废。<br>不调模型。点开那条时刻能看到它几分过的、或被什么拦下。需要开着聊天镜像。" },
      { title: "忙与睡", sub: "到点了TA顾不上呢", fields: [
        { type: "toggles", items: [{ key: "busyHold", label: "忙着就押后再发" }] },
        { type: "stepper", key: "busyBufferMin", min: 0, max: 60, step: 5, label: "忙完 / 醒来再等", unit: "分钟" },
        { type: "stepper", key: "busyMaxHoldMin", min: 30, max: 480, step: 30, label: "最多押后", unit: "分钟 · 超过就作罢" },
        { type: "seg", key: "sleepMode", options: [[0, "睡着就不发"], [1, "押到起床后"], [2, "概率醒来"]] },
        { type: "stepper", key: "sleepWakeProb", min: 5, max: 60, step: 5, label: "醒来的概率", unit: "%" },
        { type: "toggles", items: [{ key: "replyGate", label: "你发消息时也照此办" }] },
        { type: "stepper", key: "busyPeekMin", min: 0, max: 30, step: 1, label: "忙着时偷空回要等", unit: "分钟 · 0 不等" },
      ], hint: "到点时TA正忙（上课、开会、开车这类，生成日程时标的），主动消息就押到忙完再加几分钟（按这个数上下浮动四成）；押得超过上限就作罢。睡着了按选的办：不发、押到起床后、或按概率迷迷糊糊醒来说一两句。只管云端预约。<br>「你发消息时也照此办」管的是TA回你：睡着押到起床后再回（选了「概率醒来」就按同一概率被吵醒）；忙着就当偷空看了眼手机，等这个分钟数左右再回。押后期间再发只重新计时，最后一并回。带「救命、医院、快回」的消息不押。<br>等待期间小手机得开着（不用停在聊天窗）；整个关了的话，下次打开时补回。" },
    ] },
  ];
  const SET_SCHEMA = SET_SECTIONS.reduce((acc, sec) => acc.concat(sec.groups), []);
  const SET_FIELDS = () => SET_SCHEMA.reduce((acc, g) => acc.concat(g.fields || []), []);
  function segLabel(key, value) {
    for (const f of SET_FIELDS()) {
      if (f.type === "seg" && f.key === key) {
        const hit = (f.options || []).find((o) => +o[0] === +value);
        if (hit) return hit[1];
      }
    }
    return String(value);
  }

  function fieldHtml(f) {
    if (f.type === "chars") return '<div class="char-grid" id="char-grid"></div>';
    if (f.type === "timeRange") {
      if (f.keys.length === 1) return '<div class="frow"><div class="fl">' + esc(f.label || "") + '</div><input type="time" id="set-' + f.keys[0] + '"></div>';
      return '<div class="field-row"><input type="time" id="set-' + f.keys[0] + '">' +
        '<span style="color:var(--tx3)">—</span><input type="time" id="set-' + f.keys[1] + '"></div>';
    }
    if (f.type === "stepper") {
      const ctl = '<div class="stepper"><button data-step="' + f.key + '" data-d="-1">−</button>' +
        '<div class="val" id="set-' + f.key + '">' + SET_DEF[f.key] + "</div>" +
        '<button data-step="' + f.key + '" data-d="1">＋</button></div>';
      return '<div class="frow"><div class="fl">' + esc(f.label || "") + (f.unit ? '<div class="fu">' + esc(f.unit) + "</div>" : "") + "</div>" + ctl + "</div>";
    }
    if (f.type === "seg") {
      return '<div class="seg" id="set-' + f.key + '">' +
        (f.options || []).map((o) => '<button data-v="' + o[0] + '">' + esc(o[1]) + "</button>").join("") + "</div>";
    }
    if (f.type === "toggles") {
      return '<div class="tgl-row">' +
        (f.items || []).map((it) => '<button class="tgl" id="set-' + it.key + '">' + esc(it.label) + "</button>").join("") + "</div>";
    }
    if (f.type === "text") {
      return '<input type="' + (f.password ? "password" : "text") + '" class="txt-in" id="set-' + f.key +
        '" placeholder="' + esc(f.placeholder || "") + '" spellcheck="false" autocomplete="off">';
    }
    if (f.type === "cloudTest") {
      return '<div class="cloud-row"><button class="tgl" id="btn-cloud-test">测试连接</button><span id="cloud-test-r"></span></div>';
    }
    return "";
  }

  function openSheet() {
    const cx = cur();
    // 四节用页签切，所有节都渲染在 DOM 里只是藏起来：回填 / 读表按 id 找，不用管哪节在前台
    const tab = SET_SECTIONS.some((x) => x.id === S._setTab) ? S._setTab : SET_SECTIONS[0].id;
    let gi = 0;
    $("#sheet-body").innerHTML =
      '<div class="stabs">' + SET_SECTIONS.map((sec) =>
        '<button type="button" class="stab' + (sec.id === tab ? " on" : "") + '" data-sec="' + sec.id + '">' + esc(sec.name) + "</button>").join("") + "</div>" +
      SET_SECTIONS.map((sec) => '<div class="ssec" data-sec="' + sec.id + '"' + (sec.id === tab ? "" : " hidden") + ">" +
        sec.groups.map((g) => {
          const i = gi++;
          return '<div class="grp' + ((g.fields || []).length ? "" : " note") + (g.adv ? " adv" : "") + '"' + (g.adv && !S.settings.showAdv ? " hidden" : "") + ">" + (g.title ? '<div class="grp-t"><span>' + esc(g.title) + "</span>" +
            (g.sub ? '<span class="grp-sub">' + esc(g.sub) + "</span>" : "") +
            (g.hint && !g.open ? '<button type="button" class="grp-i" data-hint="' + i + '" aria-label="说明">?</button>' : "") + "</div>" : "") +
            (g.fields || []).map(fieldHtml).join("") +
            (g.hint ? '<div class="grp-hint" id="grp-hint-' + i + '"' + (g.open ? "" : " hidden") + ">" + g.hint + "</div>" : "") + "</div>";
        }).join("") +
        // 高级组默认收着：多数人一辈子不碰门禁那几个数字。开关全局记在设置里，四节一起开
        (function () {
          const n = sec.groups.filter((g) => g.adv).length;
          if (!n) return "";
          return '<button type="button" class="adv-more">' + (S.settings.showAdv ? "收起高级设置" : "还有 " + n + " 项高级设置") + "</button>";
        })() + "</div>").join("");
    $("#sheet-body").querySelectorAll(".adv-more").forEach((btn) => {
      btn.onclick = () => {
        const on = !S.settings.showAdv;
        S.settings.showAdv = on; // 先改内存让本次渲染生效，落盘走后台
        patchSettings(() => ({ showAdv: on })).catch(() => {});
        $("#sheet-body").querySelectorAll(".grp.adv").forEach((g) => { g.hidden = !on; });
        $("#sheet-body").querySelectorAll(".adv-more").forEach((b) => { b.textContent = on ? "收起高级设置" : "还有 " + b.closest(".ssec").querySelectorAll(".grp.adv").length + " 项高级设置"; });
      };
    });
    $("#sheet-body").querySelectorAll(".stab").forEach((btn) => {
      btn.onclick = () => {
        S._setTab = btn.dataset.sec;
        $("#sheet-body").querySelectorAll(".stab").forEach((x) => x.classList.toggle("on", x === btn));
        $("#sheet-body").querySelectorAll(".ssec").forEach((x) => { x.hidden = x.dataset.sec !== btn.dataset.sec; });
      };
    });
    $("#sheet-body").querySelectorAll(".grp-i").forEach((btn) => {
      btn.onclick = () => {
        const box = $("#grp-hint-" + btn.dataset.hint);
        if (!box) return;
        box.hidden = !box.hidden;
        btn.classList.toggle("on", !box.hidden);
      };
    });
    const grid = $("#char-grid");
    if (grid) {
      grid.innerHTML = S.characters.map((c) =>
        '<div class="char-cell' + (S.order.includes(c.id) ? " sel" : "") + '" data-id="' + esc(c.id) + '">' +
        '<div class="ava">' + (c.avatar ? '<img src="' + esc(c.avatar) + '" alt="">' : esc((c.name || "?").slice(0, 1))) + "</div>" +
        '<div class="nm">' + esc(c.name) + "</div></div>").join("") || '<div class="nt" style="color:var(--tx3);font-size:12px">暂无角色</div>';
      grid.querySelectorAll(".char-cell").forEach((el) => {
        el.onclick = () => { el.classList.toggle("sel"); };
      });
    }
    for (const f of SET_FIELDS()) {
      if (f.type === "timeRange") f.keys.forEach((k) => { $("#set-" + k).value = S.settings[k] || SET_DEF[k]; });
      else if (f.type === "stepper") $("#set-" + f.key).textContent = S.settings[f.key];
      else if (f.type === "seg") document.querySelectorAll("#set-" + f.key + " button")
        .forEach((b) => b.classList.toggle("on", +b.dataset.v === (+S.settings[f.key] || 0)));
      else if (f.type === "toggles") (f.items || []).forEach((it) => $("#set-" + it.key).classList.toggle("on", !!S.settings[it.key]));
      else if (f.type === "text") $("#set-" + f.key).value = S.settings[f.key] || "";
    }
    bindSheet();
    document.body.classList.add("sheet-open");
  }
  function closeSheet() { document.body.classList.remove("sheet-open"); }

  function bindSheet() {
    const stepper = {};
    for (const f of SET_FIELDS()) if (f.type === "stepper") stepper[f.key] = f;
    $("#sheet-body").querySelectorAll("[data-step]").forEach((b) => {
      b.onclick = () => {
        const f = stepper[b.dataset.step];
        const el = $("#set-" + f.key);
        const next = (+el.textContent || 0) + (+b.dataset.d) * f.step;
        el.textContent = Math.max(f.min, Math.min(f.max, next));
      };
    });
    $("#sheet-body").querySelectorAll(".seg button").forEach((b) => {
      b.onclick = () => { b.parentNode.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
    });
    $("#sheet-body").querySelectorAll(".tgl").forEach((b) => { b.onclick = () => {
      b.classList.toggle("on");
      if (b.id === "set-userSleepOn") syncUserSleepFields();
    }; });
    syncUserSleepFields();
    const test = $("#btn-cloud-test");
    if (test) test.onclick = async () => {
      const r = $("#cloud-test-r");
      const u = ($("#set-cloudUrl").value || "").trim().replace(/\/+$/, "");
      const k = ($("#set-cloudKey").value || "").trim();
      if (!/^https:\/\//.test(u) || !k) { r.textContent = "先填完整地址和密钥"; return; }
      r.textContent = "测试中…";
      try {
        const res = await fetch(u + "/functions/v1/ai-phone-push?action=health", { cache: "no-store", headers: { "x-ai-phone-service-key": k } });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || ("HTTP " + res.status));
        const mir = (data.capabilities || []).indexOf("chat-mirror") >= 0;
        r.textContent = "✓ 已连通 · 云函数 v" + (data.schemaVersion || "?") +
          (mir ? " · 支持聊天镜像" : " · 版本偏旧：去小手机「设置→云服务部署」重新部署离线推送");
      } catch (e) { r.textContent = "✗ " + (e && e.message || e); }
    };
  }

  function syncUserSleepFields() {
    const toggle = $("#set-userSleepOn");
    const enabled = !!(toggle && toggle.classList.contains("on"));
    for (const key of ["userSleepStart", "userSleepEnd"]) {
      const input = $("#set-" + key);
      if (input) input.disabled = !enabled;
    }
  }
  function validateUserSleepSettings(settings) {
    if (!settings.userSleepOn) return;
    const valid = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
    if (!valid(settings.userSleepStart) || !valid(settings.userSleepEnd)) throw new Error("请填写有效的睡眠开始和结束时间");
    if (settings.userSleepStart === settings.userSleepEnd) throw new Error("睡眠开始和结束时间不能相同；不需要固定时段可关闭此选项");
  }

  function readSheet() {
    const out = {};
    for (const f of SET_FIELDS()) {
      if (f.type === "timeRange") f.keys.forEach((k) => { out[k] = $("#set-" + k).value || SET_DEF[k]; });
      else if (f.type === "stepper") {
        const n = +$("#set-" + f.key).textContent;
        out[f.key] = isFinite(n) ? Math.max(f.min, Math.min(f.max, n)) : SET_DEF[f.key];
      } else if (f.type === "seg") {
        const on = document.querySelector("#set-" + f.key + " button.on");
        out[f.key] = on ? +on.dataset.v : SET_DEF[f.key];
      } else if (f.type === "toggles") (f.items || []).forEach((it) => { out[it.key] = $("#set-" + it.key).classList.contains("on"); });
      else if (f.type === "text") out[f.key] = ($("#set-" + f.key).value || "").trim();
    }
    if (typeof out.cloudUrl === "string") out.cloudUrl = out.cloudUrl.replace(/\/+$/, "");
    return out;
  }

  // 保存只更新设置和计划上下文，不会自动撤销或重建已经存在的预约。
  function settingsSaveEffects(before, after) {
    const changed = (keys) => keys.some((key) => before[key] !== after[key]);
    const notes = [];
    if (changed(["userSleepOn", "userSleepStart", "userSleepEnd"])) notes.push(after.userSleepOn
      ? "你的睡眠时段已保存；计划同步成功后，尚未结算的回音会跳过这段时间，已结算记录不重算。"
      : "睡眠时段已关闭；计划同步成功后，尚未结算的回音恢复按发送后 3 小时统计。未回复仍保持中性。");
    if (changed(["quota", "minGapMin", "bias", "quietStart", "quietEnd", "anchorSleep", "anchorMorning", "chatCandidates", "moodGate"])) {
      notes.push(+after.impulseMode === 1 && after.cloudRecheck && cloudCfg()
        ? "新规则同步成功后用于下一次云端起念。已有预约保持原样；如需一起调整，请到「心动」页重新安排。"
        : "新规则已保存。要让今天已排的时刻按新规则重新安排，请到「心动」页点「重新编排」。");
    }
    if (changed(["maxUnanswered"])) notes.push("未回应降速的新阈值用于新建预约；已有预约保留原阈值。重新编排保留的临时起念也不会自动更新。");
    if (changed(["impulseMode"])) notes.push("起念模式已保存，后续判断使用新模式；已有预约不会自动转换。如需整理今天的预约，请到「心动」页点「" + (+after.impulseMode === 1 && after.cloudRecheck && cloudCfg() ? "重置今天" : "重新编排") + "」。");
    if (changed(["autoGen", "cloudGen", "autoGenAt"]) && after.autoGen && after.cloudGen) notes.push("本机自动生成设置已更新；云端明日生成原料会在下次打开挂念或重新编排时刷新，今天的同步结果不代表明日设置已更新。");
    return notes;
  }
  function renderSettingsEffects() {
    const box = $("#settings-effects");
    if (!box) return;
    const notes = S._settingsEffects || [];
    box.hidden = !notes.length;
    box.innerHTML = notes.length ? '<div class="card"><div class="sec-head"><span class="t">设置已保存 · 生效说明</span></div>' +
      notes.map((note) => '<div class="d-why">' + esc(note) + '</div>').join("") + '</div>' : "";
  }

  async function saveSettings() {
    const picked = Array.from(document.querySelectorAll(".char-cell.sel")).map((el) => el.dataset.id);
    const ids = picked.length ? picked : S.order.slice();
    const prevIds = S.order.slice();
    const removed = prevIds.filter((id) => !ids.includes(id));
    const added = ids.filter((id) => !prevIds.includes(id));
    const sheet = readSheet();
    validateUserSleepSettings(sheet);
    if (!ids.includes(S.cur)) S.cur = ids[0] || "";
    const before = Object.assign({}, S.settings);
    const cloudGenWas = !!S.settings.cloudGen;
    await patchSettings(() => Object.assign({ characterIds: ids, characterId: S.cur }, sheet));
    S._settingsEffects = settingsSaveEffects(before, S.settings);
    renderSettingsEffects();
    closeSheet();
    // 关掉云端生成：宿主每次角色回复后还会替我们重冻模板，得告诉它别冻了
    if (cloudGenWas && !S.settings.cloudGen) for (const cx of allCx()) await unfreezeGenTemplates(cx);
    // 不再挂念的人：身上注入的状态得撤掉，不然TA会一直以为自己在过挂念的那一天
    for (const id of removed) {
      const cx = S.byId[id];
      if (cx && cx.character) await forgetCharacter(cx);
      if (AiPhone.chat && AiPhone.chat.clearContext) { try { await AiPhone.chat.clearContext({ characterId: id }); } catch (e) { /* 未授权时无所谓 */ } }
      if (AiPhone.chat && AiPhone.chat.setReplyGate) { try { await AiPhone.chat.setReplyGate({ characterId: id, gate: null }); } catch (e) { /* 同上 */ } }
      delete S.byId[id];
    }
    for (const id of added) {
      S.byId[id] = ctxOf(S.characters.find((c) => c.id === id));
      await loadDayAndPlan(S.byId[id]);
    }
    S.order = ids;
    const syncResults = [];
    for (const cx of allCx()) {
      cx._ctx = null; // 开关可能变了，强制重写一次（包括关掉时写空串撤销）
      await syncChatContext(cx, true);
      if (cloudCfg()) syncResults.push(await syncSavedPlan(cx, before.cloudRecheck !== S.settings.cloudRecheck || planSyncState(cx)?.operation === "control"));
    }
    syncUsageCloud(true).catch(() => { /* 已在函数内记日志 */ });
    render();
    const incomplete = syncResults.some((r) => ["failed", "partial", "syncing"].includes(r.status));
    toast(incomplete ? "本地已保存，云端同步未完成；请查看页面提示"
      : !S.settings.cloudRecheck && syncResults.some((r) => r.status === "synced") ? "本地已保存，云端已确认关闭复核"
      : syncResults.some((r) => r.status === "readonly") ? "本地已保存，部分角色由其他设备负责，未上传"
      : syncResults.some((r) => r.status === "synced") ? "本地已保存，现有计划已同步云端"
      : "本地已保存" + (cloudRecheckOn() ? "；生成今天的计划后再同步云端" : "；云端复核未启用"));
  }
