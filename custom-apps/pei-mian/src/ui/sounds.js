// ── 声景：瓷砖开关、层列表、组合、商店、导入 ──
const sounds = (() => {
  let cat = "rain";
  const mix = () => state.settings.currentMix;
  function layerOf(key) { return mix().layers.find(l => l.key === key); }
  async function toggle(key, tile) {
    const m = mix();
    if (layerOf(key)) m.layers = m.layers.filter(l => l.key !== key);
    else {
      if (m.layers.length >= PmMixer.MAX_LAYERS) { toast(`最多叠 ${PmMixer.MAX_LAYERS} 层`); return; }
      const sound = findSound(key);
      if (sound && !sound.user && !sound.ready) {
        if (tile) tile.classList.add("busy");
        const label = tile && tile.querySelector("span");
        try { await store.ensureBuiltin(sound, p => { if (label) label.textContent = `${Math.round(p * 100)}%`; }); }
        catch (e) { fail(e); renderTiles(); return; }
        if (tile) tile.classList.remove("busy");
      }
      m.layers.push({ key, volume: .6, drift: !!(sound && sound.drift) });
    }
    m.name = "";
    commit();
  }
  let commitTimer = 0;
  function commit() {
    saveSettings({ currentMix: mix() });
    renderLayers(); renderTiles(); renderPresets();
    if (session.active() || engine.isPlaying()) { clearTimeout(commitTimer); commitTimer = setTimeout(() => engine.play(mix()).catch(fail), 400); }
  }
  function renderLayers() {
    const box = $("layers"); box.innerHTML = "";
    const m = mix();
    $("mix-title").textContent = m.layers.length ? (m.name || `${m.layers.length} 层叠加`) : "安静";
    if (!m.layers.length) { box.appendChild(el("p", "empty", "下面点几个声音，它们会在这里变成一排推子")); return; }
    for (const layer of m.layers) {
      const s = findSound(layer.key); if (!s) continue;
      const f = el("div", "fader");
      f.innerHTML = `<button class="x" type="button" aria-label="移除">×</button><div class="track"><input type="range" min="0" max="100" value="${Math.round(layer.volume * 100)}"></div><div class="ico">${iconSvg(s.user ? s.icon : s.key)}</div><div class="nm">${esc(s.name)}</div><button class="drift${layer.drift ? " on" : ""}" type="button" title="音量慢慢起伏">起伏</button>`;
      f.querySelector(".drift").onclick = () => { layer.drift = !layer.drift; m.name = ""; commit(); };
      const range = f.querySelector("input");
      range.oninput = () => { layer.volume = Number(range.value) / 100; };
      range.onchange = () => { m.name = ""; commit(); };
      f.querySelector(".x").onclick = () => toggle(layer.key);
      box.appendChild(f);
    }
    const master = el("div", "fader master");
    master.innerHTML = `<span class="val" id="master-val">${Math.round((m.master ?? .7) * 100)}</span><div class="track"><input id="master" type="range" min="0" max="100" value="${Math.round((m.master ?? .7) * 100)}"></div><div class="ico">${iconSvg("headphones")}</div><div class="nm">总音量</div>`;
    const mr = master.querySelector("input");
    mr.oninput = () => { master.querySelector(".val").textContent = mr.value; };
    mr.onchange = () => { m.master = Number(mr.value) / 100; commit(); };
    box.appendChild(master);
  }
  function renderTiles() {
    const box = $("sound-tiles"); box.innerHTML = ""; box.classList.toggle("playing", engine.isPlaying());
    const list = allSounds().filter(s => s.cat === cat);
    if (!list.length) box.appendChild(el("p", "empty", cat === "mine" ? "还没有自己的声音。点「＋ 商店」搜，或者导入一段录音。" : ""));
    for (const s of list) {
      const t = el("button", "tile" + (layerOf(s.key) ? " on" : "") + (s.user ? " mine" : "") + (!s.user && !s.ready ? " dl" : ""));
      t.type = "button"; t.innerHTML = `${iconSvg(s.user ? s.icon : s.key)}<span>${esc(s.name)}</span>${!s.user && !s.ready ? `<i class="badge" title="第一次用会下载，约 ${esc(store.fmtMB(s.bytes || 0))}"></i>` : ""}`;
      t.onclick = () => { t.classList.add("pop"); toggle(s.key, t); };
      hold(t, () => longPress(s));
      box.appendChild(t);
    }
    document.querySelectorAll("#sound-cats button").forEach(b => b.classList.toggle("on", b.dataset.cat === cat));
  }
  function longPress(s) {
    const src = state.library.find(r => r.key === s.key) || null;
    const meta = SOUND_SOURCES[s.key];
    const rows = [];
    if (meta) {
      rows.push(["来源", `Freesound #${meta.id} · ${meta.author} · CC0`]);
      if (meta.orig) rows.push(["原文件", `${meta.orig.sr ? Math.round(meta.orig.sr / 100) / 10 + " kHz" : "?"} · ${meta.orig.bd ? meta.orig.bd + " bit" : "压缩格式"} · ${meta.orig.ch === 1 ? "单声道" : "立体声"} · ${meta.duration} 秒`]);
      rows.push(["本机", src ? `${store.QUALITY_LABEL[src.quality] || src.quality || "mp3"} · ${store.fmtMB(src.bytes || 0)} · 已下载` : `还没下载 · 高 ${store.fmtMB(meta.hqBytes || 0)} / 省流 ${store.fmtMB(meta.lqBytes || 0)}`]);
      rows.push(["原名", meta.name]);
      rows.push(["链接", meta.url]);
    } else if (src && src.source === "freesound") {
      rows.push(["来源", `Freesound · ${src.author || ""} · CC0`]);
      rows.push(["本机", `${store.QUALITY_LABEL[src.quality] || "mp3"} · ${store.fmtMB(src.bytes || 0)}${src.duration ? ` · ${src.duration} 秒` : ""}`]);
      if (src.url) rows.push(["链接", src.url]);
    } else if (src) {
      rows.push(["来源", "自己导入的录音"]);
    }
    openSheet(s.name, box => {
      box.innerHTML = `<div class="kv-table">${rows.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join("")}</div><div class="grp">
        ${src ? `<div class="frow"><div class="fl">名字</div><input id="sp-name" class="field" maxlength="24" value="${esc(s.name)}"><button class="mini" type="button" id="sp-rename">改</button></div>` : `<div class="frow"><div class="fl">名字</div><div class="fu">下载后长按可以改名</div></div>`}
        <div class="frow"><div class="fl">试听 10 秒</div><button class="mini" type="button" id="sp-prev">播放</button></div>${src ? `<div class="frow"><div class="fl">${s.user ? "从我的声音里删除" : "删掉下载的文件"}</div><button class="mini warn" type="button" id="sp-del">删除</button></div>` : ""}</div>`;
      const rn = box.querySelector("#sp-rename");
      if (rn) rn.onclick = async () => { const name = box.querySelector("#sp-name").value.trim().slice(0, 24); if (!name || name === s.name) { closeSheet(); return; } try { await api.db.update("library", src.id, { name }); src.name = name; closeSheet(); render(); toast("改好了"); } catch (e) { fail(e); } };
      box.querySelector("#sp-prev").onclick = async () => { try { toast(s.ready ? "试听中…" : "先下载再试听…", 1500); await engine.preview(s); } catch (e) { fail(e); } };
      const del = box.querySelector("#sp-del");
      if (del) del.onclick = async () => { try { await store.remove(src); mix().layers = mix().layers.filter(l => l.key !== s.key); closeSheet(); commit(); toast("删了"); } catch (e) { fail(e); } };
    });
  }
  function renderCats() {
    const box = $("sound-cats"); box.innerHTML = "";
    for (const c of SOUND_CATEGORIES) { const b = el("button", c.id === cat ? "on" : "", c.name); b.type = "button"; b.dataset.cat = c.id; b.onclick = () => { cat = c.id; renderTiles(); }; box.appendChild(b); }
  }
  // 组合：常用的钉在声景页，其它收进「全部」弹层
  function allPresets() { return state.mixes.map(x => ({ ...x, user: true })).concat(MIX_PRESETS); }
  function pinnedNames() { const v = state.settings.pinnedPresets; return Array.isArray(v) ? v : MIX_PRESETS.slice(0, 4).map(p => p.name); }
  function togglePin(name) { const cur = pinnedNames(); saveSettings({ pinnedPresets: cur.includes(name) ? cur.filter(n => n !== name) : cur.concat(name) }); renderPresets(); }
  function presetSummary(p) { return p.layers.map(l => `${findSound(l.key)?.name || l.key} ${Math.round(l.volume * 100)}`).join(" · "); }
  function hold(node, fn, ms = 550) {
    let t = 0;
    node.addEventListener("pointerdown", () => { t = setTimeout(() => { t = 0; fn(); }, ms); });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) node.addEventListener(ev, () => { if (t) clearTimeout(t); });
    node.addEventListener("contextmenu", e => e.preventDefault());
  }
  async function applyPreset(p) {
    const m = mix();
    const keys = p.layers.map(l => l.key).filter(k => findSound(k));
    try { await store.ensureAll(keys, (i, n, prog, snd) => toast(`下载 ${snd.name} ${Math.round(prog * 100)}% · ${i + 1}/${n}`, 1200)); } catch (e) { fail(e); return; }
    m.layers = p.layers.map(l => ({ key: l.key, volume: l.volume, drift: l.drift ?? !!findSound(l.key)?.drift })).filter(l => findSound(l.key)); m.name = p.name; if (p.master != null) m.master = p.master; commit();
  }
  function renderPresets() {
    const box = $("mix-presets"); box.innerHTML = "";
    const m = mix(); const pins = pinnedNames(); const all = allPresets();
    for (const p of all.filter(p => pins.includes(p.name))) {
      const b = el("button", m.name === p.name ? "on" : "", p.name); b.type = "button";
      b.onclick = () => applyPreset(p);
      hold(b, () => presetSheet(p));
      box.appendChild(b);
    }
    const more = el("button", "more", `全部 ${all.length} ›`); more.type = "button"; more.onclick = openPresetList; box.appendChild(more);
  }
  function openPresetList() {
    openSheet("组合", box => {
      box.innerHTML = `<p class="hint">点名字套用；★ 钉到声景页；长按看详情、改名、删除。</p><div class="pl" id="pl"></div>`;
      const list = box.querySelector("#pl"); const pins = pinnedNames(); const m = mix();
      for (const p of allPresets()) {
        const row = el("div", "pl-item" + (m.name === p.name ? " on" : ""));
        row.innerHTML = `<div class="pl-main"><div class="pl-name">${esc(p.name)}${p.user ? "" : '<small>内置</small>'}</div><div class="pl-sub">${esc(presetSummary(p))}</div></div><button class="pin${pins.includes(p.name) ? " on" : ""}" type="button" aria-label="钉住">★</button>`;
        row.querySelector(".pl-main").onclick = () => { closeSheet(); applyPreset(p); };
        row.querySelector(".pin").onclick = ev => { togglePin(p.name); ev.currentTarget.classList.toggle("on"); };
        hold(row.querySelector(".pl-main"), () => presetSheet(p));
        list.appendChild(row);
      }
    });
  }
  function presetSheet(p) {
    openSheet(p.name, box => {
      const pins = pinnedNames();
      box.innerHTML = `<div class="kv-table">${p.layers.map(l => `<b>${esc(findSound(l.key)?.name || l.key)}</b><span>音量 ${Math.round(l.volume * 100)}${(l.drift ?? !!findSound(l.key)?.drift) ? " · 起伏" : ""}${findSound(l.key) && !findSound(l.key).user && !findSound(l.key).ready ? " · 未下载" : ""}</span>`).join("")}<b>总音量</b><span>${Math.round((p.master ?? .7) * 100)}</span><b>来源</b><span>${p.user ? `自己存的${p.createdAt ? " · " + esc(String(p.createdAt).slice(0, 10)) : ""}` : "内置组合"}</span></div>
        <div class="grp">${p.user ? `<div class="frow"><div class="fl">名字</div><input id="ps-name" class="field" maxlength="16" value="${esc(p.name)}"><button class="mini" type="button" id="ps-rename">改</button></div>` : ""}
        <div class="frow"><div class="fl">钉在声景页</div><button class="mini" type="button" id="ps-pin">${pins.includes(p.name) ? "取下" : "钉住"}</button></div>
        <div class="frow"><div class="fl">套用这套</div><button class="mini" type="button" id="ps-apply">套用</button></div>
        ${p.user ? `<div class="frow"><div class="fl">删除</div><button class="mini warn" type="button" id="ps-del">删除</button></div>` : ""}</div>`;
      box.querySelector("#ps-pin").onclick = () => { togglePin(p.name); closeSheet(); };
      box.querySelector("#ps-apply").onclick = () => { closeSheet(); applyPreset(p); };
      const rn = box.querySelector("#ps-rename");
      if (rn) rn.onclick = async () => { const name = box.querySelector("#ps-name").value.trim().slice(0, 16); if (!name || name === p.name) { closeSheet(); return; } try { await api.db.update("mixes", p.id, { name }); const row = state.mixes.find(x => x.id === p.id); if (row) row.name = name; if (pinnedNames().includes(p.name)) saveSettings({ pinnedPresets: pinnedNames().map(n => n === p.name ? name : n) }); if (mix().name === p.name) mix().name = name; closeSheet(); renderPresets(); renderLayers(); toast("改好了"); } catch (e) { fail(e); } };
      const del = box.querySelector("#ps-del");
      if (del) del.onclick = async () => { if (!confirm(`删除组合「${p.name}」？`)) return; try { await api.db.delete("mixes", p.id); state.mixes = state.mixes.filter(x => x.id !== p.id); if (pinnedNames().includes(p.name)) saveSettings({ pinnedPresets: pinnedNames().filter(n => n !== p.name) }); closeSheet(); renderPresets(); } catch (e) { fail(e); } };
    });
  }
  function saveMix() {
    const m = mix();
    if (!m.layers.length) { toast("先叠几层"); return; }
    openSheet("存这个组合", box => {
      box.innerHTML = `<input id="mix-name" class="field" style="width:100%" placeholder="给它起个名字" value="${esc(m.name)}"><button class="big-btn" id="mix-ok" type="button">保存</button>`;
      box.querySelector("#mix-ok").onclick = async () => {
        const name = box.querySelector("#mix-name").value.trim(); if (!name) return;
        try {
          const existing = state.mixes.find(x => x.name === name);
          const data = { name, layers: m.layers.map(l => ({ ...l })), master: m.master ?? .7 };
          if (existing) { await api.db.update("mixes", existing.id, data); Object.assign(existing, data); }
          else { const row = await api.db.create("mixes", data); state.mixes.push(row); }
          m.name = name; closeSheet(); commit(); toast("存好了");
        } catch (e) { fail(e); }
      };
      setTimeout(() => box.querySelector("#mix-name").focus(), 50);
    });
  }
  function openStore() {
    openSheet("声音商店", box => {
      box.innerHTML = `<p class="hint">Freesound 上的 CC0 录音，搜到就能下。只列 ${store.MAX_SECONDS} 秒以内的。${state.settings.freesoundKey ? "" : "先在配置里填 API Key。"}</p>
        <div class="search"><input id="st-q" class="field" placeholder="rain / ocean / cafe / cat…"><button class="mini" id="st-go" type="button">搜</button></div>
        <div class="tgl-row" id="st-quick" style="margin-top:10px">${["rain", "ocean", "forest", "fireplace", "wind", "cafe", "train", "birds", "thunder", "snow"].map(q => `<button type="button" class="tgl">${q}</button>`).join("")}</div>
        <div class="list" id="st-list"></div>`;
      const list = box.querySelector("#st-list"); const input = box.querySelector("#st-q");
      async function go(q) {
        if (!q) return; input.value = q; list.innerHTML = `<p class="empty">搜索中…</p>`;
        try {
          const { results, count } = await store.search(q);
          list.innerHTML = results.length ? "" : `<p class="empty">没搜到</p>`;
          for (const r of results) {
            const owned = state.library.some(x => x.key === `fs_${r.id}`);
            const item = el("div", "list-item");
            item.innerHTML = `<div><p>${esc(r.name.replace(/\.[a-z0-9]+$/i, ""))}</p><small>${esc(r.username)} · ${Math.round(r.duration)}s · ★${(r.avg_rating || 0).toFixed(1)}</small></div><div class="acts"><button class="mini" type="button" data-a="p">听</button><button class="mini" type="button" data-a="d" ${owned ? "disabled" : ""}>${owned ? "已有" : "下载"}</button></div>`;
            item.querySelector('[data-a="p"]').onclick = async () => { try { toast("正在拉预览…", 1500); const row = await previewRemote(r); await engine.preview(row); } catch (e) { fail(e); } };
            item.querySelector('[data-a="d"]').onclick = async ev => {
              const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "下载中…";
              try { await store.download(r); btn.textContent = "已有"; toast("下好了，在「我的」里"); renderTiles(); }
              catch (e) { fail(e); btn.disabled = false; btn.textContent = "下载"; }
            };
            list.appendChild(item);
          }
          if (count > results.length) list.appendChild(el("p", "archive-note", `共 ${count} 条，只显示前 ${results.length} 条，换个词再搜`));
        } catch (e) { list.innerHTML = `<p class="empty">${esc(e.message || e)}</p>`; }
      }
      box.querySelector("#st-go").onclick = () => go(input.value.trim());
      input.onkeydown = e => { if (e.key === "Enter") go(input.value.trim()); };
      box.querySelectorAll("#st-quick button").forEach(b => { b.onclick = () => go(b.textContent); });
      setTimeout(() => input.focus(), 50);
    });
  }
  const previewCache = new Map();
  async function previewRemote(r) {
    if (previewCache.has(r.id)) return previewCache.get(r.id);
    const res = await api.network.fetch({ url: r.previews["preview-lq-mp3"], proxy: true, timeoutMs: 60000 });
    if (!res.ok || !res.binary) throw new Error("拉不到预览");
    const stored = await api.media.put({ dataUrl: `data:${res.contentType || "audio/mpeg"};base64,${res.data}` });
    const fake = { key: `tmp_${r.id}`, name: r.name, icon: "headphones", user: true, mediaRef: stored.ref };
    previewCache.set(r.id, fake);
    return fake;
  }
  function bind() {
    $("btn-mix-save").onclick = saveMix;
    $("btn-mix-preview").onclick = async () => {
      if (engine.isPlaying()) { await engine.stop(); $("btn-mix-preview").textContent = "试听"; return; }
      if (!mix().layers.length) { toast("先叠几层"); return; }
      $("btn-mix-preview").textContent = "合成中…";
      try { await engine.play(mix()); $("btn-mix-preview").textContent = "停"; } catch (e) { fail(e); $("btn-mix-preview").textContent = "试听"; }
    };
    $("btn-store").onclick = openStore;
    $("btn-import").onclick = async () => { try { const row = await store.importFile(); if (row) { toast("导入了"); cat = "mine"; renderTiles(); } } catch (e) { fail(e); } };
    on("engine", ({ busy }) => { if (!session.active()) $("btn-mix-preview").textContent = busy ? "合成中…" : (engine.isPlaying() ? "停" : "试听"); $("layers").classList.toggle("playing", engine.isPlaying()); $("layers").classList.toggle("busy", !!busy); });
    on("view", v => { if (v !== "sounds" && !session.active() && engine.isPlaying()) engine.stop(); if (v === "sounds") render(); });
    on("library", () => { if (state.view === "sounds") renderTiles(); });
    $("sounds-credit").textContent = "声音来自 Freesound · CC0 · 128k 立体声 · 带角标的第一次点会下载 · 长按试听或看来源";
  }
  function render() { renderCats(); renderTiles(); renderLayers(); renderPresets(); $("layers").classList.toggle("playing", engine.isPlaying()); }
  return { render, bind };
})();
