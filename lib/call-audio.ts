import { synthesizeChatSpeech } from "./tts-service";
import type { VoiceApiConfig } from "./settings-types";

const SAMPLE_RATE = 24_000;
const GAP_SECONDS = 0.35;

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
}

/** 逐句用角色现在的声音合成，拼成一段单声道 WAV；onProgress(已合成, 总数) */
export async function buildCallAudio(texts: string[], config: VoiceApiConfig, onProgress?: (done: number, total: number) => void): Promise<Blob | null> {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) throw new Error("这个浏览器不支持合成音频");
    let ctx: AudioContext;
    try { ctx = new AudioCtx({ sampleRate: SAMPLE_RATE }); } catch { ctx = new AudioCtx(); }
    const chunks: Float32Array[] = [];
    try {
        for (let i = 0; i < texts.length; i++) {
            const blob = await synthesizeChatSpeech(texts[i], config);
            onProgress?.(i + 1, texts.length);
            if (!blob) continue;
            const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
            const mono = new Float32Array(decoded.length);
            for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
                const data = decoded.getChannelData(ch);
                for (let j = 0; j < data.length; j++) mono[j] += data[j] / decoded.numberOfChannels;
            }
            chunks.push(mono, new Float32Array(Math.round(ctx.sampleRate * GAP_SECONDS)));
        }
    } finally {
        void ctx.close();
    }
    if (!chunks.length) return null;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return encodeWav(merged, ctx.sampleRate);
}
