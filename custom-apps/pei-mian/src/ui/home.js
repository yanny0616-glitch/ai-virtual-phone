// ── 今夜 ──
const home = (() => {
  const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const STOPS = [{ min: 15, lbl: "15分" }, { min: 30, lbl: "30分" }, { min: 45, lbl: "45分" }, { min: 60, lbl: "1时" }, { min: 90, lbl: "1.5时" }, { min: 0, lbl: "天亮" }];
  const R = 128, C = 150, A0 = -120, SWEEP = 240;
  const pt = (deg, r = R) => { const t = deg * Math.PI / 180; return [C + r * Math.sin(t), C - r * Math.cos(t)]; };
  const angleOf = i => A0 + SWEEP * i / (STOPS.length - 1);
  function greeting() { const h = new Date().getHours(); if (h < 5) return "还醒着"; if (h < 11) return "早"; if (h < 18) return "午安"; if (h < 22) return "晚上好"; return "晚安"; }
  function mixText() { const mix = state.settings.currentMix; return mix.layers.map(l => findSound(l.key)?.name).filter(Boolean); }
  function openNight() { return state.nights.find(n => !n.wakeAt && Date.now() - new Date(n.sleepAt).getTime() < 20 * 3600000) || null; }

  function renderDial() {
    const idx = Math.max(0, STOPS.findIndex(s => s.min === state.timerMin));
        const arc = $("ring-arc");
    if (!arc.getAttribute("d")) { const [x0, y0] = pt(A0), [x1, y1] = pt(A0 + SWEEP); arc.setAttribute("d", `M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 1 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`); arc.setAttribute("pathLength", "1"); }
    arc.style.strokeDashoffset = String(1 - idx / (STOPS.length - 1));
    arc.style.opacity = idx === 0 ? "0" : "1";
    const g = $("ring-stops"); g.innerHTML = "";
    STOPS.forEach((s, i) => {
      const a = angleOf(i); const [x, y] = pt(a); const [lx, ly] = pt(a, R + 22);
      const on = i === idx;
      const ns = "http://www.w3.org/2000/svg";
      const dot = document.createElementNS(ns, "circle"); dot.setAttribute("class", "ring-stop" + (on ? " on" : "")); dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", on ? 5 : 3.5);
      const lbl = document.createElementNS(ns, "text"); lbl.setAttribute("class", "ring-lbl" + (on ? " on" : "")); lbl.setAttribute("x", lx); lbl.setAttribute("y", ly + 4); lbl.textContent = s.lbl;
      const hit = document.createElementNS(ns, "circle"); hit.setAttribute("class", "ring-hit"); hit.setAttribute("cx", x); hit.setAttribute("cy", y); hit.setAttribute("r", 22);
      hit.onclick = () => { state.timerMin = s.min; saveSettings({ timerMin: s.min }); renderDial(); $("dial").classList.remove("tick"); void $("dial").offsetWidth; $("dial").classList.add("tick"); };
      g.append(dot, lbl, hit);
    });
    $("dial-val").textContent = state.timerMin ? STOPS[idx].lbl.replace("分", " 分").replace("时", " 小时") : "到天亮";
    $("dial-val").nextElementSibling.textContent = state.timerMin ? "后停" : "";
  }
  function renderTop() {
    const d = new Date();
    $("hdr-date").textContent = `${WD[d.getDay()]} · ${String(d.getDate()).padStart(2, "0")} ${MON[d.getMonth()]}`;
    $("home-greet").textContent = greeting();
    const open = openNight(); const c = state.character;
    $("hero-who").innerHTML = !c ? "去配置里选一个陪你的人" : open ? `<span class="live"></span>${esc(c.name)} 从 ${esc(fmtClock(new Date(open.sleepAt)))} 起一直陪着你` : `${esc(c.name)} · 今晚在${state.voiceReady === false ? " · 还没配语音，只出字幕" : ""}`;
  }
  function renderRows() {
    const mix = state.settings.currentMix; const names = mixText();
    $("home-mix-name").textContent = mix.layers.length ? (mix.name || `${mix.layers.length} 层`) : "安静";
    $("home-mix-layers").textContent = names.length ? names.join(" · ") : "没有开任何声音";
    const preset = PmRhythm.RHYTHM_PRESETS[state.settings.rhythmPreset];
    $("home-script-name").textContent = preset ? preset.name : "自定义";
    $("home-script-desc").textContent = PmRhythm.describeSchedule(state.settings.rhythm);
    const open = openNight();
    $("open-night").hidden = !open;
    if (open) $("open-night-text").textContent = `${fmtClock(new Date(open.sleepAt))} 睡的${open.mixName ? `，听着${open.mixName}` : ""}${open.wakeups ? `，起夜 ${open.wakeups} 次` : ""}，还没记醒来`;
    document.querySelectorAll("#mode-seg button").forEach(b => b.classList.toggle("on", b.dataset.mode === state.mode));
    $("btn-sleep").textContent = state.mode === "sound" ? "开始" : "睡了";
    const streak = PmStats.streakDays(state.nights, PmStats.nightKeyFor(new Date()));
    $("home-foot").textContent = streak ? `已连续记录 ${streak} 晚` : "第一晚，从今天开始";
    renderLastNight();
  }
  function renderLastNight() {
    const box = $("last-night"); box.innerHTML = "";
    const last = state.nights.find(n => n.wakeAt && n.durationMin);
    if (!last) return;
    const card = el("div", "last");
    card.innerHTML = `<div class="lk"><span class="eyebrow">昨晚 · ${esc(last.date.slice(5).replace("-", "/"))}</span><button class="txt-btn" type="button" data-go="journal">全部夜记 ›</button></div>
      <div class="l1"><span>${esc(fmtClock(new Date(last.sleepAt)))} → ${esc(fmtClock(new Date(last.wakeAt)))}</span><span>${esc(PmStats.formatDuration(last.durationMin))}</span>${moonsHtml(last.rating)}</div>
      ${last.mixName ? `<div class="l2">听着 ${esc(last.mixName)}</div>` : ""}
      ${last.lastLine ? `<div class="bubble"><div class="from">${esc(last.characterName || "TA")} · 最后一句</div>${esc(last.lastLine)}</div>` : ""}${last.morningLine ? `<div class="bubble"><div class="from">早安</div>${esc(last.morningLine)}</div>` : ""}`;
    card.querySelector("[data-go]").onclick = () => switchView("journal");
    box.appendChild(card);
  }
  function render() { renderTop(); renderDial(); renderRows(); }

  function openWakeSheet(night) {
    openSheet("醒了", box => {
      let rating = 0;
      box.innerHTML = `<p class="hint">${esc(fmtClock(new Date(night.sleepAt)))} 睡的，现在 ${esc(fmtClock(new Date()))}，约 ${esc(PmStats.formatDuration(PmStats.minutesBetween(night.sleepAt, new Date().toISOString())))}</p>
        <div class="grp"><div class="grp-t">睡得怎么样</div><div class="rate" id="wake-rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}">${iconSvg("moon")}</button>`).join("")}</div></div>
        <div class="grp"><div class="grp-t">一句话 <span class="grp-sub">可以不写</span></div><textarea id="wake-note" class="txt-in" rows="2" placeholder="做了什么梦？"></textarea></div>
        <button class="big-btn" id="wake-ok" type="button">记下</button>`;
      box.querySelectorAll("#wake-rate button").forEach(b => { b.onclick = () => { rating = Number(b.dataset.n); box.querySelectorAll("#wake-rate button").forEach(x => x.classList.toggle("on", Number(x.dataset.n) <= rating)); }; });
      box.querySelector("#wake-ok").onclick = async () => {
        const btn = box.querySelector("#wake-ok"); btn.disabled = true; btn.textContent = "记着…";
        try {
          const saved = await session.wake(night, { rating, note: box.querySelector("#wake-note").value.trim() });
          closeSheet(); render();
          if (saved.morningLine) setTimeout(() => openSheet(`${state.character?.name || "TA"} 说`, b2 => { b2.innerHTML = `<div class="bubble" style="margin-top:0">${esc(saved.morningLine)}</div><button class="big-btn" type="button" id="m-ok">早安</button>`; b2.querySelector("#m-ok").onclick = closeSheet; }), 350);
          else toast("记下了");
        } catch (e) { fail(e); btn.disabled = false; btn.textContent = "记下"; }
      };
    });
  }

  function bind() {
    document.querySelectorAll("#mode-seg button").forEach(b => { b.onclick = () => { state.mode = b.dataset.mode; renderRows(); }; });
    $("home-mix").onclick = () => switchView("sounds");
    $("home-script").onclick = () => switchView("script");
    $("btn-wake").onclick = () => { const open = openNight(); if (open) openWakeSheet(open); };
    $("btn-sleep").onclick = async () => {
      const btn = $("btn-sleep"); btn.disabled = true;
      try { await session.start({ mode: state.mode, timerMin: state.timerMin }); }
      catch (e) { fail(e); }
      finally { btn.disabled = false; }
    };
    $("btn-stop").onclick = async () => { await session.stop(); render(); const open = openNight(); if (open) openWakeSheet(open); };
    $("btn-dim").onclick = () => { const on = !$("sleep").classList.contains("dim"); $("sleep").classList.toggle("dim", on); saveSettings({ dimLevel: on ? 1 : 0 }); };
    const mic = $("btn-mic");
    mic.addEventListener("pointerdown", e => { e.preventDefault(); mic.setPointerCapture(e.pointerId); session.listen(); });
    mic.addEventListener("pointerup", () => session.stopListening());
    mic.addEventListener("pointercancel", () => session.stopListening());
    on("nights", renderRows); on("view", v => { if (v === "home") render(); }); on("character", render);
  }
  return { render, bind, renderWho: renderTop };
})();
