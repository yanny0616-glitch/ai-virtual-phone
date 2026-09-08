// Pure edit planning. No browser, storage, clock or model access.
import type { Character } from './character-types';
import type { DIYWidgetTemplate, WidgetInstance, WidgetSize } from './widget-types';
import { WIDGET_CATALOG, WIDGET_SIZE_CELLS, GRID_ROWS, GRID_COLS } from './widget-types';
import type { DesktopIconLayout, DesktopFolderMap } from './desktop-layout-storage';
import type { DesktopIconId } from './desktop-config';
import type { ThemeProfile } from './theme-types';

export type EditState = {
  characters: Character[];
  templates: DIYWidgetTemplate[];
  desktop: { layout: DesktopIconLayout; dock: DesktopIconId[]; folders: DesktopFolderMap; widgets: WidgetInstance[] };
  appearance: ThemeProfile;
};
export type EditScope = 'characters' | 'character' | 'desktop' | 'appearance';
export type EditRead = { scope: EditScope; id?: string; revision: string };
export type EditOperation = Record<string, unknown> & { action: string };
export type EditDelta = { scope: 'character' | 'template' | 'desktop' | 'appearance'; id?: string; before: unknown; after: unknown };
export type EditPlan = { id: string; title: string; createdAt: string; status: 'draft' | 'applied' | 'undone'; reads: EditRead[]; deltas: EditDelta[]; appliedAt?: string; undoneAt?: string };
export const cloneEdit = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export function stableEdit(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableEdit).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableEdit((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function editRevision(value: unknown): string {
  const text = stableEdit(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `v1-${text.length}-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
export function editScopeValue(state: EditState, scope: EditScope, id?: string): unknown {
  if (scope === 'characters') return state.characters;
  if (scope === 'character') return state.characters.find(c => c.id === id) ?? null;
  if (scope === 'desktop') return { ...state.desktop, templates: state.templates };
  if (scope === 'appearance') return state.appearance;
  throw Error('未知读取范围');
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { if (value.length > 3_000_000) throw Error('JSON 参数过长'); try { value = JSON.parse(value); } catch { throw Error('需要合法 JSON 对象'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('需要对象参数');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw Error('不支持的字段名');
  return result;
}
function text(value: unknown, label: string, max = 300_000): string {
  if (typeof value !== 'string' || value.length > max) throw Error(`${label}需要字符串，最多 ${max} 字符`);
  return value;
}
function requiredText(value: unknown, label: string, max = 200): string {
  const result = text(value, label, max).trim(); if (!result) throw Error(`${label}不能为空`); return result;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw Error(`${label}需要 ${min}–${max} 的整数`);
  return value;
}
function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw Error('tags 需要最多 100 项的数组');
  return [...new Set(value.map(v => requiredText(v, '标签', 80)))];
}
function checkKeys(patch: Record<string, unknown>, fields: string[]) {
  for (const key of Object.keys(patch)) if (!fields.includes(key)) throw Error(`不支持修改字段：${key}`);
}
function size(value: unknown): WidgetSize {
  if (typeof value !== 'string' || !own(WIDGET_SIZE_CELLS, value)) throw Error('组件尺寸不合法');
  return value as WidgetSize;
}
function find<T extends { id: string }>(rows: T[], id: unknown, label: string): T {
  const row = rows.find(r => r.id === id); if (!row) throw Error(`找不到${label}：${String(id)}`); return row;
}
function patchCharacter(c: Character, raw: unknown, now: string) {
  const patch = object(raw);
  checkKeys(patch, ['name', 'persona', 'personality', 'briefPersona', 'tags', 'addTags', 'removeTags', 'avatar', 'timeZone', 'wechatID', 'embeddedWorldBook']);
  for (const key of ['name', 'persona', 'personality', 'briefPersona', 'wechatID'] as const) {
    if (own(patch, key)) c[key] = key === 'name' ? requiredText(patch[key], key) : text(patch[key], key);
  }
  if (own(patch, 'briefPersona')) c.briefPersonaUpdatedAt = now;
  if (own(patch, 'tags')) c.tags = tags(patch.tags);
  if (own(patch, 'addTags')) c.tags = [...new Set([...(c.tags ?? []), ...tags(patch.addTags)])];
  if (own(patch, 'removeTags')) { const remove = tags(patch.removeTags); c.tags = (c.tags ?? []).filter(t => !remove.includes(t)); }
  if (own(patch, 'timeZone')) {
    const zone = text(patch.timeZone, 'timeZone', 100).trim();
    if (zone) { try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw Error('时区不合法'); } }
    c.timeZone = zone || undefined;
  }
  if (own(patch, 'avatar')) {
    const avatar = patch.avatar;
    if (avatar !== null && (typeof avatar !== 'string' || !/^(https?:\/\/|data:image\/)/i.test(avatar) || avatar.length > 2_000_000)) throw Error('头像需要图片 data URL、HTTP(S) URL 或 null');
    c.avatar = avatar as string | null;
  }
  if (own(patch, 'embeddedWorldBook')) {
    if (patch.embeddedWorldBook === null) delete c.embeddedWorldBook;
    else {
      const book = object(patch.embeddedWorldBook);
      requiredText(book.name, '世界书名称');
      if (!Array.isArray(book.entries) || book.entries.length > 1000) throw Error('世界书 entries 需要数组，最多 1000 项');
      const ids = new Set<string>();
      for (const rawEntry of book.entries) {
        const e = object(rawEntry); const uid = requiredText(e.uid, '词条 uid');
        if (ids.has(uid)) throw Error('世界书 uid 重复'); ids.add(uid);
        text(e.content, '词条 content');
        text(e.key, '词条 key');
        for (const key of ['disable', 'constant', 'use_regex']) if (typeof e[key] !== 'boolean') throw Error(`词条 ${key} 需要布尔值`);
        text(e.comment, '词条 comment');
        if (!(typeof e.position === 'number' || ['before_char', 'after_char', 'before_em', 'after_em', 'before_an', 'after_an'].includes(String(e.position)))) throw Error('词条 position 不合法');
        integer(e.insertion_order, 0, Number.MAX_SAFE_INTEGER, '词条 insertion_order');
      }
      text(book.description, '世界书 description');
      c.embeddedWorldBook = cloneEdit(book) as Character['embeddedWorldBook'];
    }
  }
  c.updatedAt = now;
}
function checkTemplate(t: DIYWidgetTemplate) {
  requiredText(t.name, '组件名称'); size(t.size);
  if (t.mode === 'code') { if (!text(t.htmlString, 'htmlString').trim()) throw Error('HTML 不能为空'); }
  else if (t.mode === 'image') { requiredText(t.bgAssetId, '图片素材 ID'); }
  else throw Error('组件模式不合法');
  if (t.slots !== undefined) {
    if (!Array.isArray(t.slots)) throw Error('slots 需要数组');
    for (const slot of t.slots) { requiredText(slot.id, '插槽 ID'); for (const key of ['top', 'bottom', 'left', 'right'] as const) if (typeof slot[key] !== 'number' || !Number.isFinite(slot[key]) || slot[key] < 0 || slot[key] > 100) throw Error('插槽边距需要 0–100 的数字'); }
  }
}
function applyTemplatePatch(template: DIYWidgetTemplate, raw: unknown) {
  const patch = object(raw);
  checkKeys(patch, ['name', 'size', 'htmlString', 'htmlEdits', 'bgAssetId', 'slots']);
  if (patch.htmlEdits !== undefined) {
    if (patch.htmlString !== undefined) throw Error('htmlString 与 htmlEdits 只能使用一个');
    if (!Array.isArray(patch.htmlEdits) || patch.htmlEdits.length > 50) throw Error('htmlEdits 需要最多 50 项的数组');
    let html = template.htmlString ?? '';
    for (const rawEdit of patch.htmlEdits) {
      const edit = object(rawEdit); const findText = text(edit.find, '查找原文'), replacement = text(edit.replace, '替换文字');
      if (!findText) throw Error('查找原文不能为空');
      const index = html.indexOf(findText);
      if (index < 0 || html.indexOf(findText, index + 1) >= 0) throw Error('原文必须恰好匹配一次，请读取更完整的定位片段');
      html = html.slice(0, index) + replacement + html.slice(index + findText.length);
    }
    template.htmlString = html;
  }
  for (const [key, value] of Object.entries(patch)) if (key !== 'htmlEdits') Object.assign(template, { [key]: cloneEdit(value) });
  checkTemplate(template);
}
export function validateEditDesktop(state: EditState, knownIcons: string[]): void {
  const { layout, dock, folders, widgets } = state.desktop;
  if (dock.length > 4) throw Error('Dock 最多 4 个图标');
  const seen = new Set<string>(); const cells = new Set<string>();
  const claimIcon = (id: string, allowFolder = false) => {
    if (!knownIcons.includes(id) && !(allowFolder && own(folders, id))) throw Error(`未知图标：${id}`);
    if (seen.has(id)) throw Error(`图标重复：${id}`); seen.add(id);
  };
  const claim = (page: number, row: number, col: number, label: string) => {
    integer(page, 1, 50, '页码'); integer(row, 1, GRID_ROWS, '行'); integer(col, 1, GRID_COLS, '列');
    const cell = `${page}:${row}:${col}`; if (cells.has(cell)) throw Error(`${label}在第 ${page} 页 ${row}行${col}列发生重叠`); cells.add(cell);
  };
  for (const id of dock) claimIcon(id);
  for (const [id, folder] of Object.entries(folders)) {
    if (!id.startsWith('folder:')) throw Error('文件夹 ID 必须以 folder: 开头');
    requiredText(folder.name, '文件夹名称', 24);
    if (folder.icons.length < 2) throw Error(`文件夹「${folder.name}」至少保留两个图标；解散时请把成员移到桌面或 Dock`);
    for (const member of folder.icons) claimIcon(member);
  }
  for (const [key, icons] of Object.entries(layout)) {
    if (!/^page[1-9]\d*$/.test(key)) throw Error('页码键不合法');
    for (const icon of icons) { claimIcon(icon.id, true); claim(Number(key.slice(4)), icon.row, icon.col, icon.id); }
  }
  for (const id of Object.keys(folders)) if (!seen.has(id)) throw Error(`文件夹没有桌面位置：${id}`);
  const widgetIds = new Set<string>();
  for (const w of widgets) {
    if (widgetIds.has(w.id)) throw Error('组件实例 ID 重复'); widgetIds.add(w.id);
    const template = state.templates.find(t => t.id === w.type);
    if (template && template.size !== w.size) throw Error(`组件尺寸与模板不一致：${w.id}`);
    if (!template && !WIDGET_CATALOG.some(t => t.type === w.type)) throw Error(`找不到组件类型：${w.type}`);
    const [rows, cols] = WIDGET_SIZE_CELLS[size(w.size)];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) claim(w.page, w.row + r, w.col + c, w.id);
  }
}
function allIconIds(state: EditState): string[] {
  return [...state.desktop.dock, ...Object.values(state.desktop.layout).flatMap(rows => rows.map(r => r.id)), ...Object.values(state.desktop.folders).flatMap(f => f.icons)].filter(id => !id.startsWith('folder:')).sort();
}
function applyOperation(state: EditState, op: EditOperation, env: { now: string; uid: () => string; knownIcons: string[] }) {
  const { now, uid } = env;
  switch (op.action) {
    case 'character.update': patchCharacter(find(state.characters, op.id, '角色'), op.patch, now); break;
    case 'character.create': {
      const c: Character = { id: `char_${uid()}`, name: '', persona: '', avatar: null, wechatID: `139${uid().replace(/\D/g, '').slice(-8).padStart(8, '0')}`, createdAt: now, updatedAt: now };
      patchCharacter(c, op.patch, now); requiredText(c.name, '角色名'); state.characters.push(c); break;
    }
    case 'template.create': {
      const p = object(op.patch); checkKeys(p, ['name', 'size', 'mode', 'htmlString', 'bgAssetId', 'slots']);
      const t = { ...cloneEdit(p), id: `diy-${uid()}`, mode: p.mode || 'code' } as DIYWidgetTemplate; checkTemplate(t); state.templates.push(t);
      if (op.place) applyOperation(state, { action: 'widget.place', type: t.id, ...object(op.place) }, env);
      break;
    }
    case 'template.update': {
      const t = find(state.templates, op.id, '模板'); const p = object(op.patch);
      applyTemplatePatch(t, p);
      for (const w of state.desktop.widgets) if (w.type === t.id) w.size = t.size;
      break;
    }
    case 'widget.update': {
      const w = find(state.desktop.widgets, op.id, '组件实例');
      if (op.patch) {
        const p = object(op.patch); checkKeys(p, ['page', 'row', 'col', 'config', 'type']);
        if (p.config) { const config = object(p.config); w.config = { ...w.config, ...cloneEdit(config) }; }
        for (const key of ['page', 'row', 'col'] as const) if (own(p, key)) w[key] = integer(p[key], 1, key === 'page' ? 50 : key === 'row' ? GRID_ROWS : GRID_COLS, key);
        if (own(p, 'type')) {
          const t = find(state.templates, p.type, 'DIY 模板'); w.type = t.id; w.size = t.size;
        }
      }
      if (op.templatePatch) {
        const original = find(state.templates, w.type, 'DIY 模板');
        const copy = { ...cloneEdit(original), id: `diy-${uid()}` };
        applyTemplatePatch(copy, op.templatePatch); state.templates.push(copy); w.type = copy.id; w.size = copy.size;
      }
      break;
    }
    case 'widget.place': {
      const type = requiredText(op.type, '组件类型');
      const template = state.templates.find(t => t.id === type); const built = WIDGET_CATALOG.find(t => t.type === type);
      if (!template && !built) throw Error('找不到组件类型');
      const w: WidgetInstance = { id: `widget-${uid()}`, type, size: (template ?? built)!.size, page: op.page === undefined ? 1 : integer(op.page, 1, 50, '页码'), row: 1, col: 1 };
      if (op.row !== undefined || op.col !== undefined) { w.row = integer(op.row, 1, GRID_ROWS, '行'); w.col = integer(op.col, 1, GRID_COLS, '列'); state.desktop.widgets.push(w); }
      else {
        let placed = false;
        for (let r = 1; r <= GRID_ROWS && !placed; r++) for (let c = 1; c <= GRID_COLS && !placed; c++) {
          w.row = r; w.col = c; state.desktop.widgets.push(w);
          try { validateEditDesktop(state, env.knownIcons); placed = true; } catch { state.desktop.widgets.pop(); }
        }
        if (!placed) throw Error('本页没有空位；请调整布局或换页');
      }
      break;
    }
    case 'widget.remove': {
      find(state.desktop.widgets, op.id, '组件实例'); state.desktop.widgets = state.desktop.widgets.filter(w => w.id !== op.id); break;
    }
    case 'template.remove': {
      find(state.templates, op.id, 'DIY 模板'); state.templates = state.templates.filter(t => t.id !== op.id); state.desktop.widgets = state.desktop.widgets.filter(w => w.type !== op.id); break;
    }
    case 'desktop.arrange': {
      // A single final layout allows swaps without transient collisions. Never drop an app icon.
      const before = allIconIds(state); const p = object(op.patch); checkKeys(p, ['layout', 'dock', 'folders', 'placements']);
      if (p.layout) state.desktop.layout = cloneEdit(object(p.layout)) as DesktopIconLayout;
      if (p.dock) { if (!Array.isArray(p.dock)) throw Error('dock 需要数组'); state.desktop.dock = cloneEdit(p.dock) as DesktopIconId[]; }
      if (p.folders) state.desktop.folders = cloneEdit(object(p.folders)) as DesktopFolderMap;
      if (p.placements) {
        if (!Array.isArray(p.placements)) throw Error('placements 需要数组');
        for (const entry of p.placements) { const item = object(entry); applyOperation(state, { action: 'widget.update', id: item.id, patch: { page: item.page, row: item.row, col: item.col } }, env); }
      }
      if (stableEdit(before) !== stableEdit(allIconIds(state))) throw Error('整理布局必须保留所有原有图标；移出文件夹/Dock 的图标请安排新位置');
      break;
    }
    case 'appearance.update': {
      const p = object(op.patch);
      checkKeys(p, ['name', 'wallpaperAssetId', 'wallpaperBlur', 'wallpaperOpacity', 'wallpaperScale', 'wallpaperX', 'wallpaperY', 'iconSkins', 'dockSkinAssetId', 'fontAssetId', 'fontFamily', 'hideTopBar', 'cssOverrides', 'globalCustomCSS', 'enableGlobalShadows', 'enableGlobalBorder', 'globalBorderColor']);
      for (const [key, value] of Object.entries(p)) {
        if (['iconSkins', 'cssOverrides'].includes(key)) { const map = object(value); if (Object.values(map).some(v => typeof v !== 'string')) throw Error(`${key} 需要字符串值`); Object.assign(state.appearance[key as 'iconSkins' | 'cssOverrides'], cloneEdit(map)); }
        else if (['hideTopBar', 'enableGlobalShadows', 'enableGlobalBorder'].includes(key)) { if (typeof value !== 'boolean') throw Error(`${key}需要布尔值`); Object.assign(state.appearance, { [key]: value }); }
        else if (['wallpaperBlur', 'wallpaperOpacity', 'wallpaperScale', 'wallpaperX', 'wallpaperY'].includes(key)) { if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${key}需要有限数字`); Object.assign(state.appearance, { [key]: value }); }
        else { if (value !== null) text(value, key); Object.assign(state.appearance, { [key]: value }); }
      }
      // Keep the selected icon scheme consistent with its live skin mapping.
      const scheme = state.appearance.iconSchemes.find(s => s.id === state.appearance.activeIconSchemeId);
      if (scheme && p.iconSkins) { scheme.iconSkins = cloneEdit(state.appearance.iconSkins); scheme.updatedAt = now; }
      state.appearance.updatedAt = now; break;
    }
    default: throw Error(`未知编辑动作：${op.action}`);
  }
}
export function requiredEditScope(op: EditOperation): { scope: EditScope; id?: string } {
  if (op.action === 'character.update') return { scope: 'character', id: String(op.id || '') };
  if (op.action === 'character.create') return { scope: 'characters' };
  if (op.action === 'appearance.update') return { scope: 'appearance' };
  return { scope: 'desktop' };
}
export function planEdits(state: EditState, operations: EditOperation[], reads: EditRead[], env: { now: string; uid: () => string; knownIcons: string[] }, title: string): EditPlan {
  if (!operations.length || operations.length > 50) throw Error('每个方案需要 1–50 个动作');
  for (const op of operations) {
    const needed = requiredEditScope(op);
    const read = reads.find(r => r.scope === needed.scope && r.id === needed.id);
    if (!read || read.revision !== editRevision(editScopeValue(state, read.scope, read.id))) throw Error(`请先重新读取 ${needed.scope}${needed.id ? ':' + needed.id : ''}，内容未读取或已变化`);
  }
  const next = cloneEdit(state);
  for (const op of operations) applyOperation(next, op, env);
  if (stableEdit(state.desktop) !== stableEdit(next.desktop)) validateEditDesktop(next, env.knownIcons);
  const deltas: EditDelta[] = [];
  for (const [scope, oldRows, newRows] of [['character', state.characters, next.characters], ['template', state.templates, next.templates]] as const) {
    for (const id of new Set([...oldRows, ...newRows].map(r => r.id))) {
      const before = oldRows.find(r => r.id === id) ?? null, after = newRows.find(r => r.id === id) ?? null;
      if (stableEdit(before) !== stableEdit(after)) deltas.push({ scope, id, before, after });
    }
  }
  for (const scope of ['desktop', 'appearance'] as const) if (stableEdit(state[scope]) !== stableEdit(next[scope])) deltas.push({ scope, before: state[scope], after: next[scope] });
  if (!deltas.length) throw Error('没有实际变化');
  return cloneEdit({ id: `edit-${env.uid()}`, title: title.trim().slice(0, 100) || '小卷修改', createdAt: env.now, status: 'draft', reads, deltas });
}
export function applyEditDeltas(state: EditState, deltas: EditDelta[], undo = false): EditState {
  const next = cloneEdit(state);
  // Validate every target before applying anything. Other characters/templates survive unchanged.
  for (const d of deltas) {
    const rows = d.scope === 'character' ? next.characters : next.templates;
    const current = d.scope === 'character' || d.scope === 'template' ? rows.find(r => r.id === d.id) ?? null : next[d.scope];
    if (stableEdit(current) !== stableEdit(undo ? d.after : d.before)) throw Error(`「${d.id || d.scope}」在此方案之后已被修改，请重新读取；不会覆盖后续修改`);
  }
  for (const d of deltas) {
    const value = cloneEdit(undo ? d.before : d.after);
    if (d.scope === 'character' || d.scope === 'template') {
      const key = d.scope === 'character' ? 'characters' : 'templates';
      const rows = next[key] as Array<Character | DIYWidgetTemplate>;
      const index = rows.findIndex(r => r.id === d.id);
      if (value === null) { if (index >= 0) rows.splice(index, 1); }
      else if (index >= 0) rows[index] = value as Character | DIYWidgetTemplate;
      else rows.push(value as Character | DIYWidgetTemplate);
    } else Object.assign(next, { [d.scope]: value });
  }
  return next;
}
