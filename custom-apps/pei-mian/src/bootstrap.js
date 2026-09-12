// ── 启动 ──
async function boot() {
  try {
    await loadSettings();
    theme.apply();
    const [chars] = await Promise.all([api.characters.list().catch(() => []), loadNights(), loadMixes(), loadLibrary()]);
    state.characters = Array.isArray(chars) ? chars : (chars && chars.characters) || [];
    let launch = null; try { launch = await api.app.getLaunchContext(); } catch { /* ignore */ }
    const wantId = (launch && launch.characterId) || state.settings.characterId;
    state.character = state.characters.find(c => c.id === wantId) || state.characters[0] || null;
    if (state.character && state.settings.characterId !== state.character.id) saveSettings({ characterId: state.character.id });
    state.timerMin = Number.isFinite(state.settings.timerMin) ? state.settings.timerMin : 45;
    if (!state.settings.rhythm) state.settings.rhythm = { ...PmRhythm.RHYTHM_PRESETS[state.settings.rhythmPreset] || PmRhythm.RHYTHM_PRESETS.gentle };
    home.bind(); sounds.bind(); script.bind(); journal.bind(); settings.bind();
    home.render();
    if (state.character) { api.voice.readProfiles({ characterId: state.character.id }).then(v => { state.voiceReady = !!(v && v.selected); home.renderWho(); }).catch(() => { state.voiceReady = false; home.renderWho(); }); }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.view === "home") home.render(); });
  } catch (e) { fail(e); }
}
if (api && api.__mock) window.__pm = { engine, store, state, PmMixer, PmWav, findSound };
boot();
})();
