  /* ================= 记录页 ================= */
  async function loadArchive() {
    const cx = cur();
    if (cx.archive && Date.now() - cx.archive.at < 60000) return cx.archive;
    const cid = cx.character.id;
    const [days, plans] = await Promise.all([
      AiPhone.db.list("days", { limit: 100 }),
      AiPhone.db.list("plans", { limit: 100 }),
    ]);
    const byDate = {};
    for (const d of days || []) if (d.characterId === cid) byDate[d.date] = { day: d, plan: null };
    for (const p of plans || []) if (p.characterId === cid) {
      if (!byDate[p.date]) byDate[p.date] = { day: null, plan: null };
      byDate[p.date].plan = p;
    }
    await refreshReceipts(cx, Object.values(byDate).flatMap((r) => r.plan && r.plan.items || []));
    cx.archive = { at: Date.now(), dates: Object.keys(byDate).sort().reverse(), byDate };
    return cx.archive;
  }

  function decStatus(w, _msgs, cx) {
    const receipt = receiptFor(w, cx), j = receipt && receipt.job;
    const state = (status, label, tone, explanation, sentAt) => ({
      status, cls: w.act ? "on" : "no", heart: w.act ? "♥" : "♡", explanation, sentAt: sentAt || 0,
      badge: '<span class="badge ' + tone + '">' + label + '</span>',
    });
    if (j) {
      if (j.status === "done" && /^(generated|sent)(?:\b|,)/.test(String(j.resultNote || ""))) {
        return state("sent", "已发出", "sent", "对应预约的云端回执已确认消息生成完成；这不代表手机通知已展示或你已读。", Date.parse(j.updatedAt) || 0);
      }
      if (j.status === "failed") return state("failed", "发送失败", "warn", "对应预约执行失败。" + (j.resultNote || ""));
      if (j.status === "cancelled") return state("cancelled", "已取消", "off", "对应预约已取消。" + (j.resultNote || ""));
      if (j.status === "done" && /^(presend skip:|guanian |template expired|no_subscription|daily cap)/.test(String(j.resultNote || ""))) {
        return state("skipped", "未发送", "off", "对应预约已结束，本次未发送。" + j.resultNote);
      }
      // 缓存的进行中状态在刷新失败时不再当作当前状态。
      if (!receipt.error && j.status === "running") return state("running", "生成中", "wait", "对应预约正在执行，尚未取得发送成功回执。");
      if (!receipt.error && j.status === "pending") return state("pending", "待发送", "wait", "云端预约仍在等待执行" + (j.executeAt ? "，预约时间 " + fmtHM(Date.parse(j.executeAt)) : "") + "。");
    }
    if (!w.act) return state("skipped", "作罢", "off", "没有起念，不会发送。");
    if (w.fireAt > Date.now()) return state("pending", "待发送", w.delivery === "push" ? "wait" : "local",
      w.delivery === "push" ? "已预约离线推送；实际发送结果以执行回执为准。" : "仅在线路径，到点时页面需要开着。");
    return state("unknown", "待确认", "done", receipt && receipt.error || "没有可核实的对应预约回执，无法确认是否发送；普通聊天消息不作为发送凭据。");
  }

  /* ================= 时刻详情弹层 ================= */
  const HIST_KIND = { plan: "首次编排 · 有念头", skip: "首次编排 · 作罢", recheck: "复核作罢", lit: "复核点亮", cooled: "未回应降速", defer: "复核改约", extra: "临时念头", presend: "发送前复核" };

  function detailHtml(w, plan) {
    const cx = cur();
    let h = '<div class="d-hd"><span class="tm">' + esc(w.time) + '</span><span class="tt">' + esc(w.source || "") + "</span>" +
      decStatus(w).badge + adjBadge(w) + "</div>";

    // 判断
    h += '<div class="d-sec"><div class="d-t">判 断</div>';
    if (w.sem || w.topic) {
      h += '<div class="mood-sub" style="margin:0 0 8px">' +
        (w.sem ? '<span class="chip">' + esc(w.sem) + "</span>" : "") +
        (w.topic ? '<span class="chip">话题 · ' + esc(w.topic) + "</span>" : "") + "</div>";
    }
    h += w.act
      ? '<div class="d-intent">「' + esc(w.intent || "") + '」</div>' + (w.why ? '<div class="d-why">' + esc(w.why) + "</div>" : "")
      : '<div class="d-intent" style="color:var(--tx3)">' + esc(w.why || "TA这会儿不想") + "</div>";
    h += "</div>";

    // 数值层（判断那一刻的规则计算快照）
    if (w.score) {
      const s = w.score;
      const bar = (lab, val, expl) =>
        '<div class="sc-row"><div class="sc-lab"><span>' + lab + "</span><span>" + val + '%</span></div>' +
        '<div class="bar"><div class="fill2" style="width:' + val + '%"></div></div>' +
        '<div class="sc-expl">' + esc(expl) + "</div></div>";
      h += '<div class="d-sec"><div class="d-t">数 值 层（判断那一刻的规则计算，不是模型报的）</div>' +
        bar("时段贴合", s.fit, "按 13 点 / 21 点两个聊天高峰做距离衰减，离高峰越近越贴合") +
        bar("额度压力", s.pq, "判断时今天已起念的数量占每日上限的比例") +
        bar("未回压力", s.pr, "判断时TA连续未被回复的轮数相对降速阈值的比例") +
        bar("间隔压力", s.pg, "离上一个已起念时刻越近压力越大，超过最小间隔的两倍则为 0") +
        '<div class="sc-expl" style="margin-top:2px">综合压力 ' + s.press + "%（额度 40% + 未回 40% + 间隔 20% 加权）。压力只影响判断倾向，最终起不起念由TA的性格判断决定。</div></div>";
    } else {
      h += '<div class="d-sec"><div class="d-t">数 值 层</div><div class="archive-note" style="text-align:left;padding:0">旧版本编排的记录，没有留数值快照。重新编排后就有了。</div></div>';
    }

    // 发送前复核：到点那一刻云端算的，直接决定了这条发没发出去（和上面编排时的数值层不是一回事）
    if (w.presend) {
      const ps = w.presend;
      const pbar = (lab, val, expl) =>
        '<div class="sc-row"><div class="sc-lab"><span>' + lab + "</span><span>" + (val || 0) + '%</span></div>' +
        '<div class="bar"><div class="fill2" style="width:' + (val || 0) + '%"></div></div>' +
        '<div class="sc-expl">' + esc(expl) + "</div></div>";
      h += '<div class="d-sec"><div class="d-t">发 送 前 复 核（到点那一刻云端算的）</div>' +
        pbar("未回应", ps.pr, "到点时TA已连续 " + (ps.rounds || 0) + " 轮主动没等到你回，相对降速阈值的比例") +
        pbar("正聊着", ps.pt, "你最后一句话离到点越近，这条主动越像打断") +
        pbar("挨太密", ps.pg, "离TA上一条主动越近压力越大") +
        '<div class="sc-expl" style="margin-top:2px">不合时宜度 <b>' + (ps.press || 0) + "%</b>（未回 40% + 正聊 40% + 太密 20% 加权）" +
        (ps.max != null ? "，阈值 " + ps.max + "%" : "") + "。" +
        (ps.blocked
          ? '<b style="color:var(--warn)">过了阈值，这条没有发出去。</b>'
          : "没到阈值，放行。") + "</div>" +
        '<div class="sc-expl">' + fmtHM(ps.at) + " · " + esc(ps.note || "") + "</div></div>";
    } else if (w.act && w.delivery === "push") {
      h += '<div class="d-sec"><div class="d-t">发 送 前 复 核</div><div class="archive-note" style="text-align:left;padding:0">还没到点，或者云端还没把这一次的判据同步回来。</div></div>';
    }

    // 调整轨迹
    h += '<div class="d-sec"><div class="d-t">轨 迹</div>';
    if (w.hist && w.hist.length) {
      const today = todayStr();
      h += w.hist.map((e) => {
        const d = new Date(e.at);
        const ds = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
        return '<div class="hist-it"><b>' + (ds === today ? "" : ds.slice(5).replace("-", "/") + " ") + fmtHM(e.at) + "</b> " +
          (e.by === "cloud" ? "云端 · " : "") + (HIST_KIND[e.kind] || e.kind) + (e.note ? " · " + esc(e.note) : "") + "</div>";
      }).join("");
    } else {
      h += '<div class="archive-note" style="text-align:left;padding:0">旧版本记录，没有留判断轨迹。</div>';
    }
    h += "</div>";

    // 执行
    h += '<div class="d-sec"><div class="d-t">执 行</div>';
    const st = decStatus(w);
    h += '<div class="d-why">' + esc(st.explanation) + '</div>';
    if (st.sentAt) h += '<div class="d-why">回执完成时间：' + esc(fmtHM(st.sentAt)) + '</div>';
    const receipt = receiptFor(w);
    if (receipt && receipt.error && receipt.job) h += '<div class="d-why">本次刷新失败，以上为上次回执：' + esc(receipt.error) + '</div>';
    if (w.wakeId && cloudCfg()) h += '<button class="tgl" id="btn-refresh-receipt">刷新回执</button>';
    h += "</div>";

    const si = plan && plan.date === todayStr() ? ((cx.day && cx.day.schedule) || []).findIndex((x) => x.time === w.time) : -1;
    if (si >= 0) h += '<div class="sd-ask"><div class="row"><button class="tgl" id="sd-goto" data-si="' + si + '">✎ 改这条日程</button></div></div>';

    h += '<div class="d-meta">' +
      (plan && plan.plannedAt ? "编排于 " + fmtHM(plan.plannedAt) : "") +
      (plan && plan.recheckAt ? " · 上次复核 " + fmtHM(plan.recheckAt) : "") + "</div>";
    return h;
  }

  function openDetail(w, plan) {
    const cx = cur();
    S._detailW = w; S._detailSi = -1;
    $("#dsheet-title").textContent = "时 刻 详 情";
    document.body.classList.add("dsheet-open");
    const alive = () => S._detailW === w && cur() === cx && document.body.classList.contains("dsheet-open");
    const draw = () => {
      if (!alive()) return;
      $("#dsheet-body").innerHTML = detailHtml(w, plan);
      const button = $("#btn-refresh-receipt");
      if (button) button.onclick = () => update(true);
    };
    const update = async (force) => {
      const button = $("#btn-refresh-receipt");
      if (button) { button.disabled = true; button.textContent = "查询中…"; }
      try { await refreshReceipts(cx, [w], force); }
      finally { cx.archive = null; draw(); }
    };
    draw();
    update(false).catch(() => { /* 回执错误已显示在详情内 */ });
  }
  function closeDetail() { document.body.classList.remove("dsheet-open"); S._detailW = null; S._detailSi = -1; }
