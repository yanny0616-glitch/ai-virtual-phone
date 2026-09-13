import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../lib/xhs-note-client.ts', import.meta.url), 'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const rows = new Map(), deleted = [], requests = [], events = [];
let sequence = 0, fetchImpl;
const context = vm.createContext({ console, AbortSignal, Promise,
    loadChatMessages: id => [...rows.values()].filter(row => row.sessionId === id),
    updateChatMessage: (id, patch) => { if (!rows.has(id)) return null; const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row; },
    storeMediaBase64: async () => ({ ref: 'media-store://' + ++sequence }),
    deleteMediaRef: async ref => { if (ref) deleted.push(ref); },
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return fetchImpl(url, options); },
});
vm.runInContext(source + '\nglobalThis.api={hydrateXhsNote,hasPendingXhsNotes,retryXhsNote};', context);
const { hydrateXhsNote, hasPendingXhsNotes, retryXhsNote } = context.api;
const make = (id, sessionId = 's') => {
    const row = { id, sessionId, mediaType: 'xhs_link', mediaData: { xhsNote: { sourceUrl: 'https://xhslink.cn/o/test', status: 'loading' } } }; rows.set(id, row); return row;
};
const note = { title: '笔记', desc: '正文', images: Array.from({ length: 5 }, (_, i) => ({ url: `https://ci.xiaohongshu.com/${i}` })), imageCount: 5, comments: [], warnings: [] };
const response = data => ({ ok: true, status: 200, json: async () => data });
let resolveFirst;
fetchImpl = async (url, options) => {
    if (url.includes('card')) return new Promise(resolve => { resolveFirst = resolve; });
    return response({ ok: true, images: JSON.parse(options.body).urls.map(url => url.endsWith('/1') ? { url, error: '403' } : { url, base64: 'AAAA', mime: 'image/png' }) });
};
const row = make('a');
const first = hydrateXhsNote(row);
assert.equal(first, hydrateXhsNote(row)); assert.equal(requests.length, 1);
assert.ok(hasPendingXhsNotes([...rows.values()]));
assert.equal(hasPendingXhsNotes([{ ...row, isRetracted: true }]), false);
resolveFirst(response({ ok: true, note: structuredClone(note) }));
await first;
const result = rows.get('a').mediaData.xhsNote;
assert.equal(result.status, 'partial'); assert.equal(result.note.images.filter(i => i.ref).length, 4);
assert.equal(result.note.images[1].error, '403'); assert.equal(result.note.images[2].url, note.images[2].url);
assert.ok(!hasPendingXhsNotes([...rows.values()])); assert.equal(requests.length, 3);
assert.ok(events.every(e => e.detail.sessionId === 's'));

fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: '暂时不可用' }) });
await hydrateXhsNote(make('failed', 'other'));
assert.equal(rows.get('failed').mediaData.xhsNote.status, 'failed');
assert.equal(rows.get('failed').mediaData.xhsNote.sourceUrl, 'https://xhslink.cn/o/test');
fetchImpl = async () => new Promise(resolve => { resolveFirst = resolve; });
const removed = make('removed'); const running = hydrateXhsNote(removed); rows.delete('removed');
resolveFirst(response({ ok: true, note: structuredClone(note) })); await running;
assert.ok(!rows.has('removed'));

fetchImpl = async () => response({ ok: true, note: { ...note, images: [], imageCount: 0 } });
retryXhsNote(rows.get('a'));
for (let i = 0; i < 10 && rows.get('a').mediaData.xhsNote.status === 'loading'; i++) await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(rows.get('a').mediaData.xhsNote.status, 'ready'); assert.equal(deleted.length, 4);
console.log('PASS loader deduplication, per-session pending gate, 5-image progress, partial failures, no resurrection after delete, retry and stale-media cleanup');
