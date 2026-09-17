// ── 入睡会话：开声景 → 角色分段说话（越说越少）→ 定时渐弱 → 落夜记 ──
const session = (() => {
  let run = null;   // { cancelled, night, mode, timer, startedAt, lines[] }
  let clockTimer = 0;
  let stopping = null;
  let nextRun = 0;
  const live = r => !!r && run === r && !r.cancelled && !r.expired && (!r.deadline || Date.now() < r.deadline);

  const userName = async () => { try { const p = await api.user.getProfile({ characterId: state.character?.id }); return p?.name || "你"; } catch { return "你"; } };
  const wait = async (r, sec) => {
    const until = Date.now() + sec * 1000;
    while (Date.now() < until) {
      if (!live(r)) return false;
      await sleep(Math.max(1, Math.min(500, until - Date.now(), r.deadline ? r.deadline - Date.now() : Infinity)));
    }
    return live(r);
  };

  function mixLabel() {
    const mix = state.settings.currentMix;
    if (!mix.layers.length) return "";
    return mix.name || mix.layers.map(l => findSound(l.key)?.name).filter(Boolean).join("+");
  }
  async function voiceAvailable() {
    if (state.voiceReady != null) return state.voiceReady;
    try { const v = await api.voice.readProfiles({ characterId: state.character?.id }); state.voiceReady = !!(v && v.selected); }
    catch { state.voiceReady = false; }
    return state.voiceReady;
  }
  function setSub(text, owner = run) {
    const node = $("sleep-sub"); node.classList.add("fading");
    setTimeout(() => { if (run !== owner) return; node.textContent = text; node.classList.remove("fading"); }, 500);
  }
  function setStatus(text) { $("sleep-status").textContent = text || ""; }

  async function speak(r, text) {
    if (!live(r)) return;
    setSub(text, r);
    r.lines.push(text);
    if (state.settings.ttsOn && await voiceAvailable()) {
      if (!live(r)) return;
      try {
        const tts = await api.voice.tts({ characterId: r.characterId, text, emotion: state.settings.emotion || undefined });
        if (!live(r)) return;
        await api.voice.play({ dataUrl: tts.dataUrl, volume: 1 });
      } catch (e) { if (live(r)) setStatus("语音没成功，只显示字幕"); console.warn(e); }
    }
  }
  function instructionFor(step, total, dirs, forbid) {
    const now = new Date();
    const chosen = PmRhythm.DIRECTIONS.filter(d => dirs.includes(d.id));
    const parts = [
      `现在是 ${fmtClock(now)}。这是第 ${step.index + 1} 段，共 ${total} 段，这一段大约 ${step.chars} 字${step.index === total - 1 ? "，是最后一段，只留一句收尾" : ""}。`,
      chosen.length ? `内容方向（任选其一或融合）：${chosen.map(d => `${d.label}（${d.hint}）`).join("；")}。` : "",
      mixLabel() ? `房间里放着的声音：${mixLabel()}，可以偶尔提到，也可以不提。` : "",
      forbid ? `用户的禁止项，必须遵守：${forbid}` : "",
      "只输出要说的话。",
    ];
    return parts.filter(Boolean).join("\n");
  }
  async function generate(r, tags, instruction) {
    const result = await api.ai.generate({
      characterId: r.characterId, appTags: ["peimian", tags],
      messages: r.lines.slice(-6).map(t => ({ role: "assistant", content: t })),
      instruction,
    });
    return String(result && result.text || "").replace(/^["“「]+|["”」]+$/g, "").trim();
  }
  async function talkLoop(r) {
    const mode = r.mode;
    const s = state.settings;
    const rhythm = mode === "insomnia" ? { ...PmRhythm.normalizeRhythm(s.rhythm), segments: Math.max(2, Math.min(4, PmRhythm.normalizeRhythm(s.rhythm).segments)) } : s.rhythm;
    const steps = PmRhythm.buildSchedule(rhythm);
    const dirs = mode === "insomnia" ? s.insomniaDirections : s.directions;
    const forbid = mode === "insomnia" ? s.insomniaForbid : s.forbid;
    if (!await wait(r, 4)) return;
    for (const step of steps) {
      if (!live(r)) return;
      setStatus("TA 在想怎么说…");
      let text = "";
      try { text = await generate(r, mode === "insomnia" ? "insomnia" : "lull", instructionFor(step, steps.length, dirs, forbid)); }
      catch (e) { if (live(r)) setStatus("这一段没生成出来，先陪着"); console.warn(e); }
      if (!live(r)) return;
      setStatus("");
      if (text) await speak(r, text);
      if (!live(r)) return;
      r.night.segments = r.previousSegments + r.lines.length;
      if (step.gapAfterSec && !await wait(r, step.gapAfterSec)) return;
    }
    setStatus("");
  }
  async function silence(r) {
    const results = await Promise.allSettled([
      api.voice.stopPlayback({ channel: "voice" }), engine.stop(),
      r.listenId ? api.voice.stopSTT({ requestId: r.listenId, cancel: true }) : Promise.resolve(),
    ]);
    return results.every(result => result.status === "fulfilled");
  }
  async function expire(r) {
    if (run !== r || r.cancelled || r.expired) return;
    r.expired = true;
    r.silencing = silence(r);
    const ok = await r.silencing;
    if (run !== r) return;
    setStatus(ok ? "声音停了，晚安" : "停止声音未确认，请点结束重试");
    r.night.segments = r.previousSegments + r.lines.length;
    r.night.lastLine = r.lines[r.lines.length - 1] || r.night.lastLine || "";
    await upsertNight(r.night);
  }
  async function timerLoop(r) {
    if (!r.deadline) return;
    const fadeSec = Math.min(r.timerMin * 60 - 10, (state.settings.fadeMin || 5) * 60);
    const untilFade = Math.max(0, (r.deadline - Date.now()) / 1000 - fadeSec);
    if (!await wait(r, untilFade)) return;
    setStatus("声音慢慢变小…");
    try { await engine.fadeOut(Math.max(0, (r.deadline - Date.now()) / 1000)); }
    catch (e) { if (live(r)) setStatus("渐弱失败，已尝试停止背景音"); console.warn(e); }
  }
  function tickClock() {
    const now = new Date();
    if (run?.deadline && now.getTime() >= run.deadline) expire(run).catch(console.warn);
    $("sleep-clock").textContent = fmtClock(now);
    if (run && run.timerMin) {
      const left = Math.max(0, Math.round((run.startedAt + run.timerMin * 60000 - now.getTime()) / 60000));
      $("sleep-remain").textContent = left ? `还有 ${left} 分钟` : "";
    } else $("sleep-remain").textContent = "到天亮";
  }
  async function writeChat(text) {
    if (!state.settings.syncChat || !state.character) return;
    try { await api.chat.writeHistory({ characterId: state.character.id, role: "user", content: text }); } catch (e) { console.warn(e); }
  }

  async function start({ mode, timerMin }) {
    if (resetting) throw new Error("正在清空数据，请稍后再试");
    if (stopping) await stopping;
    if (run) return;
    await script.cancelPreview();
    if (run) return;
    if (!state.character && mode !== "sound") throw new Error("先选一个角色");
    const now = new Date();
    const key = PmStats.nightKeyFor(now);
    let night = state.nights.find(n => n.date === key);
    const reopened = !!night;
    if (!night) night = { date: key, sleepAt: now.toISOString(), wakeAt: "", durationMin: 0, rating: 0, note: "", wakeups: 0, segments: 0, lastLine: "", morningLine: "", characterId: state.character?.id || "", characterName: state.character?.name || "" };
    night.sleepIntervals = PmStats.nightIntervals(night);
    if (!reopened || night.wakeAt) night.segmentSleepAt = now.toISOString();
    else night.segmentSleepAt = night.segmentSleepAt || night.sleepAt;
    night.wakeAt = "";
    night.mode = mode; night.mixName = mixLabel();
    if (reopened) night.wakeups = (night.wakeups || 0) + 1;
    const r = { id: ++nextRun, cancelled: false, expired: false, night, mode, timerMin, startedAt: now.getTime(),
      previousSegments: night.segments || 0, deadline: timerMin ? now.getTime() + timerMin * 60000 : 0, characterId: state.character?.id, lines: [] };
    run = r;
    try { await upsertNight(night); } catch (e) { if (run === r) run = null; throw e; }
    if (!live(r)) return;
    if (r.deadline) r.endTimer = setTimeout(() => expire(r).catch(console.warn), Math.max(0, r.deadline - Date.now()));
    $("sleep").hidden = false; $("sleep").classList.toggle("dim", !!state.settings.dimLevel);
    $("btn-mic").hidden = !(state.settings.sttOn && state.character && mode !== "sound");
    setSub(mode === "sound" ? "" : "……"); setStatus(""); tickClock(); clockTimer = setInterval(tickClock, 15000);
    const mix = state.settings.currentMix;
    if (mix.layers.length) { setStatus("声音准备中…"); try { await engine.play(mix); if (live(r)) setStatus(""); } catch (e) { if (live(r)) setStatus("声音没放出来：" + (e.message || e)); } }
    if (!live(r)) return;
    const name = await userName();
    if (!live(r)) return;
    writeChat(reopened
      ? `[陪眠：${name}半夜醒了又躺下，${fmtClock(now)}，${state.character?.name || "TA"}在枕边陪着。]`
      : `[陪眠：${name}在 ${fmtClock(now)} 准备睡了${mixLabel() ? `，房间里放着${mixLabel()}` : ""}${state.character ? `，${state.character.name}在枕边陪着` : ""}。]`);
    timerLoop(r).catch(console.warn);
    if (mode !== "sound") talkLoop(r).catch(console.warn);
  }
  async function stop() {
    if (stopping) return stopping;
    const r = run;
    if (!r) return;
    r.cancelled = true;
    clearTimeout(r.endTimer); clearInterval(clockTimer);
    $("sleep").hidden = true;
    stopping = (async () => {
      if (r.silencing) await r.silencing;
      await silence(r);
      r.night.segments = r.previousSegments + r.lines.length;
      r.night.lastLine = r.lines[r.lines.length - 1] || r.night.lastLine || "";
      await upsertNight(r.night);
    })();
    try { await stopping; } finally { if (run === r) run = null; stopping = null; }
  }
  // 松手只结束本次 STT；停止/到点取消识别，不把残余文字提交给模型。
  async function listen() {
    const r = run;
    if (!live(r) || r.listenId || !r.characterId) return;
    const requestId = `pm_${r.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    r.listenId = requestId;
    $("btn-mic").classList.add("rec"); setStatus("在听…");
    try {
      const stt = await api.voice.stt({ requestId, lang: "zh-CN", timeoutMs: 12000 });
      if (!live(r)) return;
      const heard = stt && stt.text ? stt.text.trim() : "";
      if (!heard) { setStatus("没听清"); return; }
      setStatus(`你说：${heard}`);
      const text = await generate(r, "reply", `用户刚刚小声说：「${heard}」。现在是 ${fmtClock(new Date())}。只回一两句，不超过 40 字。`);
      if (!live(r)) return;
      setStatus("");
      if (text) await speak(r, text);
    } catch (e) { if (live(r)) setStatus("没听到，再试一次"); console.warn(e); }
    finally { r.listenId = null; if (run === r) $("btn-mic").classList.remove("rec"); }
  }
  async function stopListening() {
    const r = run;
    if (!r?.listenId) return;
    try { await api.voice.stopSTT({ requestId: r.listenId }); } catch (e) { if (live(r)) setStatus("停止识别失败，请等自动结束"); console.warn(e); }
  }

  // 醒来：补时长、自评、早安一句
  async function wake(night, { rating, note }) {
    const epoch = dataEpoch;
    const now = new Date();
    night.wakeAt = now.toISOString();
    night.sleepIntervals = PmStats.unionNightIntervals([...PmStats.nightIntervals(night), { start: night.segmentSleepAt || night.sleepAt, end: night.wakeAt }]);
    night.segmentSleepAt = "";
    night.durationMin = PmStats.intervalMinutes(night.sleepIntervals);
    night.rating = rating || 0; night.note = note || "";
    await upsertNight(night);
    const name = await userName();
    writeChat(`[陪眠：${name}在 ${fmtClock(now)} 醒了，昨晚睡了 ${PmStats.formatDuration(night.durationMin)}${night.rating ? `，自评 ${night.rating}/5` : ""}${night.note ? `，说：${night.note}` : ""}。]`);
    if (state.settings.morningOn && state.character) {
      try {
        const result = await api.ai.generate({
          characterId: state.character.id, appTags: ["peimian", "morning"],
          instruction: `昨晚数据：${fmtClock(new Date(night.sleepAt))} 睡，${fmtClock(now)} 醒，睡了 ${PmStats.formatDuration(night.durationMin)}；声音：${night.mixName || "没开"}；你最后说的：「${night.lastLine || "（没说话）"}」；起夜 ${night.wakeups || 0} 次；用户自评 ${night.rating || "未评"}/5${night.note ? `；用户说：${night.note}` : ""}。说一句早安。`,
        });
        if (!dataCurrent(epoch)) return night;
        night.morningLine = String(result?.text || "").trim().slice(0, 200);
        await upsertNight(night, epoch);
      } catch (e) { console.warn(e); }
    }
    return night;
  }
  return { start, stop, listen, stopListening, wake, active: () => !!run };
})();
