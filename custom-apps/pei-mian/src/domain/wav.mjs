// Float32（单声道或 [L, R]）→ 16-bit PCM WAV（Uint8Array）。纯函数。
export function encodeWav(input, sampleRate) {
  const channels = input instanceof Float32Array ? [input] : input;
  const nch = channels.length;
  const frames = channels[0] ? channels[0].length : 0;
  const dataLen = frames * nch * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const str = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nch, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * nch * 2, true); view.setUint16(32, nch * 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < nch; c += 1, o += 2) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
    }
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function wavDataUrl(channels, sampleRate) {
  return "data:audio/wav;base64," + bytesToBase64(encodeWav(channels, sampleRate));
}
