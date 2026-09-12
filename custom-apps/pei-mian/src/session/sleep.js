// ── 入睡会话：开声景 → 角色分段说话（越说越少）→ 定时渐弱 → 落夜记 ──
const session = (() => {
  let run = null;   // { cancelled, night, mode, timer, startedAt, lines[] }
  let clockTimer = 0;

  const userName = async () => { try { const p = await api.user.getProfile({ characterId: state.character?.id }); return p?.name || "你"; } catch { return "你"; } };
  const wait = async (sec) => { const until = Date.now() + sec * 1000; while (Date.now() < until) { if (!run || run.cancelled) return false; await sleep(Math.min(500, until - Date.now())); } return !!run && !run.cancelled; };

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
  function setSub(text) {
    const node = $("sleep-sub"); node.classList.add("fading");
    setTimeout(() => { node.textContent = text; node.classList.remove("fading"); }, 500);
  }
  function setStatus(text) { $("sleep-status").textContent = text || ""; }

  async function speak(text) {
    if (!run || run.cancelled) return;
    setSub(text);
    run.lines.push(text);
    if (state.settings.ttsOn && await voiceAvailable()) {
      try {
        const tts = await api.voice.tts({ characterId: state.character.id, text, emotion: state.settings.emotion || undefined });
        if (!run || run.cancelled) return;
        await api.voice.play({ dataUrl: tts.dataUrl, volume: 1 });
      } catch (e) { setStatus("语音没成功，只显示字幕"); console.warn(e); }
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
  async function generate(tags, instruction) {
    const result = await api.ai.generate({
      characterId: state.character.id, appTags: ["peimian", tags],
      messages: run.lines.slice(-6).map(t => ({ role: "assistant", content: t })),
      instruction,
    });
    return String(result && result.text || "").replace(/^["“「]+|["”」]+$/g, "").trim();
  }
  async function talkLoop() {
    const mode = run.mode;
    const s = state.settings;
    const rhythm = mode === "insomnia" ? { ...PmRhythm.normalizeRhythm(s.rhythm), segments: Math.max(2, Math.min(4, PmRhythm.normalizeRhythm(s.rhythm).segments)) } : s.rhythm;
    const steps = PmRhythm.buildSchedule(rhythm);
    const dirs = mode === "insomnia" ? s.insomniaDirections : s.directions;
    const forbid = mode === "insomnia" ? s.insomniaForbid : s.forbid;
    if (!await wait(4)) return;
    for (const step of steps) {
      if (!run || run.cancelled) return;
      setStatus("TA 在想怎么说…");
      let text = "";
      try { text = await generate(mode === "insomnia" ? "insomnia" : "lull", instructionFor(step, steps.length, dirs, forbid)); }
      catch (e) { setStatus("这一段没生成出来，先陪着"); console.warn(e); }
      setStatus("");
      if (text) await speak(text);
      run.night.segments = run.lines.length;
      if (step.gapAfterSec && !await wait(step.gapAfterSec)) return;
    }
    setStatus("");
  }
  async function timerLoop() {
    if (!run.timerMin) return;
    const fadeSec = Math.min(run.timerMin * 60 - 10, (state.settings.fadeMin || 5) * 60);
    const untilFade = run.timerMin * 60 - fadeSec;
    if (!await wait(untilFade)) return;
    setStatus("声音慢慢变小…");
    try { await engine.fadeOut(fadeSec); } catch (e) { console.warn(e); }
    if (!run || run.cancelled) return;
    setStatus("声音停了，晚安");
  }
  function tickClock() {
    const now = new Date();
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
    if (run) return;
    if (!state.character && mode !== "sound") throw new Error("先选一个角色");
    const now = new Date();
    const key = PmStats.nightKeyFor(now);
    let night = state.nights.find(n => n.date === key && !n.wakeAt);
    const reopened = !!night;
    if (!night) night = { date: key, sleepAt: now.toISOString(), wakeAt: "", durationMin: 0, rating: 0, note: "", wakeups: 0, segments: 0, lastLine: "", morningLine: "", characterId: state.character?.id || "", characterName: state.character?.name || "" };
    night.mode = mode; night.mixName = mixLabel();
    if (reopened) night.wakeups = (night.wakeups || 0) + 1;
    await upsertNight(night);
    run = { cancelled: false, night, mode, timerMin, startedAt: now.getTime(), lines: [] };
    $("sleep").hidden = false; $("sleep").classList.toggle("dim", !!state.settings.dimLevel);
    $("btn-mic").hidden = !(state.settings.sttOn && state.character && mode !== "sound");
    setSub(mode === "sound" ? "" : "……"); setStatus(""); tickClock(); clockTimer = setInterval(tickClock, 15000);
    const mix = state.settings.currentMix;
    if (mix.layers.length) { setStatus("声音准备中…"); try { await engine.play(mix); setStatus(""); } catch (e) { setStatus("声音没放出来：" + (e.message || e)); } }
    const name = await userName();
    writeChat(reopened
      ? `[陪眠：${name}半夜醒了又躺下，${fmtClock(now)}，${state.character?.name || "TA"}在枕边陪着。]`
      : `[陪眠：${name}在 ${fmtClock(now)} 准备睡了${mixLabel() ? `，房间里放着${mixLabel()}` : ""}${state.character ? `，${state.character.name}在枕边陪着` : ""}。]`);
    timerLoop().catch(console.warn);
    if (mode !== "sound") talkLoop().catch(console.warn);
  }
  async function stop() {
    if (!run) return;
    run.cancelled = true;
    const night = run.night;
    night.segments = run.lines.length; night.lastLine = run.lines[run.lines.length - 1] || night.lastLine || "";
    run = null; clearInterval(clockTimer);
    $("sleep").hidden = true;
    try { await api.voice.stopPlayback({ channel: "voice" }); } catch { /* ignore */ }
    await engine.stop();
    await upsertNight(night);
  }
  // 躺着说话：按住识别，松开发出去
  let listening = false;
  async function listen() {
    if (!run || listening || !state.character) return;
    listening = true; $("btn-mic").classList.add("rec"); setStatus("在听…");
    try {
      const stt = await api.voice.stt({ lang: "zh-CN", timeoutMs: 12000 });
      const heard = stt && stt.text ? stt.text.trim() : "";
      if (!heard) { setStatus("没听清"); return; }
      setStatus(`你说：${heard}`);
      const text = await generate("reply", `用户刚刚小声说：「${heard}」。现在是 ${fmtClock(new Date())}。只回一两句，不超过 40 字。`);
      setStatus("");
      if (text) await speak(text);
    } catch (e) { setStatus("没听到，再试一次"); console.warn(e); }
    finally { listening = false; $("btn-mic").classList.remove("rec"); }
  }
  async function stopListening() { try { await api.voice.stopRecord(); } catch { /* ignore */ } }

  // 醒来：补时长、自评、早安一句
  async function wake(night, { rating, note }) {
    const now = new Date();
    night.wakeAt = now.toISOString();
    night.durationMin = PmStats.minutesBetween(night.sleepAt, night.wakeAt);
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
        night.morningLine = String(result?.text || "").trim().slice(0, 200);
        await upsertNight(night);
      } catch (e) { console.warn(e); }
    }
    return night;
  }
  return { start, stop, listen, stopListening, wake, active: () => !!run };
})();
