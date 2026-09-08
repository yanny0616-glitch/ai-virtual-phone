'use client';
/* Local user images/blob URLs must remain unoptimized. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { type EditPlan, type EditState, stableEdit } from '@/lib/mascot-edit-domain';
import { changedEditFields, commitEdit, editIconCatalog, readEditJournal, readEditState } from '@/lib/mascot-edit-store';
import { getThemeAssetMap, collectThemeAssetIds } from '@/lib/theme-storage';
import { DIYCodeWidgetFrame, DIYWidgetRenderer } from '@/components/widgets/diy-widget-renderer';
import { WIDGET_SIZE_CELLS, type DIYWidgetTemplate, type WidgetInstance } from '@/lib/widget-types';

export function MascotReviewDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ width: 'min(94vw, 760px)', maxHeight: '86dvh', padding: 0, border: '1px solid #ddd', borderRadius: 18, background: '#fcfbf8', color: '#292725', boxShadow: '0 20px 70px #0005' }}>
    <div style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <strong>{title}</strong><button type="button" onClick={onClose} style={buttonStyle}>关闭</button>
      </div>
      {children}
    </div>
  </dialog>;
}
const buttonStyle: CSSProperties = { padding: '9px 14px', borderRadius: 10, border: '1px solid #d4d0c8', background: 'white', color: '#292725', cursor: 'pointer', minHeight: 44 };
export function WidgetEditPreview({ template, instance, prefix }: { template: DIYWidgetTemplate; instance?: WidgetInstance; prefix: string }) {
  const [rows, cols] = WIDGET_SIZE_CELLS[template.size];
  const width = cols === 4 ? 320 : cols * 78 - 8, height = rows === 1 ? 62 : rows * 98 - 36;
  const widget: WidgetInstance = { ...(instance ?? { page: 1, row: 1, col: 1 }), id: `${prefix}:${instance?.id ?? template.id}`, type: template.id, size: template.size };
  return <div style={{ maxWidth: '100%', overflowX: 'auto', borderRadius: 14, background: '#e7e4dd', padding: 8 }}>
    <div style={{ width, height, margin: 'auto' }}>
      {template.mode === 'code' ? <DIYCodeWidgetFrame widget={widget} template={template} readOnly /> : <DIYWidgetRenderer widget={widget} template={template} preview />}
    </div>
  </div>;
}
function DesktopEditPreview({ desktop, appearance }: { desktop: EditState['desktop']; appearance: EditState['appearance'] }) {
  const [assets, setAssets] = useState<Record<string, string>>({});
  const ids = collectThemeAssetIds(appearance).join('|');
  useEffect(() => { let active = true; void getThemeAssetMap(ids ? ids.split('|') : []).then(value => { if (active) setAssets(value); }); return () => { active = false; }; }, [ids]);
  const catalog = editIconCatalog();
  const label = (id: string) => desktop.folders[id]?.name ?? catalog.find(i => i.id === id)?.name ?? id;
  const pages = [...new Set([...Object.keys(desktop.layout).map(k => Number(k.slice(4))), ...desktop.widgets.map(w => w.page)])].sort((a, b) => a - b);
  return <div style={{ display: 'flex', overflowX: 'auto', gap: 10, paddingBottom: 6 }}>
    {pages.map(page => <div key={page} style={{ flex: '0 0 240px', borderRadius: 14, background: '#e9e5df', backgroundImage: appearance.wallpaperAssetId && assets[appearance.wallpaperAssetId] ? `url(${JSON.stringify(assets[appearance.wallpaperAssetId])})` : undefined, backgroundSize: 'cover', padding: 10, ...appearance.cssOverrides } as CSSProperties}>
      <small>第 {page} 页 · 布局示意</small>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gridTemplateRows: 'repeat(6,48px)', gap: 5, marginTop: 8 }}>
        {(desktop.layout[`page${page}`] ?? []).map(icon => <div key={icon.id} title={icon.id} style={{ gridRow: icon.row, gridColumn: icon.col, background: '#fffd', borderRadius: 9, fontSize: 10, overflow: 'hidden', textAlign: 'center' }}>
          {assets[appearance.iconSkins[icon.id] ?? ''] ? <img src={assets[appearance.iconSkins[icon.id]!]} alt="" style={{ width: 25, height: 25, objectFit: 'contain', margin: 'auto' }} /> : <div style={{ fontSize: 17 }}>{desktop.folders[icon.id] ? '▦' : '▣'}</div>}{label(icon.id)}
        </div>)}
        {desktop.widgets.filter(w => w.page === page).map(w => { const [r, c] = WIDGET_SIZE_CELLS[w.size]; return <div key={w.id} style={{ gridRow: `${w.row} / span ${r}`, gridColumn: `${w.col} / span ${c}`, background: '#d7e5eedd', border: '1px solid #829eae', borderRadius: 9, padding: 6, fontSize: 10, overflowWrap: 'anywhere' }}>{w.type}<br />{w.size}</div>; })}
      </div>
      <div style={{ marginTop: 8, borderRadius: 9, padding: 6, background: '#fffc', fontSize: 10 }}>Dock：{desktop.dock.map(label).join(' · ')}</div>
      {Object.entries(desktop.folders).map(([id, folder]) => <div key={id} style={{ fontSize: 10, background: '#fffc' }}>{folder.name}：{folder.icons.map(label).join('、')}</div>)}
    </div>)}
  </div>;
}
function displayValue(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2); }
export function MascotEditReview({ initialPlan, onClose }: { initialPlan: EditPlan; onClose: () => void }) {
  const [plan, setPlan] = useState(initialPlan), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [context] = useState(readEditState);
  const save = async (undo: boolean) => { setBusy(true); setError(''); try { setPlan(await commitEdit(plan.id, undo)); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); } };
  const desktopDelta = plan.deltas.find(d => d.scope === 'desktop');
  const appearanceDelta = plan.deltas.find(d => d.scope === 'appearance');
  return <MascotReviewDialog title={plan.title} onClose={onClose}>
    <p style={{ fontSize: 13, marginBottom: 12 }}>{plan.status === 'draft' ? '草稿 · 原内容尚未修改' : plan.status === 'applied' ? '已应用 · 可以撤销' : '已撤销'}</p>
    {(desktopDelta || appearanceDelta) && <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
      <div><p>修改前</p><DesktopEditPreview desktop={(desktopDelta?.before ?? context.desktop) as EditState['desktop']} appearance={(appearanceDelta?.before ?? context.appearance) as EditState['appearance']} /></div>
      <div><p>修改后</p><DesktopEditPreview desktop={(desktopDelta?.after ?? context.desktop) as EditState['desktop']} appearance={(appearanceDelta?.after ?? context.appearance) as EditState['appearance']} /></div>
    </div>}
    {desktopDelta && (() => {
      const before = desktopDelta.before as EditState['desktop'], after = desktopDelta.after as EditState['desktop'];
      const ids = [...new Set([...before.widgets, ...after.widgets].map(w => w.id))];
      return ids.map(id => {
        const old = before.widgets.find(w => w.id === id), next = after.widgets.find(w => w.id === id);
        if (old?.type === next?.type && stableEdit(old?.config) === stableEdit(next?.config)) return null;
        if (plan.deltas.some(d => d.scope === 'template' && (d.id === old?.type || d.id === next?.type))) return null;
        const oldTemplate = context.templates.find(t => t.id === old?.type), nextTemplate = context.templates.find(t => t.id === next?.type);
        if (!oldTemplate && !nextTemplate) return null;
        return <section key={id} style={{ margin: '14px 0' }}><strong>组件实例 · {id}</strong><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
          {oldTemplate && <div><small>修改前</small><WidgetEditPreview template={oldTemplate} instance={old} prefix={`preview-${plan.id}-config-before`} /></div>}
          {nextTemplate && <div><small>修改后</small><WidgetEditPreview template={nextTemplate} instance={next} prefix={`preview-${plan.id}-config-after`} /></div>}
        </div></section>;
      });
    })()}
    {plan.deltas.map((delta, index) => <section key={index} style={{ borderTop: '1px solid #e3ded4', padding: '12px 0' }}>
      <strong style={{ fontSize: 13 }}>{delta.scope === 'character' ? '角色' : delta.scope === 'template' ? 'DIY 组件' : delta.scope === 'desktop' ? '桌面' : '外观'} · {(delta.after as {name?: string} | null)?.name || delta.id || ''}</strong>
      {delta.scope === 'template' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginTop: 8 }}>
        {(['before', 'after'] as const).map(side => { const template = delta[side] as DIYWidgetTemplate | null; return template ? <div key={side}><small>{side === 'before' ? '原组件' : '修改后组件'} · 预览不控制播放</small><WidgetEditPreview template={template} prefix={`preview-${plan.id}-${side}`} instance={((desktopDelta?.[side] ?? context.desktop) as EditState['desktop']).widgets.find(w => w.type === template.id)} /></div> : null; })}
      </div>}
      {changedEditFields(delta.before, delta.after).filter(k => !['updatedAt', 'briefPersonaUpdatedAt'].includes(k)).map(field => {
        const before = field === '整个对象' ? delta.before : (delta.before as Record<string, unknown> | null)?.[field];
        const after = field === '整个对象' ? delta.after : (delta.after as Record<string, unknown> | null)?.[field];
        return <details key={field} style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 13 }}>{field}</summary><div style={{ display: 'grid', gap: 8, marginTop: 6 }}>{[['修改前', before], ['修改后', after]].map(([name, value]) => <div key={String(name)}><small>{String(name)}</small><pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', background: '#f0eee8', padding: 8 }}>{displayValue(value)}</pre></div>)}</div></details>;
      })}
    </section>)}
    {error && <p role="alert" style={{ color: '#a32222', margin: '12px 0' }}>{error}</p>}
    <div style={{ display: 'flex', gap: 8, paddingTop: 10 }}>
      {plan.status === 'draft' && <button type="button" disabled={busy} onClick={() => void save(false)} style={buttonStyle}>{busy ? '保存中…' : '应用这份修改'}</button>}
      {plan.status === 'applied' && <button type="button" disabled={busy} onClick={() => void save(true)} style={buttonStyle}>{busy ? '恢复中…' : '撤销这次修改'}</button>}
    </div>
  </MascotReviewDialog>;
}
export function MascotEditHistory({ onClose, onSelect }: { onClose: () => void; onSelect: (plan: EditPlan) => void }) {
  const rows = readEditJournal().slice().reverse();
  return <MascotReviewDialog title="小卷修改记录" onClose={onClose}>
    <p style={{ fontSize: 12, marginBottom: 12 }}>保留最近 20 项，总计最多 8MB。点开可以预览、应用或撤销。</p>
    {rows.length === 0 ? <p>还没有修改记录</p> : rows.map(plan => <button type="button" key={plan.id} onClick={() => onSelect(plan)} style={{ ...buttonStyle, display: 'block', textAlign: 'left', width: '100%', marginTop: 8 }}><strong>{plan.title}</strong><br /><small>{new Date(plan.createdAt).toLocaleString()} · {plan.status === 'draft' ? '草稿' : plan.status === 'applied' ? '已应用' : '已撤销'}</small></button>)}
  </MascotReviewDialog>;
}
