  /* ================= 诊断页：结论 + 要处理 + 其余 =================
     加一块诊断 = 往 DIAG_ITEMS 里加一条，再在下面 fill 一次。
     fill 同时写「展开后的细节」和「收起时那一行结论」，tone 决定颜色；
     warn / bad 的挪进「要处理」那张卡并自动展开，其余按表里的顺序收在下面一张；
     顶上的结论卡按各块的 tone 算。info 类（日志、预览）不参与结论。
     手动点过的记在 S._diagOpen，云端结果陆续回来时不会把它又合上。 */
  const DIAG_ITEMS = [
    // 自己在管是常态，只在「连接与聊天镜像」里占一行；别的设备在管才单独出一张（要动手的状态）
    { id: "lock", title: "今天谁在管", cloud: true, when: (cx) => !!(cx.owner && cx.owner.id) && !owns(cx) },
    { id: "cloud", title: "连接与聊天镜像", cloud: true },
    { id: "jobs", title: "预约与降速", cloud: true },
    { id: "recheck", title: "动态复核", cloud: true },
    { id: "wakes", title: "系统唤醒对照" },
    { id: "echo", title: "念头的回音", info: true },
    { id: "logs", title: "运行日志", info: true },
    { id: "preview", title: "此刻预览", info: true },
  ];
  const CLOUD_DIAG_IDS = { lock: 1, cloud: 1, jobs: 1, recheck: 1 };
  const DIAG_TTL = 60000;

  async function renderUsage() {
    const v = $("#subview") || $("#view");
    const req = (S._usageReq = (S._usageReq || 0) + 1);
    v.innerHTML = '<div class="card empty"><div class="art">⏳</div><p>正在统计…</p></div>';
    await readLocalUsage(true);
    await syncUsageCloud(false);
    if (!(S.tab === "back" && S.sub === "usage") || req !== S._usageReq) return;
    const t = usageTotals();
    const stat = (n, cap) => '<div class="stat"><div class="num">' + n + '</div><div class="cap">' + cap + "</div></div>";
    const bar = (n, cap) => cap > 0 ? '<div class="usage-bar"><div class="fill" style="width:' + Math.min(100, Math.round(n / cap * 100)) + '%"></div></div>' : "";
    let html = '<div class="card"><div class="sec-head"><span class="t">今 日 用 量</span>' +
      '<span class="badge' + (usageOver() ? " warn" : (t.capCalls || t.capTokens ? " ok" : "")) + '">' + (usageOver() ? "到上限了" : (t.capCalls || t.capTokens ? "额度内" : "没设上限")) + "</span></div>" +
      '<div class="stats four">' + stat(t.calls + (t.capCalls ? "<small>/" + t.capCalls + "</small>" : ""), "调 用") + stat(fmtTok(t.tokens) + (t.capTokens ? "<small>/" + fmtTok(t.capTokens) + "</small>" : ""), "token") +
      stat(t.localCalls + (t.otherCalls ? "<small>+" + t.otherCalls + "</small>" : ""), "本 机") + stat(t.cloudCalls, "云 端") + "</div>" +
      bar(t.calls, t.capCalls) + bar(t.tokens, t.capTokens) +
      '<div class="archive-note">上限在设置「模型调用」里改。本机按次和 token 都由宿主统计；云端由云函数记账，聊天离线兜底的调用只记不限。'
      + (t.otherCalls ? "「本机」后面的 +" + t.otherCalls + " 是另一台设备今天调的，也占同一份上限。" : "") + "</div></div>";
    const srcRows = [{ source: myUsageSrc(), calls: t.localCalls, prompt: (S._useLocal || {}).prompt || 0, completion: (S._useLocal || {}).completion || 0 }]
      .concat(t.rows.map((r) => ({ source: r.source, calls: +r.calls || 0, prompt: +r.prompt_tokens || 0, completion: +r.completion_tokens || 0 }))
        .filter((r) => r.calls || r.prompt || r.completion));
    html += '<div class="card"><div class="sec-head"><span class="t">按 来 源</span></div>' +
      srcRows.map((r) => '<div class="diag-item"><b>' + esc(usageLabel(r.source)) + "</b> " + r.calls + " 次 · " + fmtTok(r.prompt) + " 入 / " + fmtTok(r.completion) + " 出</div>").join("") +
      (cloudCfg() ? "" : '<div class="archive-note">没配云连接，只有本机的数。</div>') + "</div>";
    const byDay = {};
    for (const d of ((S._useLocal || {}).days || [])) byDay[d.date] = { calls: d.calls, tokens: d.prompt + d.completion };
    for (const r of ((S._use || {}).rows || [])) {
      if (r.source === myUsageSrc() || r.source === "app") continue; // 自己那行已经在 byDay 里了
      const x = byDay[r.day] = byDay[r.day] || { calls: 0, tokens: 0 };
      x.calls += +r.calls || 0; x.tokens += (+r.prompt_tokens || 0) + (+r.completion_tokens || 0);
    }
    const days = Object.keys(byDay).sort().reverse().slice(0, 7);
    html += '<div class="card"><div class="sec-head"><span class="t">最 近 7 天</span></div>' +
      (days.length ? days.map((d) => '<div class="diag-item"><b>' + esc(d.slice(5)) + "</b> " + byDay[d].calls + " 次 · " + fmtTok(byDay[d].tokens) + " token" + (d === todayStr() ? ' <span class="badge cool">今天</span>' : "") + "</div>").join("")
        : '<div class="archive-note">还没有记录。</div>') + "</div>";
    v.innerHTML = html;
  }

  async function renderDiag() {
    const cx = cur();
    const v = $("#subview") || $("#view");
    const req = (S._diagReq = (S._diagReq || 0) + 1);
    const alive = () => S.tab === "back" && S.sub === "diag" && req === S._diagReq;
    S._diagOpen = S._diagOpen || {};

    const setOpen = (id, on) => {
      const it = $("#dgi-" + id), bd = $("#diag-" + id);
      if (!it || !bd) return;
      it.classList.toggle("open", !!on);
      bd.hidden = !on;
    };
    const tones = {};
    const shown = DIAG_ITEMS.filter((c) => !c.when || c.when(cx)).filter((c) => !c.cloud || cloudCfg());
    // 要处理的挪到上面那张卡（bad 在 warn 前），其余按表里的顺序留在下面
    const layout = () => {
      const attn = $("#dg-attn"), rest = $("#dg-ok");
      if (!attn || !rest) return;
      const rank = (c) => tones[c.id] === "bad" ? 0 : tones[c.id] === "warn" ? 1 : 2;
      for (const c of shown.slice().sort((a, b) => rank(a) - rank(b))) {
        const el = $("#dgi-" + c.id); if (!el) continue;
        el.classList.toggle("bad", tones[c.id] === "bad");
        el.classList.toggle("warn", tones[c.id] === "warn");
        (rank(c) < 2 ? attn : rest).appendChild(el);
      }
      attn.hidden = !attn.querySelector(".dg-item");
    };
    const summarize = () => {
      const box = $("#dg-sum"); if (!box) return;
      const status = shown.filter((c) => !c.info);
      const pending = status.filter((c) => !(c.id in tones));
      const bad = status.filter((c) => tones[c.id] === "bad"), warn = status.filter((c) => tones[c.id] === "warn");
      let dot = "", head = "", sub = "";
      if (bad.length || warn.length) {
        dot = bad.length ? "bad" : "warn";
        head = (bad.length + warn.length) + " 处要处理";
        sub = bad.concat(warn).map((c) => c.title).join(" · ") + (pending.length ? "（还在查 " + pending.length + " 项）" : "");
      } else if (pending.length) {
        dot = ""; head = "检查中…"; sub = "已看完 " + (status.length - pending.length) + " / " + status.length + " 项";
      } else {
        dot = "ok"; head = "一切正常"; sub = "本机" + (cloudCfg() ? "和云端" : "") + "都在正常跑";
      }
      if (!cloudCfg()) sub += (sub ? "；" : "") + "没接云连接，云端复核、浏览器关着也生成、设备锁都停着";
      box.innerHTML = '<div class="row"><span class="dot ' + dot + '"></span><span class="head">' + head + "</span>"
        + (!cloudCfg() ? '<button class="tgl" id="btn-diag-cloudset">去设置</button>' : "") + "</div>"
        + (sub ? '<div class="sub">' + esc(sub) + "</div>" : "");
      const cs = $("#btn-diag-cloudset"); if (cs) cs.onclick = () => { S._setTab = "cloud"; openSheet(); };
    };
    const fillRaw = (id, html, sum, tone) => {
      if (!alive()) return;
      const bd = $("#diag-" + id), sm = $("#dgs-" + id);
      if (!bd) return;
      bd.innerHTML = html;
      if (sm) { sm.className = "sm" + (tone ? " " + tone : ""); sm.textContent = sum || ""; }
      tones[id] = tone || "";
      setOpen(id, id in S._diagOpen ? S._diagOpen[id] : (tone === "warn" || tone === "bad"));
      layout(); summarize();
    };
    // 云端那几张卡每进一次诊断页就各发一次请求，页签来回切就重复发。
    // 结果连同摘要缓存 60 秒；计划一变（uploadPlanCloud）或接管过就整份作废。
    const ckey = (id) => id + ":" + cx.character.id;
    const fill = (id, html, sum, tone) => {
      if (CLOUD_DIAG_IDS[id]) S._diagCache[ckey(id)] = { at: Date.now(), html: html, sum: sum, tone: tone };
      fillRaw(id, html, sum, tone);
    };
    const diagRestore = (id) => {
      const c = S._diagCache[ckey(id)];
      if (!c || Date.now() - c.at >= DIAG_TTL) return false;
      fillRaw(id, c.html, c.sum, c.tone);
      return true;
    };

    S._diagCache = S._diagCache || {};
    const logItems = (S.logs && S.logs.items || []).slice().reverse();
    const planItems = (cx.plan && cx.plan.items) || [];

    // 没接云连接时云端那几块不画，结论卡里说一句、留个去设置的入口
    v.innerHTML = '<div class="card dg-sum" id="dg-sum"></div>'
      + '<div class="card dg" id="dg-attn" hidden></div>'
      + '<div class="card dg" id="dg-ok">'
      + shown.map((c) =>
          '<div class="dg-item" id="dgi-' + c.id + '">' +
            '<button class="dg-hd" data-dg="' + c.id + '"><span class="nm">' + esc(c.title) + "</span>" +
            '<span class="sm" id="dgs-' + c.id + '">读取中…</span><span class="cv">›</span></button>' +
            '<div class="dg-bd" id="diag-' + c.id + '" hidden><div class="archive-note">读取中…</div></div>' +
          "</div>").join("")
      + "</div>"
      + '<div class="archive-note">日志最多保留 120 条，只存在本地，不上传。</div>';
    summarize();

    v.querySelectorAll(".dg-hd").forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.dg;
        const on = !$("#dgi-" + id).classList.contains("open");
        S._diagOpen[id] = on;
        setOpen(id, on);
      };
    });

    // 拿此刻的状态让TA说一句，只显示不发送：用来核对注入的状态对不对
    fill("preview", cx.day
      ? '<div class="archive-note">按TA此刻的状态生成一句话，不发送、不进聊天、不占额度，花一次模型调用。</div>' + previewZone()
      : '<div class="archive-note">TA的今天还没生成，没有状态可看。</div>', cx.day ? "" : "没状态", "");
    { const pv = $("#btn-preview"); if (pv) pv.onclick = () => preview(cur()); }
    // 云端回音账只给有限正反馈，不把用户忙碌、睡眠或未读造成的沉默当负面偏好。
    {
      const KIND_LABEL = { plan: "早上定的", extra: "临时起念", thread: "惦记", done: "刚忙完", miss: "想念", echo: "余韵", quiet: "安静太久" };
      const fb = (S.settings.fbState || {})[cx.character ? cx.character.id : ""] || {};
      const rows = Object.keys(fb).filter((k) => Array.isArray(fb[k]) && +fb[k][0] > 0)
        .sort((a, b) => (+fb[b][0] || 0) - (+fb[a][0] || 0));
      const mod = (sent, rep) => { const n = Math.max(0, Math.min(sent, rep)); return n < 3 ? 1 : 1 + Math.min(0.2, (n - 2) * 0.04); };
      const total = rows.reduce((n, k) => n + (+fb[k][0] || 0), 0);
      fill("echo", rows.length
        ? rows.map((k) => {
            const sent = +fb[k][0] || 0, rep = +fb[k][1] || 0, m = mod(sent, rep);
            return '<div class="diag-item"><b>' + esc(KIND_LABEL[k] || k) + "</b> 发过 " + sent + " 次 · 之后接话 " + rep + " 次" +
              (m > 1 ? ' <span class="badge">正向参考 ×' + m.toFixed(2) + "</span>" : ' <span class="badge cool">保持中性</span>') + "</div>";
          }).join("") + '<div class="archive-note">按实际发送后的 3 小时窗口统计是否有后续接话（若启用你的睡眠时段，会跳过该时段计时），不代表对这条消息的明确喜好。你可能在忙、睡觉或没看到：未接话不扣分，也不会被告诉模型是「不喜欢」。至少 3 次接话后才给轻微正向参考，最多 ×1.20；未回应降速仍独立生效，避免连续打扰。</div>'
        : '<div class="archive-note">还没有账。云端复核会在TA每条主动消息发出、累计等待 3 小时后记一笔（启用的用户睡眠时段不计时）：之后有接话就记一笔正向参考，没有接话保持中性。</div>',
        total ? total + " 条 · " + rows.length + " 类" : "还没有", "");
    }
    // 日志是本地现成的，先画上，别让整页都在等云端
    if (!logItems.length) {
      fill("logs", '<div class="archive-note">还没有日志。生成、编排、复核、预约的每一步都会记在这里。</div>', "还没有", "");
    } else {
      const today = todayStr();
      fill("logs",
        '<div class="dg-act"><button class="tgl" id="btn-clear-log">清空</button></div>' +
        logItems.map((l) => {
          const d = new Date(l.at);
          const ds = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
          return '<div class="diag-item"><b>' + (ds === today ? "" : ds.slice(5).replace("-", "/") + " ") + fmtHM(l.at) + "</b> " + esc(l.text) + "</div>";
        }).join(""),
        logItems.length + " 条 · 最近 " + fmtHM(logItems[0].at), "");
      const clr = $("#btn-clear-log");
      if (clr) clr.onclick = async () => {
        try { if (S.logs) S.logs = await AiPhone.db.update("logs", S.logs.id, { items: [] }); } catch (e) { toast("清空失败：" + (e && e.message || e)); }
        renderDiag();
      };
    }

    // 设备锁：今天由哪台设备负责编排和预约。自己在管时那行由「连接与聊天镜像」带出来，
    // 别的设备在管才单独出一张卡（这是唯一需要动手的状态）。
    (async () => {
      if (!cloudCfg() || diagRestore("lock")) return;
      const before = cx.owner && cx.owner.id || "";
      cx._ownAt = Date.now();
      await readOwner(cx);
      if (!alive()) return;
      // 锁换了主：这张卡在不在都是按旧值渲染的，整页重画一次
      if ((cx.owner && cx.owner.id || "") !== before) { S._diagCache = {}; renderDiag(); return; }
      if (owns(cx)) return;
      fill("lock", '<div class="diag-item"><b>' + esc(ownerLabel(cx)) + " 在管</b> 这台只看不动</div>" +
        '<div class="archive-note">两台一起排会在服务端挂出两套预约，谁也撤不掉谁的，到点发两遍、扣两份额度。' +
        "「改用这台」会先撤掉那台今天挂的预约和 48 小时哨兵，再把今天接过来。</div>" +
        '<div class="dg-act"><button class="tgl" id="btn-takeover"' + (cx.busy ? " disabled" : "") + ">改用这台</button></div>",
        ownerLabel(cx) + " 在管", "warn");
      const to = $("#btn-takeover");
      if (to) to.onclick = () => takeOver(cur());
    })();

    // 系统里真实挂着的今日唤醒（和计划对照，是排查「为什么没推」的关键）
    (async () => {
      let wakes = null;
      try {
        const all = await AiPhone.push.listWakes();
        const d0 = timeToMs("00:00"), d1 = d0 + 86400000;
        wakes = (all || [])
          .filter((w) => w.characterId === cx.character.id && w.fireAt >= d0 && w.fireAt < d1)
          .sort((a, b) => a.fireAt - b.fireAt);
      } catch (e) { /* wakes 保持 null = 读取失败 */ }
      if (!alive()) return;
      // 云端点亮的时刻只存在于云上，本地唤醒表里查不到，不说清楚会被当成「预约没挂上」
      const cloudArmed = planItems.filter((it) => it.act && it.adj === "cloud" && it.wakeId);
      const planned = planItems.filter((it) => it.act && it.fireAt > Date.now()).length;
      let html, sum, tone;
      if (wakes === null) {
        html = '<div class="archive-note">读取系统唤醒列表失败。</div>';
        sum = "读不到"; tone = "bad";
      } else if (!wakes.length) {
        html = '<div class="archive-note">系统里今天没有挂着的离线唤醒。<br>计划里显示「待发」但这里是空的，说明预约没挂上或已被取消。</div>';
        const missing = planned - cloudArmed.length > 0;
        sum = missing ? "0 个 · 计划里还有 " + (planned - cloudArmed.length) + " 个待发" : "0 个 · 今天没有待发";
        tone = missing ? "bad" : "";
      } else {
        const extra = wakes.filter((w) => !planItems.some((it) => it.wakeId === w.id)).length;
        html = wakes.map((w) => {
          const inPlan = planItems.some((it) => it.wakeId === w.id);
          return '<div class="diag-item"><b>' + fmtHM(w.fireAt) + "</b> " + esc(w.intent || "") +
            (inPlan ? "" : ' <span class="badge cool">计划外</span>') + "</div>";
        }).join("");
        sum = wakes.length + " 个 · " + (extra ? extra + " 个计划外" : "都在计划里");
        tone = extra ? "warn" : "ok";
      }
      if (cloudArmed.length) {
        html += '<details class="fold"><summary><span class="t">云端点亮</span><span class="sm">' +
          cloudArmed.length + " 个 · " + esc(cloudArmed.map((it) => it.time).join("、")) +
          '</span><span class="cv">›</span></summary>' +
          '<div class="archive-note">这几个时刻是云端复核点亮的，预约只挂在云上，本地这张表里查不到，属正常。</div></details>';
      }
      fill("wakes", html, sum, tone);
    })();

    if (!cloudCfg()) {
      const none = '<div class="archive-note">未配置云连接。到设置里填你的个人云地址与密钥后，这里会有内容。</div>';
      fill("cloud", none, "未配置", "");
      fill("jobs", none, "未配置", "");
      fill("recheck", none, "未配置", "");
      return;
    }

    // 云端几块异步补上（不阻塞页面；期间切走则丢弃结果）
    (async () => {
      const done = [diagRestore("cloud"), diagRestore("jobs"), diagRestore("recheck")];
      if (done.every(Boolean)) return;
      let caps = [], mySession = "";
      try {
        const h = await cloudFetch("health", { method: "GET" });
        caps = h.capabilities || [];
        const ver = "云函数 v" + String(h.schemaVersion || "?");
        const mir = caps.indexOf("chat-mirror") >= 0;
        // 设备锁的常态（自己在管 / 还没定）就在这里占一行，不单独占一张卡
        const lockLine = !cx.owner || !cx.owner.id
          ? '<div class="diag-item"><b>今天谁在管</b> 还没定 · 谁先生成或编排就归谁</div>'
          : owns(cx) ? '<div class="diag-item"><b>今天谁在管</b> 这台（' + esc(myDevName()) + "）</div>" : "";
        let mHtml = lockLine + '<div class="diag-item"><b>连接</b> 正常 · ' + esc(ver) + "</div>";
        if (!mir) {
          mHtml += '<div class="diag-item"><b>镜像</b> 云函数版本偏旧，还不支持聊天镜像。去小手机「设置 → 云服务部署」重新部署一次离线推送。</div>';
          fill("cloud", mHtml, ver + " · 镜像不支持", "warn");
        } else {
          const g = await cloudFetch("chat-mirror", { method: "GET" }, { characterId: cx.character.id, limit: "1" });
          const last = g.entries && g.entries[0];
          if (last) {
            mySession = last.session_id || "";
            const when = new Date(last.message_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
            mHtml += '<div class="diag-item"><b>镜像</b> 该角色最近一条：' + (last.role === "user" ? "你" : "TA") + " · " + esc(when) + "</div>";
            fill("cloud", mHtml, ver + " · 镜像到 " + when, "ok");
          } else {
            // 该角色查不到时再查全表最新一条，分清是「云端整个是空的」还是「角色ID对不上」
            const any = await cloudFetch("chat-mirror", { method: "GET" }, { limit: "1" });
            const a = any.entries && any.entries[0];
            mHtml += a
              ? '<div class="diag-item"><b>镜像</b> 云端有镜像消息，但和当前角色对不上号。云端最新一条的角色ID：<br>' + esc(a.character_id || "（空）") +
                "<br>当前角色ID：<br>" + esc(String(cx.character.id)) + "<br>把这两个ID截图反馈。</div>"
              : '<div class="diag-item"><b>镜像</b> 云端一条镜像都没有。到小手机「设置 → 云服务部署」确认「聊天镜像」已勾选（勾选动作本身会补传最近聊天），然后随便发一条消息，等半分钟再回这页看。</div>';
            fill("cloud", mHtml, ver + " · " + (a ? "镜像角色对不上" : "镜像是空的"), "bad");
          }
        }
      } catch (e) {
        fill("cloud", '<div class="archive-note">云端查询失败：' + esc(String(e && e.message || e)) + "</div>", "连不上", "bad");
      }

      // 预约带没带降速阈值、到点后拦没拦
      try {
        if (caps.indexOf("job-status") < 0) {
          fill("jobs", '<div class="archive-note">云函数版本偏旧，还看不了预约状态。去小手机「设置 → 云服务部署」重新部署一次离线推送。</div>', "云函数版本偏旧", "warn");
        } else {
          const jr = await cloudFetch("jobs", { method: "GET" }, { kind: "timed_task", limit: "8" });
          const jobs = jr.jobs || [];
          if (!jobs.length) {
            fill("jobs", '<div class="archive-note">云端目前没有定时预约的记录。到「今天」页点「' + replanLabel() + '」挂一个再来看。</div>', "0 条记录", "");
          } else {
            const stName = { pending: "待触发", running: "生成中", done: "已完成", cancelled: "已取消", failed: "失败" };
            let jHtml = jobs.map((j) => {
              const t = new Date(j.executeAt);
              const cooled = /^cooldown skip/.test(j.resultNote || "");
              let line = '<div class="diag-item"><b>' +
                esc(t.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })) + "</b> " +
                esc(stName[j.status] || j.status) +
                (mySession && j.sessionId === mySession ? "" : (j.sessionId ? ' <span class="badge cool">其他角色</span>' : "")) +
                (j.cooldownRounds > 0
                  ? " · 降速阈值 " + j.cooldownRounds + " 轮"
                  : ' · <span class="badge cool">未带阈值</span>');
              if (cooled) line += '<br><span class="badge cool">已降速拦截</span> ' + esc(j.resultNote || "");
              else if (j.resultNote) line += "<br>" + esc(j.resultNote);
              return line + "</div>";
            }).join("");
            const sentinelKeys = Object.values(S.settings.sentinels || {}).map((x) => x && x.wakeId ? "timedwake:" + x.wakeId : "");
            const stale = jobs.some((j) => j.status === "pending" && !(j.cooldownRounds > 0) && sentinelKeys.indexOf(j.triggerKey) < 0) && S.settings.maxUnanswered > 0;
            if (stale) jHtml += '<div class="archive-note">有预约没带降速阈值（旧版挂的）。到「今天」页点「' + replanLabel() + '」重挂一次就带上了。</div>';
            const pendingN = jobs.filter((j) => j.status === "pending").length;
            fill("jobs", jHtml,
              "待触发 " + pendingN + " · 共 " + jobs.length + (stale ? " · 有旧预约" : ""),
              stale ? "warn" : "ok");
          }
        }
      } catch (e) {
        fill("jobs", '<div class="archive-note">预约查询失败：' + esc(String(e && e.message || e)) + "</div>", "查询失败", "bad");
      }

      if (!cloudRecheckOn()) {
        fill("recheck", '<div class="archive-note">「浏览器关着也复核」没打开。开了之后，今天的计划会寄存到你的个人云，' +
          "浏览器关着时云端每 5 分钟醒一次，按最近的聊天重判。</div>", "没打开", "");
        return;
      }
      try {
        if (caps.indexOf("recheck-plan") < 0) {
          fill("recheck", '<div class="archive-note">云函数版本偏旧，还不支持云端复核。去小手机「设置 → 云服务部署」重新部署一次离线推送。</div>', "云函数版本偏旧", "warn");
          return;
        }
        const rr = await cloudFetch("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: todayStr() });
        const pl = rr.plan;
        if (!pl) {
          fill("recheck", '<div class="archive-note">今天的计划还没寄存到云上。到「今天」页点「' + replanLabel() + '」上传一次。</div>', "计划还没寄存", "warn");
          return;
        }
        const pend = (pl.items || []).filter((it) => it.fireAt > Date.now()).length;
        const ran = pl.last_recheck_at
          ? new Date(pl.last_recheck_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "";
        let rHtml = '<div class="diag-item"><b>寄存</b> ' + (pl.items || []).length + " 个时刻（还没到点 " + pend + " 个）</div>" +
          '<div class="diag-item"><b>复核</b> ' + (ran ? esc(ran) : "还没跑过") + " · 今天已判 " + (pl.recheck_count || 0) + "/6 次</div>" +
          '<div class="diag-item"><b>待取裁决</b> ' + ((pl.decisions || []).length || "无") + "</div>";
        if (!pend) rHtml += '<div class="archive-note">今天的时刻都过了，云端不会再判。</div>';
        fill("recheck", rHtml,
          ran ? "已判 " + (pl.recheck_count || 0) + "/6 · 上次 " + ran : "已寄存 · 还没跑过",
          ran ? "ok" : "warn");
      } catch (e) {
        fill("recheck", '<div class="archive-note">云端复核查询失败：' + esc(String(e && e.message || e)) + "</div>", "查询失败", "bad");
      }
    })();
  }

  function bindCommon() {
    const gen = $("#btn-gen"); if (gen) gen.onclick = () => generateDay(cur());
    const rg = $("#btn-regen"); if (rg) rg.onclick = () => generateDay(cur());
    const rp = $("#btn-replan"); if (rp) rp.onclick = () => orchestrate(cur());
    const pv = $("#btn-preview"); if (pv) pv.onclick = () => preview(cur());
  }
