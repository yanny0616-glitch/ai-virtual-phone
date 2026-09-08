import { kvGet, kvCompareAndSetBatch, registerKvMigration } from './kv-db';
import { loadCharacters, invalidateCharacterCache } from './character-storage';
import { prepareCharacterVersionBackups } from './character-version-storage';
import { loadWidgets, loadDIYTemplates } from './widget-storage';
import { loadDockLayout, loadDesktopFolders, normalizeDesktopIconLayout, ICON_LAYOUT_STORAGE_KEY, DOCK_LAYOUT_STORAGE_KEY, DESKTOP_FOLDERS_STORAGE_KEY } from './desktop-layout-storage';
import { readThemeProfile, THEME_PROFILE_STORAGE_KEY, collectThemeAssetIds, getThemeAssetDataUrl } from './theme-storage';
import { normalizeThemeProfile } from './theme-types';
import { ICONS } from './desktop-config';
import { loadInstalledCustomApps } from './custom-app-storage';
import { WIDGET_CATALOG } from './widget-types';
import { applyEditDeltas, editRevision, editScopeValue, planEdits, stableEdit, validateEditDesktop, type EditState, type EditScope, type EditPlan, type EditRead, type EditOperation } from './mascot-edit-domain';

const JOURNAL_KEY = 'ai_phone_mascot_edits_v1';
const CHARACTERS_KEY = 'ai_phone_characters_v1';
const WIDGETS_KEY = 'ai_phone_widgets_v1';
const TEMPLATES_KEY = 'ai_phone_diy_templates_v1';
registerKvMigration(JOURNAL_KEY);
export const MASCOT_EDIT_CHANGED_EVENT = 'mascot-edit-changed';
export const MASCOT_EDIT_PREVIEW_EVENT = 'mascot-edit-preview';
export const MASCOT_EDIT_HISTORY_EVENT = 'mascot-edit-history';
const uid = () => crypto.randomUUID();
export function readEditState(): EditState {
  // Reload normalized character rows after another edit commit.
  const folders = loadDesktopFolders();
  let layout: unknown = null;
  try { layout = JSON.parse(kvGet(ICON_LAYOUT_STORAGE_KEY) || 'null'); } catch { throw Error('桌面布局存储损坏，请先恢复布局'); }
  return {
    characters: loadCharacters(), templates: loadDIYTemplates(), appearance: readThemeProfile(),
    desktop: { layout: normalizeDesktopIconLayout(layout, new Set(Object.keys(folders))), dock: loadDockLayout(), folders, widgets: loadWidgets() },
  };
}
export function editIconCatalog() {
  return [ ...Object.values(ICONS).map(i => ({ id: i.id as string, name: i.label })), ...loadInstalledCustomApps().map(a => ({ id: `custom_app:${a.id}`, name: a.name })) ];
}
export function readEditJournal(): EditPlan[] {
  const raw = kvGet(JOURNAL_KEY); if (!raw) return [];
  const value = JSON.parse(raw); if (!Array.isArray(value)) throw Error('修改记录无法读取'); return value;
}
function trimJournal(rows: EditPlan[]) {
  const result = rows.slice(-20);
  while (result.length > 1 && JSON.stringify(result).length > 8_000_000) result.shift();
  if (JSON.stringify(result).length > 8_000_000) throw Error('本次修改超过 8MB，请分成较小方案');
  return result;
}
export function readEditObject(scope: EditScope, id?: string) {
  const state = readEditState(); const value = editScopeValue(state, scope, id);
  if (scope === 'character' && !value) throw Error('找不到该角色 ID');
  const read: EditRead = { scope, ...(id ? { id } : {}), revision: editRevision(value) };
  if (scope === 'characters') return { read, characters: state.characters.map(c => ({ id: c.id, name: c.name, tags: c.tags ?? [], timeZone: c.timeZone, revision: editRevision(c) })), fields: CHARACTER_EDIT_FIELDS };
  if (scope === 'character') return { read, character: value, fields: CHARACTER_EDIT_FIELDS };
  if (scope === 'appearance') return { read, appearance: value, assetIds: collectThemeAssetIds(state.appearance), fields: APPEARANCE_EDIT_FIELDS };
  return { read, desktop: state.desktop, icons: editIconCatalog(), builtins: WIDGET_CATALOG, templates: state.templates.map(({ htmlString, ...t }) => ({ ...t, codeLength: htmlString?.length ?? 0 })), instructions: '模板源码用「读取DIY组件」读取；布局单位为 6 行×4 列，Dock 最多 4 个，文件夹不可进 Dock。' };
}
export const CHARACTER_EDIT_FIELDS = ['name', 'persona', 'personality', 'briefPersona', 'tags', 'addTags', 'removeTags', 'avatar', 'timeZone', 'wechatID', 'embeddedWorldBook'];
export const APPEARANCE_EDIT_FIELDS = ['name', 'wallpaperAssetId', 'wallpaperBlur', 'wallpaperOpacity', 'wallpaperScale', 'wallpaperX', 'wallpaperY', 'iconSkins', 'dockSkinAssetId', 'fontAssetId', 'fontFamily', 'hideTopBar', 'cssOverrides', 'globalCustomCSS', 'enableGlobalShadows', 'enableGlobalBorder', 'globalBorderColor'];
export function readDiyEditObject(args: { templateId?: string; widgetId?: string; offset?: number; limit?: number }) {
  const state = readEditState();
  const instance = args.widgetId ? state.desktop.widgets.find(w => w.id === args.widgetId) : undefined;
  const id = args.templateId || instance?.type;
  const template = state.templates.find(t => t.id === id);
  if (!template) throw Error('找不到 DIY 模板；内置组件只开放实例配置，不提供运行时改写宿主源码');
  if (args.widgetId && (!instance || instance.type !== template.id)) throw Error('模板与实例不匹配');
  const offset = args.offset ?? 0, limit = args.limit ?? 30_000;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 60_000) throw Error('offset 需要非负整数，limit 为 1–60000');
  const html = template.htmlString ?? '';
  return { read: { scope: 'desktop', revision: editRevision(editScopeValue(state, 'desktop')) }, template: { ...template, htmlString: html.slice(offset, offset + limit) }, offset, totalLength: html.length, nextOffset: offset + limit < html.length ? offset + limit : null, instances: state.desktop.widgets.filter(w => w.type === template.id), selectedInstance: instance ?? null };
}
async function validateChangedAssets(plan: EditPlan) {
  const assets = new Set<string>();
  for (const delta of plan.deltas) {
    if (delta.scope === 'appearance') {
      const before = delta.before as EditState['appearance'], after = delta.after as EditState['appearance'];
      for (const key of ['wallpaperAssetId', 'dockSkinAssetId', 'fontAssetId'] as const) if (after[key] && after[key] !== before[key]) assets.add(after[key]!);
      for (const [id, asset] of Object.entries(after.iconSkins)) if (asset && asset !== before.iconSkins[id as keyof typeof before.iconSkins]) assets.add(asset);
    }
    if (delta.scope === 'template') {
      const before = delta.before as {bgAssetId?: string} | null, after = delta.after as {bgAssetId?: string} | null;
      if (after?.bgAssetId && after.bgAssetId !== before?.bgAssetId) assets.add(after.bgAssetId);
    }
  }
  for (const id of assets) if (!(await getThemeAssetDataUrl(id))) throw Error(`找不到外观素材 ${id}；请先导入素材`);
}
export async function prepareEdit(operations: EditOperation[], reads: EditRead[], title: string): Promise<EditPlan> {
  const state = readEditState();
  const plan = planEdits(state, operations, reads, { now: new Date().toISOString(), uid, knownIcons: editIconCatalog().map(i => i.id) }, title);
  if (plan.deltas.some(d => d.scope === 'appearance')) {
    const next = applyEditDeltas(state, plan.deltas);
    const normalized = normalizeThemeProfile(next.appearance);
    // Persist exactly what the real theme renderer will use, and show it in the review.
    plan.deltas.find(d => d.scope === 'appearance')!.after = normalized;
  }
  await validateChangedAssets(plan);
  const raw = kvGet(JOURNAL_KEY);
  await kvCompareAndSetBatch([{ key: JOURNAL_KEY, expected: raw, value: JSON.stringify(trimJournal([...readEditJournal(), plan])) }]);
  return plan;
}
function rawState(state: EditState): Record<string, string> {
  return {
    [CHARACTERS_KEY]: JSON.stringify(state.characters), [TEMPLATES_KEY]: JSON.stringify(state.templates), [WIDGETS_KEY]: JSON.stringify(state.desktop.widgets),
    [ICON_LAYOUT_STORAGE_KEY]: JSON.stringify(state.desktop.layout), [DOCK_LAYOUT_STORAGE_KEY]: JSON.stringify(state.desktop.dock), [DESKTOP_FOLDERS_STORAGE_KEY]: JSON.stringify(state.desktop.folders),
    [THEME_PROFILE_STORAGE_KEY]: JSON.stringify(state.appearance),
  };
}
let applying = false;
export async function commitEdit(id: string, undo = false): Promise<EditPlan> {
  if (applying) throw Error('另一项修改正在保存，请稍后重试'); applying = true;
  try {
    const journal = readEditJournal(); const plan = journal.find(p => p.id === id);
    if (!plan) throw Error('找不到该方案（仅保留最近 20 项、总计最多 8MB）');
    if (plan.status === (undo ? 'undone' : 'applied')) return plan; // idempotent tool retry
    if (plan.status !== (undo ? 'applied' : 'draft')) throw Error('方案状态不允许此操作');
    const current = readEditState();
    if (!undo) for (const read of plan.reads) {
      if (read.revision !== editRevision(editScopeValue(current, read.scope, read.id))) throw Error('预览之后原内容已变化，请重新读取并准备方案');
    }
    const next = applyEditDeltas(current, plan.deltas, undo);
    if (plan.deltas.some(d => d.scope === 'desktop' || d.scope === 'template')) validateEditDesktop(next, editIconCatalog().map(i => i.id));
    const before = rawState(current), after = rawState(next);
    const changes = Object.keys(after).filter(key => before[key] !== after[key]).map(key => ({ key, expected: kvGet(key), value: after[key] }));
    const changedCharacters = plan.deltas.filter(d => d.scope === 'character' && d.before && d.after)
      .map(d => current.characters.find(c => c.id === d.id)!).filter(Boolean);
    if (changedCharacters.length) changes.push(prepareCharacterVersionBackups(changedCharacters, undo ? 'restore' : 'mascot', undo ? '撤销小卷修改前备份' : '小卷方案应用前备份'));
    const updated: EditPlan = { ...plan, status: undo ? 'undone' : 'applied', ...(undo ? { undoneAt: new Date().toISOString() } : { appliedAt: new Date().toISOString() }) };
    changes.push({ key: JOURNAL_KEY, expected: kvGet(JOURNAL_KEY), value: JSON.stringify(journal.map(p => p.id === id ? updated : p)) });
    await kvCompareAndSetBatch(changes);
    invalidateCharacterCache();
    window.dispatchEvent(new CustomEvent(MASCOT_EDIT_CHANGED_EVENT, { detail: { scopes: plan.deltas.map(d => d.scope), id, undo } }));
    window.dispatchEvent(new CustomEvent('mascot-widgets-changed'));
    return updated;
  } finally { applying = false; }
}
export function previewEdit(id: string): boolean {
  const plan = readEditJournal().find(p => p.id === id); if (!plan) throw Error('找不到修改方案');
  const detail = { plan, handled: false };
  window.dispatchEvent(new CustomEvent(MASCOT_EDIT_PREVIEW_EVENT, { detail })); return detail.handled;
}
export function summarizeEdit(plan: EditPlan) {
  return { id: plan.id, title: plan.title, status: plan.status, createdAt: plan.createdAt, changes: plan.deltas.map(d => ({ scope: d.scope, id: d.id, beforeName: (d.before as {name?: string} | null)?.name, afterName: (d.after as {name?: string} | null)?.name, fields: changedEditFields(d.before, d.after) })) };
}
export function changedEditFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return ['整个对象'];
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => stableEdit(a[k]) !== stableEdit(b[k]));
}
