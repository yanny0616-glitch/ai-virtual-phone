  function decRow(w) {
    const st = decStatus(w);
    return '<div class="dec ' + st.cls + '" data-t="' + esc(w.time) + '"><span class="hh ' + (w.act ? "on" : "no") + '">' + st.heart + "</span>" +
      '<div class="row1"><span class="tm">' + esc(w.time) + '</span><span class="tt">' + esc(w.source || "") + "</span>" + st.badge + adjBadge(w) + "</div>" +
      '<div class="why">' + esc(w.act ? "「" + (w.intent || "") + "」" : (w.why || "TA这会儿不想")) + "</div>" +
      "</div>";
  }

  async function renderArchive() {
    const cx = cur();
    const v = $("#view");
    const req = (S._arcReq = (S._arcReq || 0) + 1);
    v.innerHTML = '<div class="card empty"><div class="art">🗂️</div><p>翻看TA想起你的那些日子…</p></div>';
    let arc;
    try { arc = await loadArchive(); } catch (e) {
      v.innerHTML = '<div class="card empty"><div class="art">🌫️</div><p>记录读取失败：' + esc(e && e.message || e) + "</p></div>";
      return;
    }
    if (req !== S._arcReq || S.tab !== "archive") return; // 期间切走了就不画

    // 近 7 天统计
    const d7 = new Date(); d7.setDate(d7.getDate() - 6);
    const from = d7.getFullYear() + "-" + pad(d7.getMonth() + 1) + "-" + pad(d7.getDate());
    let nAct = 0, nSent = 0, nUnknown = 0;
    for (const date of arc.dates) {
      if (date < from) continue;
      const p = arc.byDate[date].plan;
      for (const w of (p && p.items) || []) {
        if (!w.act) continue;
        nAct++;
        const st = decStatus(w);
        if (st.status === "sent") nSent++;
        if (st.status === "unknown") nUnknown++;
      }
    }
    let html =
      '<div class="stats">' +
      '<div class="stat"><div class="num">' + nAct + '</div><div class="cap">7天起念</div></div>' +
      '<div class="stat" style="animation-delay:60ms"><div class="num">' + nSent + '</div><div class="cap">已发出</div></div>' +
      '<div class="stat" style="animation-delay:120ms"><div class="num">' + nUnknown + '</div><div class="cap">待确认</div></div>' +
      "</div>";

    if (!arc.dates.length) {
      html += '<div class="card empty"><div class="art">🌱</div><p>还没有任何记录。<br>回「今天」页生成TA的一天，这里就会开始留痕。</p></div>';
      v.innerHTML = html; return;
    }

    arc.dates.forEach((date, di) => {
      const rec = arc.byDate[date];
      const day = rec.day, plan = rec.plan;
      const items = (plan && plan.items) || [];
      const acted = items.filter((w) => w.act).length;
      const wd = "日一二三四五六"[new Date(date + "T00:00:00").getDay()];
      const isToday = date === todayStr();
      let body = "";
      if (day) {
        body += '<div class="day-meta">' +
          '<span class="chip">⚡ 精力 ' + (isToday ? energyAt(day, Date.now()) : (day.energy != null ? day.energy : "?")) + "%</span>" +
          (day.location ? '<span class="chip">📍 ' + esc(day.location) + "</span>" : "") +
          (plan && plan.chatUsed ? '<span class="chip">💬 判断时读了 ' + plan.chatUsed + " 句聊天</span>" : "") +
          "</div>";
      }
      if (items.length) {
        // 起念的时刻是主角，逐条展开讲；未起念的只是「日程里没被选中的时刻」，
        // 折叠成一行，免得整张卡片读起来像把日程复读一遍
        const actedItems = items.filter((w) => w.act);
        const skippedItems = items.filter((w) => !w.act);
        body += actedItems.map((w) => decRow(w)).join("");
        if (!actedItems.length) body += '<div class="archive-note">这天TA一个时刻都没起念，想安静地过。</div>';
        if (skippedItems.length) {
          body += '<details class="skip-fold"><summary>♡ 还有 ' + skippedItems.length + ' 个时刻没起念 · 看看为什么</summary>' +
            skippedItems.map((w) => decRow(w)).join("") + "</details>";
        }
      } else {
        body += '<div class="archive-note">这天没有编排记录' + (day ? "（只生成了生活面）" : "") + "</div>";
      }
      html += '<details class="day-card" data-d="' + esc(date) + '"' + (isToday || (di === 0 && !arc.byDate[todayStr()]) ? " open" : "") + ' style="animation-delay:' + Math.min(di * 50, 400) + 'ms">' +
        '<summary class="day-sum"><span class="emo">' + esc(day && day.moodEmoji || "🗓️") + "</span>" +
        '<span class="mid"><span class="d1">' + esc(date.slice(5).replace("-", " / ")) + '<span class="wd">周' + wd + (isToday ? " · 今天" : "") + "</span>" +
        (acted ? '<span class="hearts">♥×' + acted + "</span>" : '<span class="hearts" style="color:var(--tx3)">安静的一天</span>') + "</span>" +
        '<span class="d2">' + esc(day && day.mood || "没有生活面记录") + "</span></span>" +
        '<span class="arr">▶</span></summary>' +
        '<div class="day-body">' + body + "</div></details>";
    });
    html += '<div class="archive-note">发送状态按对应预约回执确认；旧记录、仅在线发送或回执缺失显示「待确认」。不再根据普通聊天推算发送和回复率。点任意时刻可刷新回执。</div>';
    v.innerHTML = html;
    v.querySelectorAll(".dec").forEach((el) => {
      el.onclick = () => {
        const card = el.closest(".day-card");
        const rec = card && arc.byDate[card.dataset.d];
        const w = rec && rec.plan && (rec.plan.items || []).find((x) => x.time === el.dataset.t);
        if (w) openDetail(w, rec.plan);
      };
    });
  }

  function previewZone() {
    return '<button class="ghost-btn preview-btn" id="btn-preview">听听TA此刻会说什么</button>' +
      '<div class="preview-zone" id="preview-zone">' + ((S._preview || {})[cur().character ? cur().character.id : ""] || "") + "</div>";
  }
