import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const presentationSource = stripTypeScriptTypes(fs.readFileSync(new URL('../lib/xhs-mcp-result.ts', import.meta.url), 'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const source = stripTypeScriptTypes(fs.readFileSync(new URL('../lib/xhs-note-client.ts', import.meta.url), 'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '').replace('await import("./tool-executor")', '({ callConfiguredMcpTool: globalThis.callConfiguredMcpTool })');
const rows = new Map(), deleted = [], requests = [], events = [];
let sequence = 0, fetchImpl;
const context = vm.createContext({ console, AbortSignal, Promise, structuredClone, isXhsNoteUrl: () => true, formatXhsNoteSnapshot: () => "note",
    loadMcpServers: () => [{id:'xhs', enabled:true}], isXhsMcpServer: () => true,
    callConfiguredMcpTool: async (server,name,args) => { requests.push({server,name,args}); return (await (await fetchImpl()).json()).result; },
    loadChatMessages: id => [...rows.values()].filter(row => row.sessionId === id),
    updateChatMessage: (id, patch) => { if (!rows.has(id)) return null; const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row; },
    storeMediaBase64: async () => ({ ref: 'media-store://' + ++sequence }),
    deleteMediaRef: async ref => { if (ref) deleted.push(ref); },
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return fetchImpl(url, options); },
});
vm.runInContext(presentationSource, context);
vm.runInContext(source + '\nglobalThis.api={hydrateXhsNote,hasPendingXhsNotes,retryXhsNote};', context);
const { hydrateXhsNote, hasPendingXhsNotes, retryXhsNote } = context.api;
const make = (id, sessionId = 's') => {
    const row = { id, sessionId, mediaType: 'xhs_link', mediaData: { xhsNote: { sourceUrl: 'https://xhslink.cn/o/test', status: 'loading' } } }; rows.set(id, row); return row;
};
const note = { url:'https://xhslink.cn/o/test', author:'作者', likedCount:'0',commentCount:'0',collectedCount:'0',noteType:'normal', title: '笔记', desc: '正文', images: Array.from({ length: 5 }, (_, i) => ({ url: `https://ci.xiaohongshu.com/${i}` })), imageCount: 5, comments: [], warnings: [] };
const response = data => ({ ok: true, status: 200, json: async () => data });
const mcpResult = (input, fail = true) => ({ result: { structuredContent: { floatXhsNote: { version:1, action:"read", sourceUrl:"https://xhslink.cn/o/test", note: {...structuredClone(input), images: input.images.map((image,i)=>({...image,...(fail && i===1 ? {error:"403"}: {})}))}, imageIndexes: input.images.flatMap((_,i)=>fail && i===1?[]:[i]) } }, content:input.images.flatMap((_,i)=>fail && i===1?[]:[{type:"image",data:"AAAA",mimeType:"image/png"}]) } });
let resolveFirst;
fetchImpl = async () => new Promise(resolve => { resolveFirst = resolve; });
const row = make('a');
const first = hydrateXhsNote(row);
assert.equal(first, hydrateXhsNote(row)); await Promise.resolve(); assert.equal(requests.length, 1);
assert.ok(hasPendingXhsNotes([...rows.values()]));
assert.equal(hasPendingXhsNotes([{ ...row, isRetracted: true }]), false);
resolveFirst(response(mcpResult(note)));
await first;
const result = rows.get('a').mediaData.xhsNote;
assert.equal(result.status, 'partial'); assert.equal(result.note.images.filter(i => i.ref).length, 4);
assert.equal(result.note.images[1].error, '403'); assert.equal(result.note.images[2].url, note.images[2].url);
assert.ok(!hasPendingXhsNotes([...rows.values()])); assert.equal(requests.length, 1);
assert.equal(requests[0].server.id,"xhs"); assert.equal(requests[0].name,"read_xiaohongshu_note");
assert.ok(events.every(e => e.detail.sessionId === 's'));

fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result:{isError:true,content:[{text:'暂时不可用'}]} }) });
await hydrateXhsNote(make('failed', 'other'));
assert.equal(rows.get('failed').mediaData.xhsNote.status, 'failed');
assert.equal(rows.get('failed').mediaData.xhsNote.sourceUrl, 'https://xhslink.cn/o/test');
fetchImpl = async () => new Promise(resolve => { resolveFirst = resolve; });
const removed = make('removed'); const running = hydrateXhsNote(removed); rows.delete('removed'); await Promise.resolve();
resolveFirst(response(mcpResult(note))); await running;
assert.ok(!rows.has('removed'));

fetchImpl = async () => response(mcpResult({ ...note, images: [], imageCount: 0 }));
retryXhsNote(rows.get('a'));
for (let i = 0; i < 10 && rows.get('a').mediaData.xhsNote.status === 'loading'; i++) await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(rows.get('a').mediaData.xhsNote.status, 'ready'); assert.equal(deleted.length, 4);
console.log('PASS loader deduplication, per-session pending gate, MCP-only 5-image hydration, partial failures, no resurrection after delete, retry and stale-media cleanup');
