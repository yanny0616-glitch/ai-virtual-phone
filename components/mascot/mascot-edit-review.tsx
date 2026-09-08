'use client';
/* Local user images/blob URLs must remain unoptimized. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { type EditPlan, type EditState, stableEdit } from '@/lib/mascot-edit-domain';
import { changedEditFields, commitEdit, editIconCatalog, readEditJournal, readEditState } from '@/lib/mascot-edit-store';
import { getThemeAssetMap, collectThemeAssetIds } from '@/lib/theme-storage';
import { DIYCodeWidgetFrame, DIYWidgetRenderer } from '@/components/widgets/diy-widget-renderer';
import { GRID_COLS, GRID_ROWS, WIDGET_CATALOG, WIDGET_SIZE_CELLS, type DIYWidgetTemplate, type WidgetInstance } from '@/lib/widget-types';

type Desktop = EditState['desktop'];
type Appearance = EditState['appearance'];
type Mark = 'added' | 'moved' | 'changed' | 'removed';
const MARK_LABEL: Record<Mark, string> = { added: '新增', moved: '移动', changed: '修改', removed: '移除' };

export function MascotReviewDialog({ title, status, statusTone, footer, onClose, children }: { title: string; status?: string; statusTone?: 'draft' | 'applied' | 'undone'; footer?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose]);
  return <div className="modal-overlay modal-overlay-bottom mascot-review-overlay" data-ui="modal" onClick={onClose} onPointerDown={e => e.stopPropagation()}>
    <div className="modal-sheet mascot-review-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
      <div className="mascot-review-grab" aria-hidden="true" />
      <div className="modal-header mascot-review-header">
        <button type="button" className="modal-header-btn modal-header-btn-muted" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        <h3 className="modal-title mascot-review-title">{title}</h3>
        {status ? <span className="mascot-review-status" data-tone={statusTone}>{status}</span> : <span style={{ width: 28 }} />}
      </div>
      <div className="modal-body mascot-review-body">{children}</div>
      {footer && <div className="modal-footer mascot-review-footer">{footer}</div>}
    </div>
  </div>;
}

export function WidgetEditPreview({ template, instance, prefix }: { template: DIYWidgetTemplate; instance?: WidgetInstance; prefix: string }) {
  const [rows, cols] = WIDGET_SIZE_CELLS[template.size];
  const width = cols === 4 ? 320 : cols * 78 - 8, height = rows === 1 ? 62 : rows * 98 - 36;
  const widget: WidgetInstance = { ...(instance ?? { page: 1, row: 1, col: 1 }), id: `${prefix}:${instance?.id ?? template.id}`, type: template.id, size: template.size };
  return <div className="mascot-review-widget-stage">
    <div style={{ width, height, margin: 'auto' }}>
      {template.mode === 'code' ? <DIYCodeWidgetFrame widget={widget} template={template} readOnly /> : <DIYWidgetRenderer widget={widget} template={template} preview />}
    </div>
  </div>;
}

function useThemeAssets(...profiles: Appearance[]) {
  const [assets, setAssets] = useState<Record<string, string>>({});
  const ids = [...new Set(profiles.flatMap(collectThemeAssetIds))].join('|');
  useEffect(() => { let active = true; void getThemeAssetMap(ids ? ids.split('|') : []).then(value => { if (active) setAssets(value); }); return () => { active = false; }; }, [ids]);
  return assets;
}

type Placement = { page: number; row: number; col: number };
function iconPlacements(desktop: Desktop) {
  const out = new Map<string, Placement>();
  for (const [key, icons] of Object.entries(desktop.layout)) {
    if (!Array.isArray(icons)) continue;
    const page = Number(key.slice(4)); if (!Number.isFinite(page)) continue;
    for (const icon of icons) out.set(icon.id, { page, row: icon.row, col: icon.col });
  }
  return out;
}
function samePlace(a?: Placement, b?: Placement) { return !!a && !!b && a.page === b.page && a.row === b.row && a.col === b.col; }
function desktopPages(desktop: Desktop) {
  return [...new Set([...Object.keys(desktop.layout).map(k => Number(k.slice(4))).filter(Number.isFinite), ...desktop.widgets.map(w => w.page)])];
}

/** 修改前后的桌面差异：按图标 / 组件 id 标记新增、移动、修改、移除，并给出可读的清单。 */
function diffDesktop(before: Desktop, after: Desktop, name: (id: string) => string, widgetName: (w: WidgetInstance) => string) {
  const icons = new Map<string, Mark>(), widgets = new Map<string, Mark>(), rows: { text: string; note: string; mark: Mark }[] = [];
  const b = iconPlacements(before), a = iconPlacements(after);
  for (const [id, place] of a) {
    const old = b.get(id);
    if (!old) { icons.set(id, 'added'); rows.push({ text: name(id), note: `新增 · 第 ${place.page} 页`, mark: 'added' }); }
    else if (!samePlace(old, place)) { icons.set(id, 'moved'); rows.push({ text: name(id), note: old.page === place.page ? `移动 · 第 ${place.page} 页` : `第 ${old.page} 页 → 第 ${place.page} 页`, mark: 'moved' }); }
  }
  for (const [id, place] of b) if (!a.has(id)) { icons.set(id, 'removed'); rows.push({ text: name(id), note: `移除 · 原第 ${place.page} 页`, mark: 'removed' }); }
  const bw = new Map(before.widgets.map(w => [w.id, w])), aw = new Map(after.widgets.map(w => [w.id, w]));
  for (const [id, w] of aw) {
    const old = bw.get(id), label = `${widgetName(w)} · ${w.size}`;
    if (!old) { widgets.set(id, 'added'); rows.push({ text: label, note: `新增 · 第 ${w.page} 页`, mark: 'added' }); continue; }
    const moved = old.page !== w.page || old.row !== w.row || old.col !== w.col || old.size !== w.size;
    const changed = old.type !== w.type || stableEdit(old.config) !== stableEdit(w.config);
    if (changed) { widgets.set(id, 'changed'); rows.push({ text: label, note: moved ? '内容与位置都改了' : '内容修改', mark: 'changed' }); }
    else if (moved) { widgets.set(id, 'moved'); rows.push({ text: label, note: old.page === w.page ? `移动 · 第 ${w.page} 页` : `第 ${old.page} 页 → 第 ${w.page} 页`, mark: 'moved' }); }
  }
  for (const [id, w] of bw) if (!aw.has(id)) { widgets.set(id, 'removed'); rows.push({ text: `${widgetName(w)} · ${w.size}`, note: `移除 · 原第 ${w.page} 页`, mark: 'removed' }); }
  if (before.dock.join('|') !== after.dock.join('|')) rows.push({ text: 'Dock', note: `${before.dock.map(name).join(' · ') || '空'} → ${after.dock.map(name).join(' · ') || '空'}`, mark: 'changed' });
  for (const id of new Set([...Object.keys(before.folders), ...Object.keys(after.folders)])) {
    const x = before.folders[id], y = after.folders[id];
    if (!x) rows.push({ text: `文件夹「${y.name}」`, note: `新增：${y.icons.map(name).join('、')}`, mark: 'added' });
    else if (!y) rows.push({ text: `文件夹「${x.name}」`, note: '移除', mark: 'removed' });
    else if (x.name !== y.name || x.icons.join('|') !== y.icons.join('|')) rows.push({ text: `文件夹「${y.name}」`, note: `成员：${y.icons.map(name).join('、')}`, mark: 'changed' });
  }
  const order: Mark[] = ['added', 'changed', 'moved', 'removed'];
  rows.sort((p, q) => order.indexOf(p.mark) - order.indexOf(q.mark));
  return { icons, widgets, rows };
}

