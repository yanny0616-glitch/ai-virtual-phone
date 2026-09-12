// ── 夜记：每天 / 每周 / 每月 ──
const journal = (() => {
  let range = "week";
  let weekStart = PmStats.weekStartKey(new Date());
  let month = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })();
  const WD = ["一", "二", "三", "四", "五", "六", "日"];
  const goal = () => state.settings.goal;

  function nightCard(n) {
    const d = new Date(n.date + "T12:00:00");
    const card = el("details", "day-card");
    card.innerHTML = `<summary class="day-sum"><div class="dnum"><b>${d.getDate()}</b><span>${d.getMonth() + 1} 月</span></div>
      <div class="mid"><div class="d1">${n.durationMin ? esc(PmStats.formatDuration(n.durationMin)) : "还没醒"} ${moonsHtml(n.rating)}</div>
      <span class="d2">${esc(fmtClock(new Date(n.sleepAt)))} → ${n.wakeAt ? esc(fmtClock(new Date(n.wakeAt))) : "…"}${n.mixName ? ` · ${esc(n.mixName)}` : ""}${n.wakeups ? ` · 起夜 ${n.wakeups}` : ""}</span></div><span class="arr">›</span></summary>
      <div class="day-body"><div class="day-meta">${[n.characterName, n.mode === "insomnia" ? "失眠模式" : n.mode === "sound" ? "只开了声音" : "哄睡", n.segments ? `说了 ${n.segments} 段` : ""].filter(Boolean).map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      ${n.lastLine ? `<div class="bubble"><div class="from">最后一句</div>${esc(n.lastLine)}</div>` : ""}${n.morningLine ? `<div class="bubble"><div class="from">早安</div>${esc(n.morningLine)}</div>` : ""}${n.note ? `<div class="bubble"><div class="from">你</div>${esc(n.note)}</div>` : ""}
      <div class="acts"><button class="mini" type="button" data-a="edit">改自评 / 备注</button><button class="mini warn" type="button" data-a="del">删除</button></div></div>`;
    card.querySelector('[data-a="edit"]').onclick = () => editNight(n);
    card.querySelector('[data-a="del"]').onclick = async () => { if (!confirm("删掉这一晚的记录？")) return; try { await api.db.delete("nights", n.id); state.nights = state.nights.filter(x => x.id !== n.id); emit("nights"); render(); } catch (e) { fail(e); } };
    return card;
  }
  function editNight(n) {
    openSheet(n.date.replace(/-/g, " / "), box => {
      let rating = n.rating || 0;
      box.innerHTML = `<div class="grp"><div class="grp-t">睡得怎么样</div><div class="rate" id="e-rate">${[1, 2, 3, 4, 5].map(k => `<button type="button" data-n="${k}" class="${k <= rating ? "on" : ""}">${iconSvg("moon")}</button>`).join("")}</div></div>
        <div class="grp"><div class="grp-t">一句话</div><textarea id="e-note" class="txt-in" rows="2">${esc(n.note || "")}</textarea></div>
        <button class="big-btn" id="e-ok" type="button">保存</button>`;
      box.querySelectorAll("#e-rate button").forEach(b => { b.onclick = () => { rating = Number(b.dataset.n); box.querySelectorAll("#e-rate button").forEach(x => x.classList.toggle("on", Number(x.dataset.n) <= rating)); }; });
      box.querySelector("#e-ok").onclick = async () => { n.rating = rating; n.note = box.querySelector("#e-note").value.trim(); try { await upsertNight(n); closeSheet(); render(); } catch (e) { fail(e); } };
    });
  }
  function renderDay() {
    const box = $("journal-day"); box.innerHTML = "";
    if (!state.nights.length) { box.innerHTML = `<p class="empty">还没有记录。<br>今晚点「睡了」，明早点「我醒了」，这里就有第一条。</p>`; return; }
    for (const n of state.nights.slice(0, 60)) box.appendChild(nightCard(n));
  }
  function stat(value, cap, delta) { const s = el("div", "stat"); s.innerHTML = `<div class="num">${value}</div><div class="cap">${esc(cap)}</div>${delta ? `<div class="delta">${esc(delta)}</div>` : ""}`; return s; }
  function renderWeek() {
    const box = $("journal-week"); box.innerHTML = "";
    const cur = PmStats.summarizeWeek(state.nights, weekStart, goal());
    const prev = PmStats.summarizeWeek(state.nights, PmStats.addDays(weekStart, -7), goal());
    const cmp = PmStats.compareWeeks(cur, prev);
    const chart = el("div", "card");
    const end = PmStats.addDays(weekStart, 6);
    const nav = el("div", "week-nav");
    nav.innerHTML = `<button type="button" class="mini" id="w-prev">‹</button><span class="lbl">${esc(weekStart.slice(5).replace("-", "/"))} – ${esc(end.slice(5).replace("-", "/"))}</span><button type="button" class="mini" id="w-next" ${weekStart >= PmStats.weekStartKey(new Date()) ? "disabled" : ""}>›</button>`;
    nav.querySelector("#w-prev").onclick = () => { weekStart = PmStats.addDays(weekStart, -7); renderWeek(); };
    nav.querySelector("#w-next").onclick = () => { weekStart = PmStats.addDays(weekStart, 7); renderWeek(); };
    chart.appendChild(nav);
    // 一夜时间轴：20:00 → 10:00 横着躺
    const T0 = 20 * 60, SPAN = 14 * 60;
    const minOf = iso => { const d = new Date(iso); let m = d.getHours() * 60 + d.getMinutes(); if (m < 12 * 60) m += 24 * 60; return m; };
    const pct = m => Math.min(100, Math.max(0, (m - T0) / SPAN * 100));
    const goalBed = (() => { const [h, mm] = goal().bedtime.split(":").map(Number); let m = h * 60 + mm; if (m < 12 * 60) m += 24 * 60; return m; })();
    const tl = el("div", "tl");
    const todayKey = PmStats.nightKeyFor(new Date());
    cur.days.forEach((d, i) => {
      const row = el("div", "tl-row" + (d.date === todayKey ? " today" : ""));
      row.appendChild(el("span", "tl-d", WD[i]));
      const track = el("div", "tl-track");
      const gl = el("i", "tl-goal"); gl.style.left = `${pct(goalBed)}%`; track.appendChild(gl);
      const n = d.night;
      if (n && n.durationMin) {
        const a = minOf(n.sleepAt), z = Math.max(a + 10, n.wakeAt ? minOf(n.wakeAt) : a + n.durationMin);
        const bar = el("i", "tl-bar" + (n.durationMin >= goal().hours * 60 ? " goal" : "")); bar.style.left = `${pct(a)}%`; bar.style.width = `${Math.max(2, pct(z) - pct(a))}%`;
        if (n.rating) bar.dataset.r = String(n.rating);
        bar.onclick = () => editNight(n);
        track.appendChild(bar);
      }
      row.appendChild(track);
      row.appendChild(el("span", "tl-dur", n && n.durationMin ? PmStats.formatDuration(n.durationMin) : ""));
      tl.appendChild(row);
    });
    const axis = el("div", "tl-row axis"); axis.appendChild(el("span")); const ax = el("div", "tl-axis"); ["20", "22", "0", "2", "4", "6", "8", "10"].forEach(t => ax.appendChild(el("span", null, t))); axis.appendChild(ax); axis.appendChild(el("span")); tl.appendChild(axis);
    chart.appendChild(tl);
    chart.appendChild(el("p", "bar-note", `虚线 = 目标 ${goal().bedtime} 入睡；条越亮自评越高；发光 = 睡够 ${goal().hours} 小时`));
    box.appendChild(chart);
    const grid = el("div", "stats");
    grid.appendChild(stat(cur.avgDurationMin ? esc(PmStats.formatDuration(Math.round(cur.avgDurationMin))) : "--", "平均时长", cmp.durationDeltaMin != null ? `比上周 ${cmp.durationDeltaMin >= 0 ? "+" : ""}${cmp.durationDeltaMin} 分` : ""));
    grid.appendChild(stat(esc(PmStats.formatBedtime(cur.avgBedtime == null ? null : Math.round(cur.avgBedtime))), "平均入睡", cmp.bedtimeDeltaMin != null ? (cmp.bedtimeDeltaMin <= 0 ? `比上周早 ${-cmp.bedtimeDeltaMin} 分` : `比上周晚 ${cmp.bedtimeDeltaMin} 分`) : ""));
    grid.appendChild(stat(cur.bedtimeSpread ? `±${Math.round(cur.bedtimeSpread / 2)}<small>分</small>` : "--", "作息波动", cur.bedtimeSpread > 90 ? "有点乱" : (cur.nightsLogged > 1 ? "挺规律" : "")));
    grid.appendChild(stat(String(cur.totalWakeups), "起夜"));
    grid.appendChild(stat(cur.goalDurationHits != null ? `${cur.goalDurationHits}<small>/7</small>` : "--", "睡够了"));
    grid.appendChild(stat(cur.goalBedtimeHits != null ? `${cur.goalBedtimeHits}<small>/7</small>` : "--", `${goal().bedtime} 前睡`));
    box.appendChild(grid);
    const review = el("div", "card");
    const key = `weekly_${weekStart}`;
    const saved = state.settings.weeklyLines && state.settings.weeklyLines[key];
    review.innerHTML = `<div class="sec-head"><span class="t">TA 的一周观察</span><button class="act" id="wk-go" type="button" ${cur.nightsLogged && state.character ? "" : "disabled"}>${saved ? "再说一次" : "让 TA 说说"}</button></div>
      ${cur.topMix ? `<div class="day-meta"><span class="chip">最常听：${esc(cur.topMix.name)} · ${cur.topMix.count} 晚</span><span class="chip">记了 ${cur.nightsLogged} 晚</span></div>` : ""}
      <div id="wk-text">${saved ? `<div class="bubble">${esc(saved)}</div>` : `<p class="archive-note">${cur.nightsLogged ? "这周的数据 TA 还没看" : "这周还没有记录"}</p>`}</div>`;
    review.querySelector("#wk-go").onclick = async ev => {
      const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "想着…";
      try {
        const lines = cur.days.filter(d => d.night).map(d => `${d.date}：${fmtClock(new Date(d.night.sleepAt))} 睡，${d.night.wakeAt ? fmtClock(new Date(d.night.wakeAt)) + " 醒" : "没记醒"}，${PmStats.formatDuration(d.night.durationMin)}，自评 ${d.night.rating || "无"}，起夜 ${d.night.wakeups || 0}`);
        const result = await api.ai.generate({ characterId: state.character.id, appTags: ["peimian", "weekly"], instruction: `本周记录：\n${lines.join("\n")}\n作息目标：${goal().bedtime} 前睡，睡够 ${goal().hours} 小时。说几句你的观察。` });
        const text = String(result?.text || "").trim();
        saveSettings({ weeklyLines: { ...(state.settings.weeklyLines || {}), [key]: text } });
        review.querySelector("#wk-text").innerHTML = `<div class="bubble">${esc(text)}</div>`;
      } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = "再说一次"; }
    };
    box.appendChild(review);
  }
  function renderMonth() {
    const box = $("journal-month"); box.innerHTML = "";
    const card = el("div", "card");
    const nav = el("div", "week-nav");
    nav.innerHTML = `<button type="button" class="mini" id="m-prev">‹</button><span class="lbl">${month.y} 年 ${month.m} 月</span><button type="button" class="mini" id="m-next">›</button>`;
    nav.querySelector("#m-prev").onclick = () => { month.m -= 1; if (month.m < 1) { month.m = 12; month.y -= 1; } renderMonth(); };
    nav.querySelector("#m-next").onclick = () => { month.m += 1; if (month.m > 12) { month.m = 1; month.y += 1; } renderMonth(); };
    card.appendChild(nav);
    const grid = el("div", "month");
    for (const w of WD) grid.appendChild(el("div", "month-h", w));
    const byDate = new Map(state.nights.map(n => [n.date, n]));
    const todayKey = PmStats.nightKeyFor(new Date());
    const goalMin = goal().hours * 60;
    for (const key of PmStats.monthGrid(month.y, month.m)) {
      if (!key) { grid.appendChild(el("div", "day empty")); continue; }
      const n = byDate.get(key);
      const cell = el("button", "day" + (key === todayKey ? " today" : "") + (n && n.durationMin >= goalMin ? " hit" : "")); cell.type = "button";
      const dot = el("i"); dot.style.setProperty("--o", n && n.durationMin ? String(Math.min(1, .25 + n.durationMin / (goalMin * 1.2))) : ".12");
      cell.appendChild(dot); cell.appendChild(el("span", null, String(Number(key.slice(8)))));
      if (n) cell.onclick = () => editNight(n);
      grid.appendChild(cell);
    }
    card.appendChild(grid);
    const inMonth = state.nights.filter(n => n.date.startsWith(`${month.y}-${String(month.m).padStart(2, "0")}`) && n.durationMin);
    card.appendChild(el("p", "bar-note", inMonth.length ? `记了 ${inMonth.length} 晚，${inMonth.filter(n => n.durationMin >= goalMin).length} 晚睡够 ${goal().hours} 小时。月亮越亮睡得越久，描边 = 达标。` : "这个月还没有记录"));
    box.appendChild(card);
  }
  function render() {
    document.querySelectorAll("#journal-seg .stab").forEach(b => b.classList.toggle("on", b.dataset.range === range));
    $("journal-title").textContent = range === "day" ? "每一晚" : range === "week" ? "这一周" : "这个月";
    $("journal-day").hidden = range !== "day"; $("journal-week").hidden = range !== "week"; $("journal-month").hidden = range !== "month";
    if (range === "day") renderDay(); else if (range === "week") renderWeek(); else renderMonth();
  }
  function bind() {
    document.querySelectorAll("#journal-seg .stab").forEach(b => { b.onclick = () => { range = b.dataset.range; render(); }; });
    on("view", v => { if (v === "journal") render(); });
    on("nights", () => { if (state.view === "journal") render(); });
  }
  return { render, bind };
})();
