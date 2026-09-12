// ── 音频引擎：解码 → 混音（domain/mixer）→ WAV → media.put → 宿主 ambience 通道循环播放 ──
// 宿主环境音只有一条通道且播放中改不了音量，所以每次改层/改音量都重新合成一段再切。
const engine = (() => {
  const decoded = new Map();          // key → Float32Array(mono @ MIX_SAMPLE_RATE)
  let decodeCtx = null;
  let currentRef = null;              // 正在播的循环体 media ref
  let playing = false;
  let renderSeq = 0;
  let renderedSig = "";
  let lastLoop = null;                // 上一次合成的 Float32Array，渐弱尾巴用

  function ctx() {
    if (!decodeCtx) {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      decodeCtx = new AC(1, 1, 44100);
    }
    return decodeCtx;
  }
  async function fetchBytes(source) {
    if (source.startsWith("media-store://")) {
      const media = await api.media.get({ ref: source });
      return (await fetch(media.dataUrl)).arrayBuffer();
    }
    return (await fetch(source)).arrayBuffer();
  }
  function sourceFor(sound) {
    if (sound.user) return sound.mediaRef;
    return api.app.getAssetUrl(`assets/sounds/${sound.key}.mp3`);
  }
  async function decode(sound) {
    if (decoded.has(sound.key)) return decoded.get(sound.key);
    const src = await sourceFor(sound);
    if (!src) throw new Error(`找不到声音文件：${sound.name}`);
    const bytes = await fetchBytes(src);
    const buffer = await new Promise((resolve, reject) => {
      const p = ctx().decodeAudioData(bytes.slice(0), resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    const mono = PmMixer.resample(PmMixer.toMono(channels), buffer.sampleRate, PmMixer.MIX_SAMPLE_RATE);
    decoded.set(sound.key, mono);
    return mono;
  }
  function signature(mix) {
    return JSON.stringify({ l: (mix.layers || []).map(l => [l.key, Math.round(l.volume * 100), !!l.drift]), m: Math.round((mix.master ?? .7) * 100) });
  }
  async function render(mix, { loopSeconds = 90 } = {}) {
    const layers = [];
    for (const layer of mix.layers || []) {
      const sound = findSound(layer.key); if (!sound) continue;
      const samples = await decode(sound.user ? { ...sound, user: true, mediaRef: sound.mediaRef } : sound);
      layers.push({ samples, volume: layer.volume, drift: layer.drift ?? sound.drift, seed: hashKey(layer.key) });
    }
    const { samples } = PmMixer.mixLayers(layers, { loopSeconds, master: mix.master ?? .7 });
    return samples;
  }
  async function putWav(samples) {
    const dataUrl = PmWav.wavDataUrl(samples, PmMixer.MIX_SAMPLE_RATE);
    const stored = await api.media.put({ dataUrl });
    return stored.ref;
  }
  async function swapRef(ref) {
    const old = currentRef; currentRef = ref;
    if (old && old !== ref) { try { await api.media.delete({ ref: old }); } catch { /* ignore */ } }
  }
  // 播放（或切换）当前声景。空层 → 停。
  async function play(mix) {
    const seq = ++renderSeq;
    if (!mix.layers || !mix.layers.length) { await stop(); return; }
    const sig = signature(mix);
    if (playing && sig === renderedSig && currentRef) return;
    emit("engine", { busy: true });
    try {
      const samples = await render(mix);
      if (seq !== renderSeq) return;
      lastLoop = samples;
      const ref = await putWav(samples);
      if (seq !== renderSeq) { try { await api.media.delete({ ref }); } catch { /* ignore */ } return; }
      await api.voice.play({ channel: "ambience", dataUrl: ref, loop: true, volume: 1 });
      playing = true; renderedSig = sig; emit("engine", { busy: false, playing: true });
      await swapRef(ref);
    } finally { if (seq === renderSeq) emit("engine", { busy: false }); }
  }
  async function stop() {
    renderSeq += 1; const was = playing; playing = false; renderedSig = "";
    if (was) emit("engine", { busy: false, playing: false });
    try { await api.voice.stopPlayback({ channel: "ambience" }); } catch { /* ignore */ }
    if (currentRef) { const ref = currentRef; currentRef = null; try { await api.media.delete({ ref }); } catch { /* ignore */ } }
  }
  // 渐弱：把循环体做成一段递减的尾巴，非循环播放；播完 resolve，声音自然结束。
  async function fadeOut(seconds) {
    if (!playing || !lastLoop) { await stop(); return; }
    const tail = PmMixer.fadeTail(lastLoop, seconds);
    const ref = await putWav(tail);
    playing = false; renderedSig = "";
    try { await api.voice.play({ channel: "ambience", dataUrl: ref, loop: false, volume: 1 }); }
    finally { try { await api.media.delete({ ref }); } catch { /* ignore */ } await stop(); }
  }
  // 单个声音试听 10 秒
  async function preview(sound) {
    const samples = await decode(sound);
    const clip = samples.subarray(0, Math.min(samples.length, PmMixer.MIX_SAMPLE_RATE * 10));
    const out = new Float32Array(clip.length);
    const rms = PmMixer.rmsOf(clip) || 1; const g = Math.min(4, .12 / rms);
    for (let i = 0; i < clip.length; i += 1) out[i] = Math.tanh(clip[i] * g * 2);
    await api.voice.play({ channel: "ambience", dataUrl: PmWav.wavDataUrl(out, PmMixer.MIX_SAMPLE_RATE), loop: false, volume: 1 });
  }
  function hashKey(s) { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  return { decode, play, stop, fadeOut, preview, isPlaying: () => playing, forget: key => decoded.delete(key) };
})();
