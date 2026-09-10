// 角色可见范围：哪些标签 / 哪个角色不出现在各功能的角色列表里。
// 一份全局默认，各功能可单独覆盖；聊天与联系人永远不过滤。
// 自定义 APP 在 SDK 的 characters.list 处按 `custom_app:<manifest.id>` 统一过滤，APP 自身不用改。

import type { Character } from "./character-types";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet } from "./kv-db";

const STORAGE_KEY = "character-visibility";
export const CHARACTER_VISIBILITY_CHANGED_EVENT = "character-visibility-changed";

export type CharacterVisibilityRule = {
  hiddenTags: string[];
  hiddenIds: string[];
};

export type CharacterVisibilityConfig = {
  default: CharacterVisibilityRule;
  /** 功能 id → 规则；不在表里的功能继承 default */
  apps: Record<string, CharacterVisibilityRule>;
};

/** 宿主内置功能，设置页按这个顺序列出；自定义 APP 由已安装列表动态补充 */
export const CHARACTER_VISIBILITY_HOST_FEATURES: Array<{ id: string; label: string }> = [
  { id: "checkphone", label: "查手机" },
  { id: "dwelling", label: "栖所" },
];

export function customAppVisibilityId(manifestId: string): string {
  return `custom_app:${manifestId}`;
}

const EMPTY_RULE: CharacterVisibilityRule = { hiddenTags: [], hiddenIds: [] };

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function cleanRule(value: unknown): CharacterVisibilityRule {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { hiddenTags: cleanList(record.hiddenTags), hiddenIds: cleanList(record.hiddenIds) };
}

export function loadCharacterVisibility(): CharacterVisibilityConfig {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { default: { ...EMPTY_RULE }, apps: {} };
    const parsed = JSON.parse(raw) as Partial<CharacterVisibilityConfig>;
    const apps: Record<string, CharacterVisibilityRule> = {};
    for (const [id, rule] of Object.entries(parsed.apps ?? {})) apps[id] = cleanRule(rule);
    return { default: cleanRule(parsed.default), apps };
  } catch {
    return { default: { ...EMPTY_RULE }, apps: {} };
  }
}

export function saveCharacterVisibility(config: CharacterVisibilityConfig): void {
  kvSet(STORAGE_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHARACTER_VISIBILITY_CHANGED_EVENT));
}

export function resolveCharacterVisibilityRule(appId: string, config = loadCharacterVisibility()): CharacterVisibilityRule {
  return config.apps[appId] ?? config.default;
}

export function isCharacterVisibleIn(appId: string, character: Pick<Character, "id" | "tags">, config?: CharacterVisibilityConfig): boolean {
  const rule = resolveCharacterVisibilityRule(appId, config);
  if (rule.hiddenIds.includes(character.id)) return false;
  if (rule.hiddenTags.length === 0) return true;
  const tags = character.tags ?? [];
  return !tags.some(tag => rule.hiddenTags.includes(tag.trim()));
}

export function filterVisibleCharacters<T extends Pick<Character, "id" | "tags">>(appId: string, characters: T[]): T[] {
  const config = loadCharacterVisibility();
  return characters.filter(character => isCharacterVisibleIn(appId, character, config));
}

/** 各功能的角色选择器统一走这里；聊天类不用 */
export function loadVisibleCharacters(appId: string): Character[] {
  return filterVisibleCharacters(appId, loadCharacters());
}

/** 所有角色身上出现过的标签，给设置页当候选 */
export function collectCharacterTags(characters = loadCharacters()): string[] {
  const seen = new Set<string>();
  for (const character of characters) for (const tag of character.tags ?? []) {
    const text = tag.trim();
    if (text) seen.add(text);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}
