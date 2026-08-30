import type { Character, EmbeddedWorldBook } from "./character-types";
import type { WorldBookConfig, WorldBookEntry } from "./settings-types";
import {
  getCharacterBinding,
  loadBindingConfig,
  loadWorldBooks,
  saveBindingConfig,
  saveWorldBooks,
  setCharacterBinding,
} from "./settings-storage";

/** 角色卡是用户上传的文件，内嵌世界书的体积不可信，超限就不往角色库里塞。 */
const MAX_EMBEDDED_ENTRIES = 1000;
const MAX_EMBEDDED_JSON_CHARS = 2 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function keyList(entry: Record<string, unknown>): string {
  const raw = entry.keys ?? entry.key ?? entry.keywords;
  if (Array.isArray(raw)) return raw.map(item => String(item).trim()).filter(Boolean).join(",");
  return text(raw).trim();
}

/**
 * SillyTavern 的位置有两套写法：V2 规范里是 `position: "before_char" | "after_char"`，
 * 实际导出的卡把真实位置放在 `extensions.position` 的数字里（0/1 角色前后、2/3 作者注前后、
 * 4 按深度插入、5/6 示例对话前后）。数字优先，取不到再退回字符串。
 */
function resolvePosition(entry: Record<string, unknown>, ext: Record<string, unknown>): WorldBookEntry["position"] {
  const numeric = Number(ext.position ?? entry.position);
  if (Number.isFinite(numeric) && typeof (ext.position ?? entry.position) !== "string") {
    switch (numeric) {
      case 0: return "before_char";
      case 1: return "after_char";
      case 2: return "before_an";
      case 3: return "after_an";
      case 5: return "before_em";
      case 6: return "after_em";
      default: return numeric;
    }
  }
  const named = text(entry.position).trim();
  if (named === "before_char" || named === "after_char" || named === "before_em"
    || named === "after_em" || named === "before_an" || named === "after_an") {
    return named;
  }
  if (/^\d+$/.test(named)) return Number(named);
  return "before_char";
}

function convertEntry(raw: unknown, index: number): WorldBookEntry | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const content = text(entry.content);
  if (!content.trim()) return null;
  const ext = asRecord(entry.extensions) ?? {};

  // 关键词只留主键，selective / secondary_keys 这类多键逻辑本端不支持，直接丢弃。
  return {
    uid: String(entry.uid ?? entry.id ?? `cb-${index}`),
    key: keyList(entry),
    content,
    comment: text(entry.comment) || text(entry.name),
    use_regex: Boolean(ext.use_regex),
    disable: entry.enabled === false || Boolean(entry.disable) || Boolean(entry.disabled),
    constant: Boolean(entry.constant),
    position: resolvePosition(entry, ext),
    depth: Number(ext.depth ?? entry.depth) || 0,
    probability: Number(ext.probability ?? entry.probability) || 100,
    useProbability: Boolean(ext.useProbability ?? entry.useProbability),
    role: Number(ext.role ?? entry.role) || 0,
    insertion_order: Number(entry.insertion_order ?? entry.order ?? ext.display_index ?? index),
  };
}

/**
 * 从角色卡里认领内嵌世界书（SillyTavern 的 `character_book`）。
 * V2/V3 卡放在 `data.character_book`，老的扁平卡放在根上，两处都看。
 */
export function parseEmbeddedWorldBook(
  src: Record<string, unknown>,
  root: Record<string, unknown>,
  characterName: string
): EmbeddedWorldBook | null {
  const book = asRecord(src.character_book) ?? asRecord(root.character_book);
  if (!book) return null;

  const rawEntries = Array.isArray(book.entries)
    ? book.entries
    : asRecord(book.entries) ? Object.values(book.entries as Record<string, unknown>) : [];
  if (rawEntries.length === 0 || rawEntries.length > MAX_EMBEDDED_ENTRIES) return null;

  const entries = rawEntries
    .map((entry, index) => convertEntry(entry, index))
    .filter(Boolean) as WorldBookEntry[];
  if (entries.length === 0) return null;

  const embedded: EmbeddedWorldBook = {
    name: text(book.name).trim() || `${characterName} 的世界书`,
    description: text(book.description).trim() || undefined,
    entries,
  };
  if (JSON.stringify(embedded).length > MAX_EMBEDDED_JSON_CHARS) return null;
  return embedded;
}

/** 内嵌世界书导入后的固定 id：同一张角色卡重复导入只会覆盖同一条，不会越导越多。 */
export function characterWorldBookId(characterId: string): string {
  return `wb_char_${characterId}`;
}

export function isCharacterWorldBookImported(characterId: string): boolean {
  const id = characterWorldBookId(characterId);
  return loadWorldBooks().some(book => book.id === id);
}

/**
 * 把角色卡自带的世界书写进世界书库，并绑定到这个角色。
 * 只导入不绑定的话，用户还得再去设置里挂一次，等于没导。
 */
export function importCharacterWorldBook(char: Character): WorldBookConfig | null {
  const embedded = char.embeddedWorldBook;
  if (!embedded || embedded.entries.length === 0) return null;

  const id = characterWorldBookId(char.id);
  const now = Date.now();
  const books = loadWorldBooks();
  const existing = books.find(book => book.id === id);
  const config: WorldBookConfig = {
    id,
    name: embedded.name,
    description: embedded.description ?? `来自角色卡「${char.name}」`,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    entries: embedded.entries.map(entry => ({ ...entry })),
  };

  saveWorldBooks(existing
    ? books.map(book => (book.id === id ? config : book))
    : [config, ...books]);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
  }

  const bindingConfig = loadBindingConfig();
  const binding = getCharacterBinding(bindingConfig, char.id);
  const bound = binding.defaults.worldBookIds || [];
  if (!bound.includes(id)) {
    saveBindingConfig(setCharacterBinding(bindingConfig, {
      ...binding,
      defaults: { ...binding.defaults, worldBookIds: [...bound, id] },
    }));
  }

  return config;
}
