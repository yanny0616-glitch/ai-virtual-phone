// ── 配置（右上角齿轮 → 底部弹层）──
const settings = (() => {
  function charGrid() {
    return `<div class="char-grid">${state.characters.map(c => `<button type="button" class="char-cell${state.character && c.id === state.character.id ? " sel" : ""}" data-id="${esc(c.id)}"><span class="ava">${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : esc(c.name.slice(0, 1))}</span><span class="nm">${esc(c.name)}</span></button>`).join("") || `<p class="empty">还没有角色，先去角色 APP 建一个</p>`}</div>`;
  }
  function render() {
    const s = state.settings;
    const box = $("settings-body");
    {
      box.innerHTML = `
        <div class="grp"><div class="grp-t">陪你的人 <span class="grp-sub">只选一个</span></div>${charGrid()}</div>
        <div class="grp"><div class="grp-t">主题</div>
          <div class="themes" id="theme-picker"><button type="button" data-theme="auto"><i class="swatch auto"></i><span>夜航</span><small>日夜切换</small></button><button type="button" data-theme="candle"><i class="swatch candle"></i><span>暖烛</span><small>固定</small></button><button type="button" data-theme="mist"><i class="swatch mist"></i><span>灰雾</span><small>固定</small></button></div>
          <div class="seg" id="auto-by"><button type="button" data-by="system">跟随系统</button><button type="button" data-by="time">按时间</button><button type="button" data-by="day">一直白天</button><button type="button" data-by="night">一直夜晚</button></div>
          <div class="grp-hint" id="auto-hint">按时间：7 点到 19 点是白天。</div></div>
        <div class="grp"><div class="grp-t">语音</div>
          <div class="frow"><div><div class="fl">情绪</div><div class="fu">Minimax 语音支持，其它供应商忽略</div></div><select id="tts-emotion" class="select"><option value="calm">平静</option><option value="neutral">中性</option><option value="fluent">流畅</option><option value="">不指定</option></select></div>
          <div class="frow"><div><div class="fl">躺着说话</div><div class="fu">入睡画面长按麦克风，说一句 TA 回一句</div></div><label class="sw"><input id="stt-on" type="checkbox"><i></i></label></div></div>
        <div class="grp"><div class="grp-t">作息目标</div>
          <div class="frow"><div class="fl">目标入睡</div><input id="goal-bed" type="time" class="field time"></div>
          <div class="frow"><div class="fl">目标时长</div><span><input id="goal-hours" type="number" class="field num" min="4" max="12" step="0.5"> <span class="fu" style="display:inline">小时</span></span></div></div>
        <div class="grp"><div class="grp-t">声景</div>
          <div class="frow"><div class="fl">结束前渐弱</div><select id="fade-min" class="select"><option value="1">1 分钟</option><option value="2">2 分钟</option><option value="5">5 分钟</option><option value="10">10 分钟</option></select></div>
          <div class="frow col"><div><div class="fl">Freesound API Key</div><div class="fu">声音商店要用。到 freesound.org/apiv2/apply 申请，只存在这台设备</div></div><input id="fs-key" type="password" class="field" placeholder="粘贴 key" autocomplete="off"></div></div>
        <div class="grp"><div class="grp-t">和聊天的关系</div>
          <div class="frow"><div><div class="fl">睡了 / 醒了写进聊天记录</div><div class="fu">TA 下次聊天知道你昨晚几点睡</div></div><label class="sw"><input id="sync-chat" type="checkbox"><i></i></label></div>
          <div class="frow"><div><div class="fl">早安一句</div><div class="fu">点「我醒了」时让 TA 说一句</div></div><label class="sw"><input id="morning-on" type="checkbox"><i></i></label></div></div>
        <div class="grp"><div class="frow"><div class="fl">声音来源与致谢</div><button class="mini" type="button" id="btn-credits">看</button></div><div class="frow"><div class="fl">清空陪眠的全部数据</div><button class="mini warn" type="button" id="btn-reset">清空</button></div></div>
        <p class="foot">陪眠 · 第一版</p>`;
      const q = sel => box.querySelector(sel);
      const paint = () => {
        box.querySelectorAll("#theme-picker button").forEach(b => b.classList.toggle("on", b.dataset.theme === s.theme));
        q("#auto-by").hidden = s.theme !== "auto"; q("#auto-hint").hidden = s.theme !== "auto";
        box.querySelectorAll("#auto-by button").forEach(b => b.classList.toggle("on", b.dataset.by === (s.autoBy || "system")));
      };
      paint();
      box.querySelectorAll(".char-cell").forEach(b => { b.onclick = () => { const c = state.characters.find(x => x.id === b.dataset.id); if (!c) return; state.character = c; state.voiceReady = null; saveSettings({ characterId: c.id }); box.querySelectorAll(".char-cell").forEach(x => x.classList.toggle("sel", x.dataset.id === c.id)); emit("character", c); }; });
      box.querySelectorAll("#theme-picker button").forEach(b => { b.onclick = () => { saveSettings({ theme: b.dataset.theme }); theme.apply(); paint(); }; });
      box.querySelectorAll("#auto-by button").forEach(b => { b.onclick = () => { saveSettings({ autoBy: b.dataset.by }); theme.apply(); paint(); }; });
      q("#tts-emotion").value = s.emotion ?? "calm"; q("#tts-emotion").onchange = e => saveSettings({ emotion: e.target.value });
      q("#stt-on").checked = !!s.sttOn; q("#stt-on").onchange = e => saveSettings({ sttOn: e.target.checked });
      q("#goal-bed").value = s.goal.bedtime; q("#goal-bed").onchange = e => saveSettings({ goal: { ...state.settings.goal, bedtime: e.target.value || "23:30" } });
      q("#goal-hours").value = s.goal.hours; q("#goal-hours").onchange = e => saveSettings({ goal: { ...state.settings.goal, hours: Math.min(12, Math.max(4, Number(e.target.value) || 7.5)) } });
      q("#fade-min").value = String(s.fadeMin || 5); q("#fade-min").onchange = e => saveSettings({ fadeMin: Number(e.target.value) });
      q("#fs-key").value = s.freesoundKey || ""; q("#fs-key").onchange = e => saveSettings({ freesoundKey: e.target.value.trim() });
      q("#sync-chat").checked = !!s.syncChat; q("#sync-chat").onchange = e => saveSettings({ syncChat: e.target.checked });
      q("#morning-on").checked = !!s.morningOn; q("#morning-on").onchange = e => saveSettings({ morningOn: e.target.checked });
      q("#btn-credits").onclick = credits;
      q("#btn-reset").onclick = async () => { if (!confirm("清空陪眠的夜记、组合和下载的声音？不可恢复。")) return; try { await session.stop(); await resetAll(); theme.apply(); toast("清空了"); switchView("home"); } catch (e) { fail(e); } };
    }
  }
  function credits() {
    openSheet("声音来源", box => {
      const rows = Object.entries(SOUND_SOURCES).map(([key, s]) => `<p class="credit"><b>${esc(findSound(key)?.name || key)}</b> — ${esc(s.name)} by ${esc(s.author)} · CC0 · freesound.org/s/${s.id}</p>`).join("");
      const mine = state.library.filter(r => r.source === "freesound").map(r => `<p class="credit"><b>${esc(r.name)}</b> — ${esc(r.author)} · CC0 · freesound.org/s/${String(r.key).replace("fs_", "")}</p>`).join("");
      box.innerHTML = `<p class="hint">全部为 Creative Commons 0，可自由使用；仍列出作者以示感谢。</p>${rows}${mine ? `<div class="grp-t" style="margin-top:14px">你下载的</div>${mine}` : ""}`;
    });
  }
  function bind() { on("view", v => { if (v === "settings") render(); }); }
  return { render, bind };
})();
