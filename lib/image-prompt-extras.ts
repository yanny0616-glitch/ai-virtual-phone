// 生图的附加提示词：角色出镜时的长相、画风预设、照片描述里「此刻 / 画面」的拆合。
// 长相从人设提取后按人设指纹缓存，人设一改下次出镜就重新提取；此刻的样子由聊天模型写在照片描述里，不缓存。

import { simpleLLMCall } from "./api-helpers";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { kvGet, kvSet } from "./kv-db";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";

export type LookStyle = "tag" | "natural";
type LookEntry = { text: string; style: LookStyle; hash: string; at: number };

const LOOK_KEY = "image-character-looks";
const STYLE_PRESET_KEY = "image-style-presets";

function readJson<T>(key: string, fallback: T): T {
    try {
        const parsed = JSON.parse(kvGet(key) || "null");
        return parsed && typeof parsed === "object" ? parsed as T : fallback;
    } catch {
        return fallback;
    }
}

function personaHash(character: Character): string {
    const source = `${character.persona || ""}\n${character.personality || ""}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${(hash >>> 0).toString(36)}:${source.length}`;
}

function findCharacter(characterId: string): Character | undefined {
    return loadCharacters().find(character => character.id === characterId);
}

function writeLook(characterId: string, entry: LookEntry): void {
    const all = readJson<Record<string, LookEntry>>(LOOK_KEY, {});
    kvSet(LOOK_KEY, JSON.stringify({ ...all, [characterId]: entry }));
}

/** 缓存里的长相；fresh = 人设和写法都没变，可以直接用 */
export function peekCharacterLook(characterId: string, style: LookStyle): { text: string; fresh: boolean } {
    const cached = readJson<Record<string, LookEntry>>(LOOK_KEY, {})[characterId];
    const character = findCharacter(characterId);
    if (!cached || !character) return { text: cached?.text || "", fresh: false };
    return { text: cached.text, fresh: cached.style === style && cached.hash === personaHash(character) };
}

/** 手改的长相按当前人设指纹存：人设不动就一直用这份，人设改了再重新提取 */
export function saveCharacterLook(characterId: string, text: string, style: LookStyle): void {
    const character = findCharacter(characterId);
    if (!character) return;
    writeLook(characterId, { text: text.trim().slice(0, 300), style, hash: personaHash(character), at: Date.now() });
}

async function extractLook(character: Character, style: LookStyle, signal?: AbortSignal): Promise<string> {
    const slot = resolveBinding(loadBindingConfig(), character.id, "chat");
    const apiConfig = slot.apiConfigId ? loadApiConfigs().find(config => config.id === slot.apiConfigId) : undefined;
    if (!apiConfig) throw new Error("没有绑定聊天 API");
    const name = character.name?.trim() || "该角色";
    const format = style === "tag"
        ? "输出英文 Danbooru 风格 tag，用英文逗号分隔，不超过 25 个。例：1boy, black hair, long hair, low ponytail, drooping eyes, mole under eye, slim, tall"
        : "输出一行中文短句，60 字以内。例：黑色长发扎低马尾，眼尾微垂，左眼下一颗小痣，偏瘦高";
    const system = [
        `你是角色外观整理助手。从「${name}」的设定里，只提取别人一眼能看到、长期不变的外在长相：脸型五官、瞳色、肤色、发色和平常的发型、身高体型、年龄感、痣疤纹身等标志。`,
        "不写衣服、动作、表情、性格、身份和剧情。",
        format,
        "设定里没写长相就只输出「无」。只输出结果，不要解释。",
    ].join("\n");
    const persona = [character.persona?.trim(), character.personality?.trim() ? `【性格】${character.personality.trim()}` : ""].filter(Boolean).join("\n\n");
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "system", content: system }, { role: "user", content: persona || "（没有设定）" }],
        // 思考模型会先烧隐藏 token，上限给小了正文会是空的
        { temperature: 0.3, max_tokens: 4096, signal, label: "生图外观提取" },
    );
    if (result.error || result.content == null) throw new Error(result.error || "外观提取没有返回内容");
    const text = result.content.trim().replace(/^["'「『]+|["'」』]+$/g, "").trim();
    return /^无[。.]?$/.test(text) ? "" : text.slice(0, 300);
}

const inflight = new Map<string, Promise<string>>();

/** 出镜时用的长相：缓存新鲜就直接用，否则提取一次并缓存；提取失败退回旧缓存（可能为空），不挡生图 */
export async function resolveCharacterLook(characterId: string, style: LookStyle, signal?: AbortSignal): Promise<string> {
    const character = findCharacter(characterId);
    if (!character) return "";
    const hash = personaHash(character);
    const cached = readJson<Record<string, LookEntry>>(LOOK_KEY, {})[characterId];
    if (cached && cached.hash === hash && cached.style === style) return cached.text;
    const key = `${characterId}|${style}|${hash}`;
    const running = inflight.get(key);
    if (running) return running;
    const task = extractLook(character, style, signal)
        .then(text => {
            writeLook(characterId, { text, style, hash, at: Date.now() });
            return text;
        })
        .catch(() => cached?.text || "")
        .finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
}

/** 出镜照片的描述约定写成「此刻：…；画面：…」，没按约定写的整段都算画面 */
const LOOK_SCENE_RE = /^\s*此刻\s*[:：]\s*([\s\S]*?)\s*[；;]\s*画面\s*[:：]\s*([\s\S]*)$/;

export function splitPhotoDescription(description: string): { look: string; scene: string } {
    const match = LOOK_SCENE_RE.exec(description || "");
    return match ? { look: match[1].trim(), scene: match[2].trim() } : { look: "", scene: (description || "").trim() };
}

export function joinPhotoDescription(look: string, scene: string): string {
    const now = look.trim();
    const view = scene.trim();
    return now ? `此刻：${now}；画面：${view}` : view;
}

/** 长相放在最前；自然语言接口额外说明冲突时以此刻为准，tag 接口只能靠顺序 */
export function withAppearance(description: string, appearance: string, style: LookStyle): string {
    const look = appearance.trim();
    if (!look) return description;
    return style === "tag" ? `${look}, ${description}` : `人物长相：${look}（和后面「此刻」的样子冲突时以此刻为准）\n${description}`;
}

export type ImageStylePreset = { id: string; name: string; positive: string; negative: string };

export function loadImageStylePresets(): ImageStylePreset[] {
    const list = readJson<unknown[]>(STYLE_PRESET_KEY, []);
    return (Array.isArray(list) ? list : [])
        .filter((item): item is ImageStylePreset => Boolean(item) && typeof (item as ImageStylePreset).id === "string")
        .map(item => ({ id: item.id, name: String(item.name || "未命名"), positive: String(item.positive || ""), negative: String(item.negative || "") }));
}

export function saveImageStylePresets(list: ImageStylePreset[]): void {
    kvSet(STYLE_PRESET_KEY, JSON.stringify(list.slice(0, 30)));
}
