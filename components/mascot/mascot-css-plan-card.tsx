'use client';

// 小卷出主题的卡片：预览 / 结束预览 / 应用 / 撤销 / 只存进主题库 / 看代码。
// CSS 的落点在 lib/mascot-css-plan.ts，这里只管按钮和状态。

import { useState } from 'react';
import { MascotReviewDialog } from './mascot-edit-review';
import {
  CSS_LOCATION_LABEL,
  applyCssPlan,
  endCssPreview,
  getCssPlan,
  planFromLibraryEntry,
  previewCssPlan,
  readCssLibrary,
  removeCssLibraryEntry,
  saveCssPlanToLibrary,
  undoCssPlan,
  type CssPlan,
} from '@/lib/mascot-css-plan';

const STATUS_TEXT: Record<CssPlan['status'], string> = {
  draft: '草稿',
  previewing: '预览中',
  applied: '已应用',
  undone: '已撤销',
};

function lineDiff(before: string, after: string) {
  const beforeLines = before.split('\n').filter(l => l.trim());
  const afterLines = after.split('\n').filter(l => l.trim());
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  return {
    added: afterLines.filter(l => !beforeSet.has(l)).length,
    removed: beforeLines.filter(l => !afterSet.has(l)).length,
  };
}

export function MascotCssPlanReview({ planId, onClose }: { planId: string; onClose: () => void }) {
  const [plan, setPlan] = useState<CssPlan | undefined>(() => getCssPlan(planId));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showCode, setShowCode] = useState(false);

  if (!plan) {
    return <MascotReviewDialog title="主题方案" onClose={onClose}>
      <p className="mascot-review-empty">这份方案已经不在记录里了（只保留最近 20 份）。</p>
    </MascotReviewDialog>;
  }

  const run = async (label: string, action: () => Promise<CssPlan>) => {
    setBusy(label); setError(''); setNote('');
    try {
      setPlan(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const diff = lineDiff(plan.before, plan.after);
  const where = `${CSS_LOCATION_LABEL[plan.location] || plan.location}${plan.displayName ? ` · ${plan.displayName}` : ''}`;

  const footer = <>
    <button type="button" className="ui-btn ui-btn-ghost mascot-review-btn" onClick={onClose}>关闭</button>
    {(plan.status === 'draft' || plan.status === 'undone') && (
      <button type="button" className="ui-btn ui-btn-outline mascot-review-btn" disabled={!!busy} onClick={() => void run('preview', () => previewCssPlan(plan.id))}>
        {busy === 'preview' ? '预览中…' : '预览'}
      </button>
    )}
    {plan.status === 'previewing' && (
      <button type="button" className="ui-btn ui-btn-outline mascot-review-btn" disabled={!!busy} onClick={() => void run('end', () => endCssPreview(plan.id))}>
        {busy === 'end' ? '恢复中…' : '结束预览'}
      </button>
    )}
    {plan.status !== 'applied' && (
      <button type="button" className="ui-btn ui-btn-primary mascot-review-btn" disabled={!!busy} onClick={() => void run('apply', () => applyCssPlan(plan.id))}>
        {busy === 'apply' ? '应用中…' : '应用'}
      </button>
    )}
    {plan.status === 'applied' && (
      <button type="button" className="ui-btn ui-btn-danger mascot-review-btn" disabled={!!busy} onClick={() => void run('undo', () => undoCssPlan(plan.id))}>
        {busy === 'undo' ? '撤销中…' : '撤销'}
      </button>
    )}
  </>;

  return <MascotReviewDialog
    title={plan.title}
    status={STATUS_TEXT[plan.status]}
    statusTone={plan.status === 'previewing' ? 'draft' : plan.status}
    footer={footer}
    onClose={onClose}
  >
    <p className="mascot-review-summary">
      改的是 <strong>{where}</strong> 的 CSS：新增 {diff.added} 行、去掉 {diff.removed} 行，共 {plan.after.length} 字符。
      {plan.status === 'draft' && ' 还没动你的页面。'}
      {plan.status === 'previewing' && ' 现在页面上是预览效果，结束预览会换回原样。'}
    </p>

    <div className="mascot-review-footer" style={{ padding: 0, marginBottom: 10, gap: 8, justifyContent: 'flex-start' }}>
      <button type="button" className="ui-btn ui-btn-ghost mascot-review-btn" onClick={() => setShowCode(v => !v)}>
        {showCode ? '收起代码' : '看代码'}
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-ghost mascot-review-btn"
        disabled={!!busy || !!plan.libraryId}
        onClick={() => {
          try {
            const entry = saveCssPlanToLibrary(plan.id);
            setPlan(getCssPlan(plan.id));
            setNote(`已存进主题库：${entry.name}（页面没有改动）`);
            setError('');
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {plan.libraryId ? '已在主题库' : '只存进主题库'}
      </button>
    </div>

    {note && <p className="mascot-review-note">{note}</p>}

    {showCode && <div className="mascot-review-pair">
      <div><small>改之前</small><pre>{plan.before || '(空)'}</pre></div>
      <div><small>改之后</small><pre>{plan.after || '(空)'}</pre></div>
    </div>}

    {error && <p role="alert" className="mascot-review-error">{error}</p>}
  </MascotReviewDialog>;
}

export function MascotCssLibrary({ onClose, onOpenPlan }: { onClose: () => void; onOpenPlan: (planId: string) => void }) {
  const [rows, setRows] = useState(() => readCssLibrary().slice().reverse());
  const [error, setError] = useState('');

  return <MascotReviewDialog title="主题库" onClose={onClose}>
    <p className="mascot-review-note">最多存 50 份。套用也走方案管线，套坏了还能撤销。</p>
    {rows.length === 0 ? <p className="mascot-review-empty">主题库还是空的</p> : <div className="mascot-review-history">
      {rows.map(entry => <div key={entry.id} className="mascot-review-history-row" style={{ cursor: 'default' }}>
        <span>
          <strong>{entry.name}</strong>
          <small>{CSS_LOCATION_LABEL[entry.location] || entry.location}{entry.displayName ? ` · ${entry.displayName}` : ''} · {new Date(entry.createdAt).toLocaleString()}</small>
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="ui-btn ui-btn-outline mascot-review-btn"
            onClick={() => {
              void planFromLibraryEntry(entry.id)
                .then(plan => onOpenPlan(plan.id))
                .catch(e => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            套用
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-ghost mascot-review-btn"
            onClick={() => { removeCssLibraryEntry(entry.id); setRows(readCssLibrary().slice().reverse()); }}
          >
            删除
          </button>
        </span>
      </div>)}
    </div>}
    {error && <p role="alert" className="mascot-review-error">{error}</p>}
  </MascotReviewDialog>;
}