function wallpaperStyle(appearance: Appearance, assets: Record<string, string>): CSSProperties {
  const url = appearance.wallpaperAssetId ? assets[appearance.wallpaperAssetId] : undefined;
  return url ? { backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {};
}

/** 单页迷你桌面：真实 6×4 网格按比例缩放，图标用显示名，组件显示类型名 + 尺寸角标。 */
function MiniDesktop({ desktop, appearance, assets, page, pageCount, marks, side, name, widgetName }: {
  desktop: Desktop; appearance: Appearance; assets: Record<string, string>; page: number; pageCount: number;
  marks?: { icons: Map<string, Mark>; widgets: Map<string, Mark> }; side: 'before' | 'after'; name: (id: string) => string; widgetName: (w: WidgetInstance) => string;
}) {
  const icons = desktop.layout[`page${page}` as keyof Desktop['layout']];
  const iconList = Array.isArray(icons) ? icons : [];
  const mark = (m?: Mark) => { if (!m) return undefined; if (side === 'before') return m === 'removed' ? 'removed' : undefined; return m === 'removed' ? undefined : m; };
  return <div className="mascot-review-phone" style={wallpaperStyle(appearance, assets)}>
    <span className="mascot-review-phone-page">{page} / {pageCount}</span>
    <div className="mascot-review-grid" style={{ gridTemplateColumns: `repeat(${GRID_COLS},minmax(0,1fr))`, gridTemplateRows: `repeat(${GRID_ROWS},minmax(0,1fr))` }}>
      {iconList.map(icon => {
        const skin = appearance.iconSkins[icon.id];
        return <div key={icon.id} className="mascot-review-icon" data-mark={mark(marks?.icons.get(icon.id))} style={{ gridRow: icon.row, gridColumn: icon.col }}>
          {skin && assets[skin] ? <img src={assets[skin]} alt="" /> : <i data-folder={desktop.folders[icon.id] ? '' : undefined} />}
          <span>{name(icon.id)}</span>
        </div>;
      })}
      {desktop.widgets.filter(w => w.page === page).map(w => { const [r, c] = WIDGET_SIZE_CELLS[w.size]; return <div key={w.id} className="mascot-review-widget" data-mark={mark(marks?.widgets.get(w.id))} style={{ gridRow: `${w.row} / span ${r}`, gridColumn: `${w.col} / span ${c}` }}><span>{widgetName(w)}</span><small>{w.size.replace('x', '×')}</small></div>; })}
    </div>
    <div className="mascot-review-dock">{desktop.dock.length ? desktop.dock.map(name).join(' · ') : 'Dock 为空'}</div>
  </div>;
}

function displayValue(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2); }
function statusText(status: EditPlan['status']) { return status === 'draft' ? '草稿 · 未应用' : status === 'applied' ? '已应用 · 可撤销' : '已撤销'; }

