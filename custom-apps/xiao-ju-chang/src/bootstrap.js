// ── 启动 ──
async function boot() {
  if (!api) { document.body.innerHTML = '<p style="padding:24px;font-size:13px">这个页面要在 AI 手机里作为自定义 APP 打开。</p>'; return; }
  await loadSettings();
  theme.apply();
  const [chars] = await Promise.all([
    api.characters.list().catch(() => []),
    loadAll(),
  ]);
  state.characters = Array.isArray(chars) ? chars : (chars && chars.characters) || [];
  await seedIfEmpty();
  let launch = null;
  try { launch = api.app && api.app.getLaunchContext ? await api.app.getLaunchContext() : null; } catch {}
  const wantId = (launch && launch.characterId) || state.settings.characterId;
  state.character = byId(state.characters, wantId) || state.characters[0] || null;
  if (state.character && state.character.id !== state.settings.characterId) saveSettings({ characterId: state.character.id });
  if (!byId(state.combos, state.settings.currentComboId) && state.combos[0]) saveSettings({ currentComboId: state.combos[0].id });
  await refreshUserName(state.character);
  stage.bind(); library.bind(); favorites.bind(); settings.bind();
  switchView("stage");
  if (api.__mock) window.__xjc = { state, stage, library, favorites, settings, switchView, generateTheater, buildTasks, expandMacros };
}
boot().catch(e => { console.error(e); const m = $("main"); m.innerHTML = ""; m.appendChild(el("div", "err", `启动失败：${e && e.message ? e.message : e}`)); });
})();
