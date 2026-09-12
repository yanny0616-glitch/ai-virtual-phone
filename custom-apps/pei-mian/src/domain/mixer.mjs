// 多层声景混音：把若干已解码的声音叠成一段无缝立体声循环。纯函数，不碰 Web Audio。
// 每层：随机起点 + 首尾等功率交叉淡化 + 可选起伏(慢 LFO)。左右声道共用同一个起点，声像不会散。
// 输入的 samples 可以是 Float32Array（单声道）或 [L, R]；输出 { channels: [L, R], peak }。

export const MIX_SAMPLE_RATE = 44100;
export const MAX_LAYERS = 6;
export const LOOP_SECONDS = 48;

export function equalPowerFade(t) {
  const a = Math.cos(t * Math.PI / 2);
  const b = Math.sin(t * Math.PI / 2);
  return [a, b];
}

// 把一段样本做成长度 targetLen 的循环：起点由 seed 决定，拼接处交叉淡化 fadeLen。
export function loopSamples(src, targetLen, fadeLen, seed) {
  const out = new Float32Array(targetLen);
  const n = src.length;
  if (n === 0) return out;
  const rand = mulberry32(seed);
  const useFade = Math.min(fadeLen, Math.floor(n / 4));
  const period = Math.max(1, n - useFade);
  const start = Math.floor(rand() * n);
  for (let i = 0; i < targetLen; i += 1) {
    const pos = (start + i) % period;
    let v = src[pos];
    if (useFade > 0 && pos < useFade) {
      const [a, b] = equalPowerFade(pos / useFade);
      v = src[period + pos] * a + src[pos] * b;
    }
    out[i] = v;
  }
  return out;
}

export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  return peak;
}

export function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function asStereo(samples) {
  if (samples instanceof Float32Array) return [samples, samples];
  if (Array.isArray(samples)) return samples.length >= 2 ? [samples[0], samples[1]] : [samples[0], samples[0]];
  return [new Float32Array(0), new Float32Array(0)];
}

// layers: [{ samples: Float32Array | [L, R], volume: 0..1, drift: bool, seed }]
export function mixLayers(layers, { sampleRate = MIX_SAMPLE_RATE, loopSeconds = LOOP_SECONDS, master = 1 } = {}) {
  const len = Math.max(1, Math.floor(loopSeconds * sampleRate));
  const out = [new Float32Array(len), new Float32Array(len)];
  const fadeLen = Math.floor(sampleRate * 3);
  const targetRms = 0.08;
  layers.slice(0, MAX_LAYERS).forEach((layer, index) => {
    if (!layer || !layer.samples || !(layer.volume > 0)) return;
    const src = asStereo(layer.samples);
    if (!src[0].length) return;
    const seed = (layer.seed ?? 1) * 7919 + index;
    const looped = [loopSamples(src[0], len, fadeLen, seed), loopSamples(src[1], len, fadeLen, seed)];
    const rms = (rmsOf(looped[0]) + rmsOf(looped[1])) / 2 || 1;
    const gain = (targetRms / rms) * layer.volume;
    if (layer.drift) {
      const p1 = (17 + index * 3) * sampleRate, p2 = (41 + index * 5) * sampleRate;
      for (let i = 0; i < len; i += 1) {
        const lfo = 1 + 0.35 * (0.6 * Math.sin(2 * Math.PI * i / p1) + 0.4 * Math.sin(2 * Math.PI * i / p2 + index));
        out[0][i] += looped[0][i] * gain * lfo;
        out[1][i] += looped[1][i] * gain * lfo;
      }
    } else {
      for (let i = 0; i < len; i += 1) { out[0][i] += looped[0][i] * gain; out[1][i] += looped[1][i] * gain; }
    }
  });
  const m = Math.max(0, Math.min(1, master));
  for (const ch of out) for (let i = 0; i < len; i += 1) ch[i] = Math.tanh(ch[i] * m * 2.2);
  return { channels: out, peak: Math.max(peakOf(out[0]), peakOf(out[1])) };
}

// 结束前的渐弱尾巴：把循环体重复到 fadeSeconds 长，再整体乘以从 1 到 0 的曲线。
export function fadeTail(channels, fadeSeconds, sampleRate = MIX_SAMPLE_RATE) {
  const len = Math.max(1, Math.floor(fadeSeconds * sampleRate));
  return asStereo(channels).map(loop => {
    const out = new Float32Array(len);
    const n = loop.length || 1;
    for (let i = 0; i < len; i += 1) out[i] = loop[i % n] * Math.pow(1 - i / len, 1.6);
    return out;
  });
}

export function toMono(channels) {
  if (!channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let c = 0; c < channels.length; c += 1) { const ch = channels[c]; for (let i = 0; i < len; i += 1) out[i] += ch[i] / channels.length; }
  return out;
}

export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const len = Math.floor(samples.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}
