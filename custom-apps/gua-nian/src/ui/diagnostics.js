  /* ================= 诊断页：状态 / 记录 / 工具 三张卡 =================
     加一块诊断 = 往 DIAG_ITEMS 里加一条（sec 决定进哪张卡），再在下面 fill 一次。
     fill 同时写「展开后的细节」和「收起时那一行结论」，tone 决定颜色；
     warn / bad 原地高亮并自动展开，位置固定不搬家；顶上的结论按状态卡各块的 tone 算。
     手动点过的记在 S._diagOpen，云端结果陆续回来时不会把它又合上。
     展开体里只放两种东西：diag-item 行、卡尾一段 archive-note；按钮统一收在最后一行 dg-act。 */
  const DIAG_SECTIONS = [
    { id: "status", title: "状 态" },
    { id: "record", title: "记 录" },
    { id: "tool", title: "工 具" },
  ];
  const DIAG_ITEMS = [
    // 自己在管是常态，只在「连接与聊天镜像」里占一行；别的设备在管才单独出一块（要动手的状态）
    { id: "lock", sec: "status", title: "今天谁在管", cloud: true, when: (cx) => !!(cx.owner && cx.owner.id) && !owns(cx) },
    { id: "cloud", sec: "status", title: "连接与聊天镜像", cloud: true },
    { id: "jobs", sec: "status", title: "消息任务与后台模板", cloud: true },
    { id: "recheck", sec: "status", title: "动态复核", cloud: true },
    { id: "sync", sec: "status", title: "云端同步", cloud: true, ext: true },
    { id: "wakes", sec: "record", title: "本机今日登记", info: true },
    { id: "echo", sec: "record", title: "念头的回音", info: true },
    { id: "logs", sec: "record", title: "运行日志", info: true },
    { id: "preview", sec: "tool", title: "此刻预览", info: true },
    { id: "history", sec: "tool", title: "云端发送记录", cloud: true, info: true, ext: true },
  ];
  // ext：正文不由 renderDiag 画，而是 renderCloudSync / renderCloudHistory 往 #dg-ext-<id> 里画
  function dgItem(id, title, body, sum, tone, open) {
    return '<details class="dg-item' + (tone ? " " + tone : "") + '" id="dgi-' + id + '"' + (open ? " open" : "") + '>' +
      '<summary class="dg-hd"><span class="nm">' + esc(title) + '</span><span class="sm' + (tone ? " " + tone : "") + '" id="dgs-' + id + '">' + esc(sum || "") + '</span><span class="cv">›</span></summary>' +
      '<div class="dg-bd" id="diag-' + id + '">' + body + "</div></details>";
  }
  function dgBindToggle(root) {
    root.querySelectorAll(".dg-item > .dg-hd").forEach((h) => {
      h.onclick = () => { S._diagOpen = S._diagOpen || {}; S._diagOpen[h.parentNode.id.replace(/^dgi-/, "")] = !h.parentNode.open; };
    });
  }
  const CLOUD_DIAG_IDS = { lock: 1, cloud: 1, jobs: 1, recheck: 1 };
  const DIAG_TTL = 60000;

  function diagnosticJobGroups(jobs, characterId, items, sentinels, sessionId) {
    const groups = { waiting: [], templates: [], history: [], others: [], unknown: [] };
    const templateOwners = new Map();
    for (const [owner, template] of Object.entries(sentinels || {})) {
      for (const id of [template && template.wakeId, ...(template && template.previousWakeIds || [])]) {
        if (id) templateOwners.set("timedwake:" + id, owner);
      }
    }
    for (const job of jobs) {
      const item = items.find(w => w.wakeId && job.triggerKey === "timedwake:" + w.wakeId);
      const templateOwner = templateOwners.get(job.triggerKey);
      const markedTemplate = /^timedwake:timed_wake_capp_(?:app_)?gua\.nian_.*_sentinel_\d+_[a-z0-9]+$/i.test(job.triggerKey || "");
      const type = templateOwner || markedTemplate || job.taskType === "template" ? "template"
        : item && item.kind === "promise" || job.taskType === "promise" ? "promise"
        : item || job.taskType === "message" ? "message" : "unknown";
      const owner = job.characterId || templateOwner || (item ? characterId : "");
      const ours = owner ? owner === characterId : !!(sessionId && job.sessionId === sessionId);
      const row = { ...job, type, item, owner };
      if (owner && !ours) groups.others.push(row);
      else if (!ours || type === "unknown") groups.unknown.push(row);
      else if (type === "template") groups.templates.push(row);
      else if (job.status === "pending" || job.status === "running") groups.waiting.push(row);
      else groups.history.push(row);
    }
    for (const rows of Object.values(groups)) rows.sort((a, b) => Date.parse(a.executeAt) - Date.parse(b.executeAt));
    return groups;
  }

  function diagnosticCooldownLabel(job) {
    if (job.type === "template") return "后台复核使用，不生成聊天";
    if (job.type === "promise") return "约定任务，不适用普通降速";
    if (job.cooldownRounds > 0) return "连续未回应达到 " + job.cooldownRounds + " 轮时降速";
    if (job.cooldownConfigured) return "未启用普通降速";
    return "降速配置未确认";
  }

  function diagnosticJobsView(groups, total, characters) {
    const status = { pending: "待执行", running: "处理中", done: "已结束", cancelled: "已取消", failed: "执行失败" };
    const sections = [
      ["waiting", "当前角色 · 消息任务", "执行时仍会判断是否回应，并不保证发出消息。"],
      ["templates", "当前角色 · 后台模板", "这些是云端复核使用的模板，不计入待发消息；旧模板可能保留给已有计划使用。"],
      ["history", "当前角色 · 历史记录", "已结束不等于已发送，实际成文请看「云端发送记录」。"],
      ["others", "其他角色的记录", "不计入当前角色的消息任务。"],
      ["unknown", "归属或类型未确认", "资料不足，暂不计入消息任务，也不判断为旧预约。旧云服务可重新部署后再刷新。"],
    ];
    let html = "";
    if (!groups.waiting.length) html += '<div class="diag-item">本次查询未发现当前角色待执行或处理中的消息任务。</div>';
    for (const [key, title, note] of sections) {
      const rows = groups[key];
      if (!rows.length) continue;
      html += '<details class="fold"' + (key === "waiting" ? ' open' : '') + '><summary><span class="t">' + title + '</span><span class="sm">' + rows.length + ' 条</span><span class="cv">›</span></summary><div class="archive-note">' + note + '</div>';
      html += rows.map(j => {
        const date = new Date(j.executeAt);
        const when = Number.isFinite(+date) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间未确认";
        const owner = characters.find(c => c.id === j.owner);
        const kind = { template: "后台模板", promise: "约定", message: "消息任务", unknown: "类型未确认" }[j.type];
        let row = '<div class="diag-item"><b>' + esc(when) + '</b> ' + esc(kind) + ' · ' + esc(status[j.status] || "状态未确认");
        if (key === "others") row += ' · ' + esc(owner ? owner.name : "其他角色");
        if (j.item && j.item.source) row += '<br>' + esc(j.item.source);
        row += '<br>' + diagnosticCooldownLabel(j);
        const reason = j.resultNote || "";
        if (/^promise changed or settled/.test(reason)) row += '<br>约定已变更或了结，原任务已取消';
        else if (/^cooldown skip/.test(reason)) row += '<br>本次因连续未回应而跳过';
        else if (reason) row += '<details><summary>执行记录</summary>' + esc(reason) + '</details>';
        return row + '</div>';
      }).join("") + '</details>';
    }
    const pending = groups.waiting.filter(j => j.status === "pending").length;
    const running = groups.waiting.filter(j => j.status === "running").length;
    html += '<div class="archive-note">本次读取 ' + total + ' 条云端记录，包含当前计划的定向查询；不是全账号任务总数。日期按手机本地时区显示。</div>';
    return { html, summary: "本次查到：待执行 " + pending + (running ? " · 处理中 " + running : "") + " · 模板 " + groups.templates.length };
  }

  async function renderUsage(force) {
    const v = $("#subview") || $("#view");
    const req = (S._usageReq = (S._usageReq || 0) + 1);
    v.innerHTML = '<div class="card empty"><div class="art">⏳</div><p>正在统计…</p></div>';
    await readLocalUsage(true);
    await syncUsageCloud(!!force);
    if (!(S.tab === "back" && S.sub === "usage") || req !== S._usageReq) return;
    const t = usageTotals();
    const stat = (n, cap) => '<div class="stat"><div class="num">' + n + '</div><div class="cap">' + cap + "</div></div>";
    const bar = (n, cap) => cap > 0 ? '<div class="usage-bar"><div class="fill" style="width:' + Math.min(100, Math.round(n / cap * 100)) + '%"></div></div>' : "";
    let html = '<div class="card"><div class="sec-head"><span class="t">今 日 用 量</span>' +
      '<span class="badge' + (!t.complete || usageOver() ? " warn" : (t.capCalls || t.capTokens ? " ok" : "")) + '">' + (!t.complete ? "合计未确认" : usageOver() ? "到上限了" : (t.capCalls || t.capTokens ? "额度内" : "没设上限")) + "</span></div>" +
      '<div class="stats four">' + stat((t.complete ? "" : "≥") + t.calls + (t.capCalls ? "<small>/" + t.capCalls + "</small>" : ""), "调 用") + stat((t.complete ? "" : "≥") + fmtTok(t.tokens) + (t.capTokens ? "<small>/" + fmtTok(t.capTokens) + "</small>" : ""), "token") +
      stat(t.localCalls + (t.otherCalls ? "<small>+" + t.otherCalls + "</small>" : ""), "本 机") + stat(t.cloudCalls == null ? "未知" : t.cloudCalls, "云 端") + "</div>" +
      bar(t.calls, t.capCalls) + bar(t.tokens, t.capTokens) +
      '<div class="archive-note">上限在设置「模型调用」里改。本机按次和 token 都由宿主统计；云端由云函数记账，聊天离线兜底的调用只记不限。'
      + (t.otherCalls ? "「本机」后面的 +" + t.otherCalls + " 是另一台设备今天调的，也占同一份上限。" : "") + "</div></div>";
    if (cloudCfg()) html += '<div class="card"><div class="archive-note">' + (t.complete ? '云端统计已同步' :
      (t.lastSuccessAt ? '显示上次取得的云端数据（' + esc(fmtHM(t.lastSuccessAt)) + '），合计仅为已知下限。' : '尚未取得云端统计，合计仅含已知本机用量。') + ' ' + esc(t.error)) +
      '</div><button class="tgl" id="btn-usage-retry">刷新用量</button></div>';
    const srcRows = [{ source: myUsageSrc(), calls: t.localCalls, prompt: (S._useLocal || {}).prompt || 0, completion: (S._useLocal || {}).completion || 0 }]
      .concat(t.rows.map((r) => ({ source: r.source, calls: +r.calls || 0, prompt: +r.prompt_tokens || 0, completion: +r.completion_tokens || 0 }))
        .filter((r) => r.calls || r.prompt || r.completion));
    html += '<div class="card"><div class="sec-head"><span class="t">按 来 源</span></div>' +
      srcRows.map((r) => '<div class="diag-item"><b>' + esc(usageLabel(r.source)) + "</b> " + r.calls + " 次 · " + fmtTok(r.prompt) + " 入 / " + fmtTok(r.completion) + " 出</div>").join("") +
      (cloudCfg() ? "" : '<div class="archive-note">没配云连接，只有本机的数。</div>') + "</div>";
    const byDay = {};
    for (const d of ((S._useLocal || {}).days || [])) byDay[d.date] = { calls: d.calls, tokens: d.prompt + d.completion };
    for (const r of (S._use && S._use.scope === usageCloudScope() ? S._use.rows : [])) {
      if (r.source === myUsageSrc() || r.source === "app") continue; // 自己那行已经在 byDay 里了
      const x = byDay[r.day] = byDay[r.day] || { calls: 0, tokens: 0 };
      x.calls += +r.calls || 0; x.tokens += (+r.prompt_tokens || 0) + (+r.completion_tokens || 0);
    }
    const days = Object.keys(byDay).sort().reverse().slice(0, 7);
    html += '<div class="card"><div class="sec-head"><span class="t">最 近 7 天</span></div>' +
      (days.length ? days.map((d) => '<div class="diag-item"><b>' + esc(d.slice(5)) + "</b> " + byDay[d].calls + " 次 · " + fmtTok(byDay[d].tokens) + " token" + (d === todayStr() ? ' <span class="badge cool">今天</span>' : "") + "</div>").join("")
        : '<div class="archive-note">还没有记录。</div>') + "</div>";
    v.innerHTML = html;
    const retry = $("#btn-usage-retry");
    if (retry) retry.onclick = () => renderUsage(true);
  }

  async function renderDiag() {
    const cx = cur();
    const v = $("#subview") || $("#view");
    const req = (S._diagReq = (S._diagReq || 0) + 1);
    const alive = () => S.tab === "back" && S.sub === "diag" && req === S._diagReq;
    S._diagOpen = S._diagOpen || {};

    const setOpen = (id, on) => { const it = $("#dgi-" + id); if (it) it.open = !!on; };
    const tones = {};
    const shown = DIAG_ITEMS.filter((c) => !c.when || c.when(cx)).filter((c) => !c.cloud || cloudCfg());
    const summarize = () => {
      const box = $("#dg-sum"); if (!box) return;
      const status = shown.filter((c) => !c.info && !c.ext);
      const pending = status.filter((c) => !(c.id in tones));
      const bad = status.filter((c) => tones[c.id] === "bad"), warn = status.filter((c) => tones[c.id] === "warn");
      const sync = cloudCfg() && cloudSyncIssues().unfinished ? [{ title: "云端同步" }] : [];
      let dot = "", head = "", sub = "";
      if (bad.length || warn.length || sync.length) {
        dot = bad.length ? "bad" : "warn";
        head = (bad.length + warn.length + sync.length) + " 处要处理";
        sub = bad.concat(warn, sync).map((c) => c.title).join(" · ") + (pending.length ? "（还在查 " + pending.length + " 项）" : "");
      } else if (pending.length) {
        dot = ""; head = "检查中…"; sub = "已看完 " + (status.length - pending.length) + " / " + status.length + " 项";
      } else {
        dot = "ok"; head = "检查完成，未发现明确故障"; sub = "仅反映已查询项目，不保证消息一定发出";
      }
      if (!cloudCfg()) sub += (sub ? "；" : "") + "没接云连接，云端复核、浏览器关着也生成、设备锁都停着";
      box.innerHTML = '<div class="row"><span class="dot ' + dot + '"></span><span class="head">' + head + "</span>"
        + (!cloudCfg() ? '<button class="tgl" id="btn-diag-cloudset">去设置</button>' : "") + "</div>"
        + (sub ? '<div class="sub">' + esc(sub) + "</div>" : "");
      const cs = $("#btn-diag-cloudset"); if (cs) cs.onclick = () => { S._setTab = "cloud"; openSheet(); };
    };
    S._diagSummarize = summarize;
    const fillRaw = (id, html, sum, tone) => {
      if (!alive()) return;
      const it = $("#dgi-" + id), bd = $("#diag-" + id), sm = $("#dgs-" + id);
      if (!it || !bd) return;
      bd.innerHTML = html;
      if (sm) { sm.className = "sm" + (tone ? " " + tone : ""); sm.textContent = sum || ""; }
      it.classList.toggle("bad", tone === "bad");
      it.classList.toggle("warn", tone === "warn");
      tones[id] = tone || "";
      setOpen(id, id in S._diagOpen ? S._diagOpen[id] : (tone === "warn" || tone === "bad"));
      summarize();
    };
    // 云端那几块每进一次诊断页就各发一次请求，页签来回切就重复发。
    // 结果连同摘要缓存 60 秒；计划一变（uploadPlanCloud）或接管过就整份作废。
    const ckey = (id) => id + ":" + cx.character.id + ":" + (cloudCfg() || {}).url;
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

    // 没接云连接时云端那几块不画，结论里说一句、留个去设置的入口
    v.innerHTML = DIAG_SECTIONS.map((sec) => {
      const items = shown.filter((c) => c.sec === sec.id);
      if (!items.length && sec.id !== "status") return ""; // 结论和「去设置」入口在状态卡里，没接云也得留
      return '<div class="card dg"><div class="sec-head"><span class="t">' + sec.title + "</span>" +
        (sec.id === "status" ? '<button class="act" id="btn-diag-refresh">刷新</button>' : "") + "</div>" +
        (sec.id === "status" ? '<div class="dg-sum" id="dg-sum"></div>' : "") +
        items.map((c) => c.ext ? '<div id="dg-ext-' + c.id + '" hidden></div>' : dgItem(c.id, c.title, '<div class="diag-item">读取中…</div>', "读取中…", "", S._diagOpen[c.id])).join("") +
        "</div>";
    }).join("");
    summarize();
    const refresh = $("#btn-diag-refresh");
    if (refresh) refresh.onclick = () => { S._diagCache = {}; renderDiag(); };
    dgBindToggle(v);
    renderCloudSync();
    renderCloudHistory();

    // 拿此刻的状态让TA说一句，只显示不发送：用来核对注入的状态对不对
    fill("preview", cx.day
      ? previewZone() + '<div class="archive-note">按TA此刻的状态生成一句话，不发送、不进聊天、不占额度，花一次模型调用。</div>'
      : '<div class="diag-item">TA的今天还没生成，没有状态可看。</div>', cx.day ? "" : "没状态", "");
    { const pv = $("#btn-preview"); if (pv) pv.onclick = () => preview(cur()); }
    // 云端回音账只给有限正反馈，不把用户忙碌、睡眠或未读造成的沉默当负面偏好。
    {
      const KIND_LABEL = { promise: "约定", plan: "早上定的", extra: "临时起念", thread: "惦记", done: "刚忙完", miss: "想念", echo: "余韵", quiet: "安静太久" };
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
        : '<div class="diag-item">还没有账。</div><div class="archive-note">云端复核会在TA每条主动消息发出、累计等待 3 小时后记一笔（启用的用户睡眠时段不计时）：之后有接话就记一笔正向参考，没有接话保持中性。</div>',
        total ? total + " 条 · " + rows.length + " 类" : "还没有", "");
    }
    // 日志是本地现成的，先画上，别让整页都在等云端
    if (!logItems.length) {
      fill("logs", '<div class="diag-item">还没有日志。</div><div class="archive-note">生成、编排、复核、预约的每一步都会记在这里。最多保留 120 条，只存在本地，不上传。</div>', "还没有", "");
    } else {
      const today = todayStr();
      fill("logs",
        logItems.map((l) => {
          const d = new Date(l.at);
          const ds = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
          return '<div class="diag-item"><b>' + (ds === today ? "" : ds.slice(5).replace("-", "/") + " ") + fmtHM(l.at) + "</b> " + esc(l.text) + "</div>";
        }).join("") + '<div class="archive-note">最多保留 120 条，只存在本地，不上传。</div>' +
        '<div class="dg-act"><button class="tgl" id="btn-clear-log">清空</button></div>',
        logItems.length + " 条 · 最近 " + fmtHM(logItems[0].at), "");
      const clr = $("#btn-clear-log");
      if (clr) clr.onclick = async () => {
        try { if (S.logs) S.logs = await AiPhone.db.update("logs", S.logs.id, { items: [] }); } catch (e) { toast("清空失败：" + (e && e.message || e)); }
        renderDiag();
      };
    }

    // 设备锁：今天由哪台设备负责编排和预约。自己在管时那行由「连接与聊天镜像」带出来，
    // 别的设备在管才单独出一块（这是唯一需要动手的状态）。
    (async () => {
      if (!cloudCfg() || diagRestore("lock")) return;
      const before = cx.owner && cx.owner.id || "";
      cx._ownAt = Date.now();
      await readOwner(cx);
      if (!alive()) return;
      // 锁换了主：这一块在不在都是按旧值渲染的，整页重画一次
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
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setDate(end.getDate() + 1);
        const d0 = +start, d1 = +end;
        wakes = (all || [])
          .filter((w) => w.characterId === cx.character.id && w.fireAt >= d0 && w.fireAt < d1 && !/_sentinel_\d+_[a-z0-9]+$/i.test(w.id) && !/挂念后台复核模板/.test(w.intent || ""))
          .sort((a, b) => a.fireAt - b.fireAt);
      } catch (e) { /* wakes 保持 null = 读取失败 */ }
      if (!alive()) return;
      // 云端点亮的时刻只存在于云上，本地唤醒表里查不到，不说清楚会被当成「预约没挂上」
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const todayItems = planItems.filter(it => it.fireAt >= +start && it.fireAt < +end);
      const cloudArmed = todayItems.filter((it) => it.act && it.adj === "cloud" && it.wakeId && it.fireAt > Date.now());
      const localPending = todayItems.filter((it) => it.act && it.fireAt > Date.now() && !cloudArmed.includes(it)).length;
      let html, sum, tone;
      if (wakes === null) {
        html = '<div class="diag-item">读取系统唤醒列表失败。</div>';
        sum = "读不到"; tone = "bad";
      } else if (!wakes.length) {
        html = '<div class="diag-item">本机今天没有登记的唤醒。</div>' + (cloudArmed.length ? "" : '<div class="archive-note">云端创建的预约不在这张本机列表中，实际状态请打开时刻详情刷新回执。</div>');
        const missing = localPending > 0;
        sum = missing ? "本机 0 个 · " + localPending + " 个待核实" : "本机 0 个" + (cloudArmed.length ? " · 云端记录 " + cloudArmed.length + " 个" : " · 本机计划无待发记录");
        tone = "";
      } else {
        const extra = wakes.filter((w) => !planItems.some((it) => it.wakeId === w.id)).length;
        html = wakes.map((w) => {
          const inPlan = planItems.some((it) => it.wakeId === w.id);
          return '<div class="diag-item"><b>' + fmtHM(w.fireAt) + "</b> " + esc(w.intent || "") +
            (inPlan ? "" : ' <span class="badge cool">未关联当前计划</span>') + "</div>";
        }).join("");
        sum = wakes.length + " 个 · " + (extra ? extra + " 个未关联计划" : "都在计划里");
        tone = "";
      }
      // 云端点亮的时刻本机列表里查不到，和本机的排在一起、打个标就行，不再套一层折叠
      if (cloudArmed.length) {
        html += cloudArmed.map((it) => '<div class="diag-item"><b>' + esc(wakeTimeLabel(it)) + "</b> " + esc(it.intent || "") + ' <span class="badge cool">云端点亮</span></div>').join("") +
          '<div class="archive-note">标「云端点亮」的记录为云端创建，本机列表里查不到。当前是否仍待执行，以时刻详情里的云端回执为准。</div>';
      }
      fill("wakes", html, sum, tone);
    })();

    if (!cloudCfg()) {
      const none = '<div class="diag-item">未配置云连接。</div><div class="archive-note">到设置里填你的个人云地址与密钥后，这里会有内容。</div>';
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
        const ver = h.functionsVersion ? "部署包 v" + h.functionsVersion : "部署包版本未提供";
        const mir = caps.indexOf("chat-mirror") >= 0;
        // 设备锁的常态（自己在管 / 还没定）就在这里占一行，不单独占一张卡
        const lockLine = !cx.owner || !cx.owner.id
          ? '<div class="diag-item"><b>今天谁在管</b> 还没定 · 谁先生成或编排就归谁</div>'
          : owns(cx) ? '<div class="diag-item"><b>今天谁在管</b> 这台（' + esc(myDevName()) + "）</div>" : "";
        let mHtml = lockLine + '<div class="diag-item"><b>连接</b> 正常 · ' + esc(ver) + ' · 数据库结构 v' + esc(String(h.schemaVersion || "?")) + "</div>";
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
                "<br>当前角色ID：<br>" + esc(String(cx.character.id)) + "<br>检查聊天镜像是否开启，刷新后仍不一致可用这些编号核对。</div>"
              : '<div class="diag-item"><b>镜像</b> 云端一条镜像都没有。到小手机「设置 → 云服务部署」确认「聊天镜像」已勾选（勾选动作本身会补传最近聊天），然后随便发一条消息，等半分钟再回这页看。</div>';
            fill("cloud", mHtml, ver + " · " + (a ? "镜像角色对不上" : "镜像是空的"), "bad");
          }
        }
      } catch (e) {
        fill("cloud", '<div class="diag-item"><b>连接</b> 云端查询失败：' + esc(String(e && e.message || e)) + "</div>", "连不上", "bad");
      }

      // 云端任务与后台模板分开；不把跨角色样本或零阈值当作当前角色故障。
      try {
        if (caps.indexOf("job-status") < 0) {
          fill("jobs", '<div class="diag-item">个人云尚不支持任务查询。</div><div class="archive-note">到小手机「设置 → 云服务部署」重新部署后刷新诊断。</div>', "需要更新云服务", "warn");
        } else {
          const jr = await cloudFetch("jobs", { method: "GET" }, { kind: "timed_task", limit: "20" });
          if (!Array.isArray(jr.jobs)) throw new Error("云端未返回有效的任务列表");
          const found = new Map(jr.jobs.map(j => [j.triggerKey, j]));
          // 最晚执行的全账号样本可能被模板挤满，补查本角色计划中的确切任务。
          const keys = [...new Set(planItems.filter(w => w.act && w.wakeId).map(w => "timedwake:" + w.wakeId))].filter(key => !found.has(key));
          let missing = 0;
          for (let i = 0; i < keys.length; i += 20) {
            const batch = keys.slice(i, i + 20);
            const r = await cloudFetch("jobs", { method: "GET" }, { kind: "timed_task", triggerKeys: JSON.stringify(batch) });
            if (!Array.isArray(r.jobs) || !Array.isArray(r.queriedTriggerKeys) || batch.some(key => !r.queriedTriggerKeys.includes(key))) throw new Error("云端未确认定向查询，请更新云服务后重试");
            for (const j of r.jobs) if (batch.includes(j.triggerKey)) found.set(j.triggerKey, j);
            missing += batch.filter(key => !found.has(key)).length;
          }
          const jobs = [...found.values()];
          const groups = diagnosticJobGroups(jobs, cx.character.id, planItems, S.settings.sentinels, mySession);
          const view = diagnosticJobsView(groups, jobs.length, S.characters || []);
          if (caps.indexOf("job-diagnostics-v2") < 0) view.html += '<div class="archive-note">云服务尚未提供完整的任务分类；无法确认的记录已单列。更新个人云后可显示更多归属信息。</div>';
          if (missing) view.html += '<div class="archive-note">当前计划有 ' + missing + ' 条未查到云端记录，可能未上传或历史已清理。请在时刻详情刷新回执，不需要重置今天。</div>';
          fill("jobs", view.html, view.summary + (missing ? " · " + missing + " 条待核实" : ""), "");
        }
      } catch (e) {
        fill("jobs", '<div class="diag-item">任务查询失败：' + esc(String(e && e.message || e)) + "。点击「刷新诊断」重试。</div>", "查询失败", "bad");
      }

      if (!cloudRecheckOn()) {
        fill("recheck", '<div class="diag-item">「浏览器关着也复核」没打开。</div><div class="archive-note">开了之后，今天的计划会寄存到你的个人云，' +
          "浏览器关着时云端每 5 分钟醒一次，按最近的聊天重判。</div>", "没打开", "");
        return;
      }
      try {
        if (caps.indexOf("recheck-plan") < 0) {
          fill("recheck", '<div class="diag-item">云函数版本偏旧，还不支持云端复核。</div><div class="archive-note">去小手机「设置 → 云服务部署」重新部署一次离线推送。</div>', "云函数版本偏旧", "warn");
          return;
        }
        const rr = await cloudFetch("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: todayStr() });
        const pl = rr.plan;
        if (!pl) {
          fill("recheck", '<div class="diag-item">未查到今天的云端计划。</div><div class="archive-note">若已生成今天的日程，请在上面「云端同步」里重试同步；尚未生成时先到「今天」页生成日程。</div>', "今日计划未查到", cx.day ? "warn" : "");
          return;
        }
        const pend = (pl.items || []).filter((it) => it.act && it.fireAt > Date.now()).length;
        const count = pl.recheck_count || 0;
        const configuredCap = Number((pl.context || {}).gateDailyCap);
        const cap = Number.isFinite(configuredCap) && configuredCap >= 0 ? configuredCap : 8;
        const judgedAt = pl.judged_at || (count > 0 ? pl.last_recheck_at : null);
        const ran = judgedAt
          ? new Date(judgedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "";
        let rHtml = '<div class="diag-item"><b>寄存</b> ' + (pl.items || []).length + " 个计划时刻（启用且未到点 " + pend + " 个）</div>" +
          '<div class="diag-item"><b>复核</b> ' + (ran ? esc(ran) : count > 0 ? "时间未记录" : "还没判断过") + " · 今天已判 " + count + "/" + cap + " 次</div>" +
          '<div class="diag-item"><b>待同步的计划调整</b> ' + ((pl.decisions || []).length || "无") + "</div>";
        if (!pend) rHtml += '<div class="archive-note">当前寄存列表没有未来时刻；是否继续复核还取决于起念模式、约定和门禁。</div>';
        fill("recheck", rHtml,
          count > 0 ? "已判 " + count + "/" + cap + (ran ? " · 上次 " + ran : " · 时间未记录") : "已寄存 · 还没判断过",
          count > 0 ? "ok" : "");
      } catch (e) {
        fill("recheck", '<div class="diag-item">云端复核查询失败：' + esc(String(e && e.message || e)) + "</div>", "查询失败", "bad");
      }
    })();
  }

  function bindCommon() {
    const gen = $("#btn-gen"); if (gen) gen.onclick = () => generateDay(cur());
    const rg = $("#btn-regen"); if (rg) rg.onclick = () => generateDay(cur());
    const rp = $("#btn-replan"); if (rp) rp.onclick = () => orchestrate(cur());
    const pv = $("#btn-preview"); if (pv) pv.onclick = () => preview(cur());
  }
