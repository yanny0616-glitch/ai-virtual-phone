// ── 话术 ──
const script = (() => {
  const FIELDS = ["segments", "firstChars", "lastChars", "firstGapSec", "lastGapSec"];
  const fmtGap = s => s >= 60 ? `${Math.round(s / 60 * 10) / 10} 分` : `${s} 秒`;
  function rhythm() { return PmRhythm.normalizeRhythm(state.settings.rhythm || PmRhythm.RHYTHM_PRESETS[state.settings.rhythmPreset]); }
  function renderRhythm() {
    const r = rhythm();
    for (const f of FIELDS) { const input = $(`r-${f}`); input.value = r[f]; input.nextElementSibling.textContent = f.endsWith("Sec") ? fmtGap(r[f]) : (f === "segments" ? `${r[f]} 段` : `${r[f]} 字`); }
    $("rhythm-desc").textContent = PmRhythm.describeSchedule(r);
    const box = $("rhythm-presets"); box.innerHTML = "";
    for (const p of Object.values(PmRhythm.RHYTHM_PRESETS)) {
      const b = el("button", state.settings.rhythmPreset === p.id ? "on" : "", p.name); b.type = "button";
      b.onclick = () => { saveSettings({ rhythmPreset: p.id, rhythm: { ...p } }); renderRhythm(); };
      box.appendChild(b);
    }
    const b = el("button", state.settings.rhythmPreset === "custom" ? "on" : "", "自定义"); b.type = "button"; b.onclick = () => { saveSettings({ rhythmPreset: "custom" }); renderRhythm(); }; box.appendChild(b);
    const curve = $("rhythm-curve"); curve.innerHTML = "";
    const steps = PmRhythm.buildSchedule(r); const max = Math.max(...steps.map(s => s.chars));
    for (const s of steps) { const i = el("i"); i.style.height = `${Math.max(6, s.chars / max * 100)}%`; i.style.flex = String(1 + s.gapAfterSec / 60); curve.appendChild(i); }
  }
  function renderChips(boxId, key) {
    const box = $(boxId); box.innerHTML = "";
    const chosen = state.settings[key] || [];
    for (const d of PmRhythm.DIRECTIONS) {
      const b = el("button", "tgl check" + (chosen.includes(d.id) ? " on" : ""), d.label); b.type = "button"; b.title = d.hint;
      b.onclick = () => { const next = chosen.includes(d.id) ? chosen.filter(x => x !== d.id) : chosen.concat(d.id); saveSettings({ [key]: next }); renderChips(boxId, key); };
      box.appendChild(b);
    }
  }
  async function tryLine() {
    if (!state.character) { toast("先在配置里选个陪你的人"); return; }
    const btn = $("btn-try-line"); btn.disabled = true; btn.textContent = "生成中…"; $("try-line").hidden = true;
    try {
      const steps = PmRhythm.buildSchedule(rhythm());
      const chosen = PmRhythm.DIRECTIONS.filter(d => (state.settings.directions || []).includes(d.id));
      const result = await api.ai.generate({ characterId: state.character.id, appTags: ["peimian", "lull"], instruction: `现在是 ${fmtClock(new Date())}。这是第 1 段，共 ${steps.length} 段，这一段大约 ${steps[0].chars} 字。${chosen.length ? `内容方向：${chosen.map(d => d.label).join("、")}。` : ""}${state.settings.forbid ? `禁止项：${state.settings.forbid}` : ""}只输出要说的话。` });
      const text = String(result?.text || "").trim();
      $("try-line").innerHTML = `<div class="from">${esc(state.character.name)} · 第一段</div>${esc(text)}`; $("try-line").hidden = !text;
      if (text && state.settings.ttsOn) {
        btn.textContent = "朗读中…";
        try { const tts = await api.voice.tts({ characterId: state.character.id, text, emotion: state.settings.emotion || undefined }); await api.voice.play({ dataUrl: tts.dataUrl }); }
        catch (e) { toast("语音没成功：" + (e.message || e), 3000); }
      }
    } catch (e) { fail(e); }
    finally { btn.disabled = false; btn.textContent = "试一句"; }
  }
  function bind() {
    for (const f of FIELDS) {
      const input = $(`r-${f}`);
      input.oninput = () => { const r = { ...rhythm(), [f]: Number(input.value) }; state.settings.rhythm = r; state.settings.rhythmPreset = "custom"; renderRhythm(); };
      input.onchange = () => saveSettings({ rhythm: rhythm(), rhythmPreset: "custom" });
    }
    $("forbid").onchange = () => saveSettings({ forbid: $("forbid").value.trim() });
    $("insomnia-forbid").onchange = () => saveSettings({ insomniaForbid: $("insomnia-forbid").value.trim() });
    $("tts-on").onchange = () => saveSettings({ ttsOn: $("tts-on").checked });
    $("btn-try-line").onclick = tryLine;
    on("view", v => { if (v === "script") render(); });
  }
  async function render() {
    renderRhythm(); renderChips("directions", "directions"); renderChips("insomnia-directions", "insomniaDirections");
    $("forbid").value = state.settings.forbid || ""; $("insomnia-forbid").value = state.settings.insomniaForbid || ""; $("tts-on").checked = !!state.settings.ttsOn;
    if (state.character) {
      try { const v = await api.voice.readProfiles({ characterId: state.character.id }); state.voiceReady = !!(v && v.selected); $("tts-hint").textContent = state.voiceReady ? `${state.character.name}的语音：${v.selected.provider || ""} ${v.selected.model || v.selected.name || ""}`.trim() : `${state.character.name}还没配语音，会只显示字幕`; }
      catch { state.voiceReady = false; $("tts-hint").textContent = "读不到语音配置，会只显示字幕"; }
    }
  }
  return { render, bind };
})();