export function MascotEditReview({ initialPlan, onClose }: { initialPlan: EditPlan; onClose: () => void }) {
  const [plan, setPlan] = useState(initialPlan), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [context] = useState(readEditState);
  const save = async (undo: boolean) => { setBusy(true); setError(''); try { setPlan(await commitEdit(plan.id, undo)); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  const desktopDelta = plan.deltas.find(d => d.scope === 'desktop');
  const appearanceDelta = plan.deltas.find(d => d.scope === 'appearance');
  const before = { desktop: (desktopDelta?.before ?? context.desktop) as Desktop, appearance: (appearanceDelta?.before ?? context.appearance) as Appearance };
  const after = { desktop: (desktopDelta?.after ?? context.desktop) as Desktop, appearance: (appearanceDelta?.after ?? context.appearance) as Appearance };
  const assets = useThemeAssets(before.appearance, after.appearance);
  const catalog = useMemo(() => editIconCatalog(), []);
  const templates = useMemo(() => new Map([...context.templates, ...plan.deltas.filter(d => d.scope === 'template').flatMap(d => [d.before, d.after]).filter((t): t is DIYWidgetTemplate => !!t && typeof t === 'object' && 'id' in t)].map(t => [t.id, t])), [context.templates, plan.deltas]);
  const name = (id: string) => after.desktop.folders[id]?.name ?? before.desktop.folders[id]?.name ?? catalog.find(i => i.id === id)?.name ?? id;
  const widgetName = (w: WidgetInstance) => templates.get(w.type)?.name ?? WIDGET_CATALOG.find(c => c.type === w.type)?.name ?? w.type;
  const diff = useMemo(() => desktopDelta ? diffDesktop(before.desktop, after.desktop, name, widgetName) : null, [desktopDelta]); // eslint-disable-line react-hooks/exhaustive-deps
  const pagesBefore = desktopPages(before.desktop), pagesAfter = desktopPages(after.desktop);
  const pages = [...new Set([...pagesBefore, ...pagesAfter])].sort((a, b) => a - b);
  const [page, setPage] = useState(() => pages.find(p => diff && [...diff.icons.entries(), ...diff.widgets.entries()].some(([id]) => iconPlacements(after.desktop).get(id)?.page === p || after.desktop.widgets.find(w => w.id === id)?.page === p)) ?? pages[0] ?? 1);
  const appearanceFields = appearanceDelta ? changedEditFields(appearanceDelta.before, appearanceDelta.after).filter(k => k !== 'updatedAt') : [];
  const otherDeltas = plan.deltas.filter(d => d.scope === 'character' || d.scope === 'template');
  const counts = diff ? (['added', 'moved', 'changed', 'removed'] as Mark[]).map(m => [m, diff.rows.filter(r => r.mark === m).length] as const).filter(([, n]) => n > 0) : [];
  const summary = [
    counts.length ? counts.map(([m, n]) => `${MARK_LABEL[m]} ${n} 项`).join('、') : (diff ? '桌面布局没有变化' : ''),
    pagesAfter.filter(p => !pagesBefore.includes(p)).length ? `新建第 ${pagesAfter.filter(p => !pagesBefore.includes(p)).join('、')} 页` : '',
    appearanceFields.length ? `外观改了 ${appearanceFields.length} 项` : '',
    otherDeltas.length ? `${otherDeltas.filter(d => d.scope === 'template').length ? `DIY 组件 ${otherDeltas.filter(d => d.scope === 'template').length} 个` : ''}${otherDeltas.filter(d => d.scope === 'character').length ? `${otherDeltas.some(d => d.scope === 'template') ? '，' : ''}角色 ${otherDeltas.filter(d => d.scope === 'character').length} 个` : ''}` : '',
  ].filter(Boolean).join('；');
  const showDesktop = !!(desktopDelta || appearanceDelta);

  const footer = <>
    <button type="button" className="ui-btn ui-btn-ghost mascot-review-btn" onClick={onClose}>{plan.status === 'draft' ? '先不改' : '关闭'}</button>
    {plan.status === 'draft' && <button type="button" className="ui-btn ui-btn-primary mascot-review-btn" disabled={busy} onClick={() => void save(false)}>{busy ? '保存中…' : '应用这份修改'}</button>}
    {plan.status === 'applied' && <button type="button" className="ui-btn ui-btn-danger mascot-review-btn" disabled={busy} onClick={() => void save(true)}>{busy ? '恢复中…' : '撤销这次修改'}</button>}
  </>;

  return <MascotReviewDialog title={plan.title} status={statusText(plan.status)} statusTone={plan.status} footer={footer} onClose={onClose}>
    {summary && <p className="mascot-review-summary">小卷的方案：<strong>{summary}</strong>。{plan.status === 'draft' ? '还没有改动你的桌面。' : ''}</p>}
    {showDesktop && <>
      {pages.length > 1 && <div className="mascot-review-tabs" role="tablist">
        {pages.map(p => <button key={p} type="button" role="tab" aria-selected={p === page} className="mascot-review-tab" onClick={() => setPage(p)}>第 {p} 页{!pagesBefore.includes(p) ? ' · 新' : !pagesAfter.includes(p) ? ' · 删' : ''}</button>)}
      </div>}
      <div className="mascot-review-compare">
        <div><h4>修改前</h4><MiniDesktop desktop={before.desktop} appearance={before.appearance} assets={assets} page={page} pageCount={pagesBefore.length} marks={diff ?? undefined} side="before" name={name} widgetName={widgetName} /></div>
        <div><h4>修改后</h4><MiniDesktop desktop={after.desktop} appearance={after.appearance} assets={assets} page={page} pageCount={pagesAfter.length} marks={diff ?? undefined} side="after" name={name} widgetName={widgetName} /></div>
      </div>
      {diff && diff.rows.length > 0 && <div className="mascot-review-legend"><span data-mark="added">新增 / 修改</span><span data-mark="moved">移动</span><span data-mark="removed">移除（变淡）</span></div>}
      {diff && diff.rows.length > 0 && <ul className="mascot-review-list">{diff.rows.map((row, i) => <li key={i}><span>{row.text}</span><small data-mark={row.mark}>{row.note}</small></li>)}</ul>}
    </>}
    {desktopDelta && (() => {
      const ids = [...new Set([...before.desktop.widgets, ...after.desktop.widgets].map(w => w.id))];
      const sections = ids.map(id => {
        const old = before.desktop.widgets.find(w => w.id === id), next = after.desktop.widgets.find(w => w.id === id);
        if (old?.type === next?.type && stableEdit(old?.config) === stableEdit(next?.config)) return null;
        if (plan.deltas.some(d => d.scope === 'template' && (d.id === old?.type || d.id === next?.type))) return null;
        const oldTemplate = context.templates.find(t => t.id === old?.type), nextTemplate = context.templates.find(t => t.id === next?.type);
        if (!oldTemplate && !nextTemplate) return null;
        return <section key={id} className="mascot-review-section"><h4>组件实例 · {next ? widgetName(next) : old ? widgetName(old) : id}</h4><div className="mascot-review-pair">
          {oldTemplate && <div><small>修改前</small><WidgetEditPreview template={oldTemplate} instance={old} prefix={`preview-${plan.id}-config-before`} /></div>}
          {nextTemplate && <div><small>修改后</small><WidgetEditPreview template={nextTemplate} instance={next} prefix={`preview-${plan.id}-config-after`} /></div>}
        </div></section>;
      }).filter(Boolean);
      return sections.length ? sections : null;
    })()}
    {plan.deltas.filter(d => d.scope !== 'desktop').map((delta, index) => {
      const fields = changedEditFields(delta.before, delta.after).filter(k => !['updatedAt', 'briefPersonaUpdatedAt'].includes(k));
      if (!fields.length && delta.scope !== 'template') return null;
      return <section key={index} className="mascot-review-section">
        <h4>{delta.scope === 'character' ? '角色' : delta.scope === 'template' ? 'DIY 组件' : '外观'} · {(delta.after as { name?: string } | null)?.name || (delta.before as { name?: string } | null)?.name || delta.id || ''}</h4>
        {delta.scope === 'template' && <div className="mascot-review-pair">
          {(['before', 'after'] as const).map(side => { const template = delta[side] as DIYWidgetTemplate | null; return template ? <div key={side}><small>{side === 'before' ? '原组件' : '修改后组件'} · 预览不控制播放</small><WidgetEditPreview template={template} prefix={`preview-${plan.id}-${side}`} instance={(side === 'before' ? before : after).desktop.widgets.find(w => w.type === template.id)} /></div> : null; })}
        </div>}
        {fields.map(field => {
          const b = field === '整个对象' ? delta.before : (delta.before as Record<string, unknown> | null)?.[field];
          const a = field === '整个对象' ? delta.after : (delta.after as Record<string, unknown> | null)?.[field];
          return <details key={field} className="mascot-review-field"><summary>{field}</summary><div className="mascot-review-pair">{[['修改前', b], ['修改后', a]].map(([label, value]) => <div key={String(label)}><small>{String(label)}</small><pre>{displayValue(value)}</pre></div>)}</div></details>;
        })}
      </section>;
    })}
    {error && <p role="alert" className="mascot-review-error">{error}</p>}
  </MascotReviewDialog>;
}

export function MascotEditHistory({ onClose, onSelect }: { onClose: () => void; onSelect: (plan: EditPlan) => void }) {
  const rows = readEditJournal().slice().reverse();
  return <MascotReviewDialog title="小卷修改记录" onClose={onClose}>
    <p className="mascot-review-note">保留最近 20 项，总计最多 8MB。点开可以预览、应用或撤销。</p>
    {rows.length === 0 ? <p className="mascot-review-empty">还没有修改记录</p> : <div className="mascot-review-history">
      {rows.map(plan => <button type="button" key={plan.id} onClick={() => onSelect(plan)} className="mascot-review-history-row">
        <span><strong>{plan.title}</strong><small>{new Date(plan.createdAt).toLocaleString()} · {plan.deltas.length} 处改动</small></span>
        <span className="mascot-review-status" data-tone={plan.status}>{plan.status === 'draft' ? '草稿' : plan.status === 'applied' ? '已应用' : '已撤销'}</span>
      </button>)}
    </div>}
  </MascotReviewDialog>;
}
