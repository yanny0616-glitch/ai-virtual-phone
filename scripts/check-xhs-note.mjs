import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const cache = new Map();
function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: absolute })(
        name => name.startsWith('.') ? load(path.resolve(path.dirname(absolute), name + '.ts')) : require(name), module, module.exports);
    return module.exports;
}
const xhs = load('lib/xhs-note.ts');
const reader = load('lib/server/xhs-reader.ts');
assert.deepEqual(xhs.extractXhsNoteUrls('分享 https://xhslink.cn/o/abc 其他 https://example.com/xhslink.cn https://xhslink.cn/o/abc'), ['https://xhslink.cn/o/abc']);
for (const url of ['http://xhslink.cn/o/a', 'https://xhslink.cn.evil.test/a', 'https://user:pw@xhslink.cn/a', 'https://127.0.0.1/a', 'https://xhslink.cn:8443/a']) assert.equal(xhs.isXhsNoteUrl(url), false);
for (const url of ['https://127.0.0.1/a', 'https://evilxhscdn.com/a', 'https://xhscdn.com.evil.test/a', 'data:image/png;base64,AA==']) assert.equal(reader.normalizeXhsImageUrl(url), null);
assert.equal(reader.normalizeXhsImageUrl('//sns-webpic-qc.xhscdn.com/a'), 'https://sns-webpic-qc.xhscdn.com/a');

const note = { title: '标题含 } undefined', desc: '完整正文\n第二行', user: { nickname: '作者' }, type: 'normal',
    imageList: [1, 2, 3].map(n => ({ url: `http://sns-webpic-qc.xhscdn.com/${n}.jpg` })),
    interactInfo: { likedCount: '123', commentCount: '500', collectedCount: '45' } };
const page = state => `<script>window.__INITIAL_STATE__=${JSON.stringify(state).replace('"REPLACE_UNDEFINED"', 'undefined')};</script>`;
const state = { ignored: 'REPLACE_UNDEFINED', noteData: { data: { noteData: note, commentData: { comments: [{ user: { nickname: '评论人' }, content: '主评论', ipLocation: '上海', subComments: [{ user: { nickname: '回复人' }, content: '回复' }] }] } } } };
const parsed = reader.parseXhsNote(page(state), 'https://www.xiaohongshu.com/explore/abc');
assert.equal(parsed.title, note.title); assert.equal(parsed.images.length, 3);
assert.equal(parsed.commentCount, '500'); assert.equal(parsed.comments.length, 2);
assert.equal(reader.parseXhsNote(page({ noteData: { normalNotePreloadData: { title: 'preload', desc: '正文', imagesList: ['//ci.xiaohongshu.com/a.jpg'] } } }), parsed.url).images.length, 1);
assert.throws(() => reader.extractXhsState('<script>window.__INITIAL_STATE__=(()=>{throw 1})()</script>'), /格式/);
assert.throws(() => reader.extractXhsState('login required'), /公开笔记数据/);
assert.equal(reader.extractXhsState(page(state)).ignored, null);
assert.throws(() => reader.parseXhsNote(page({ noteData: { data: { noteData: { ...note, imageList: Array(31).fill(note.imageList[0]) } } } }), parsed.url), /30/);
console.log('PASS URL allowlists, inert JSON extraction, both mobile data paths, all images, visible comments/replies, explicit failure');

const js = source => stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ console,
    formatXhsNoteSnapshot: xhs.formatXhsNoteSnapshot,
    resolvePromptTimeAware: value => value,
    buildCharacterTimeContext: () => ({}), buildGroupTimeContext: () => ({}),
    getPromptTimestampOptionsForTimeContext: () => ({}), stripStateAndInnerForPrompt: value => value,
    matchesActiveTags: (tags, active) => !tags?.length || tags.every(tag => active.includes(tag)),
});
vm.runInContext(js(fs.readFileSync(path.join(root, 'lib/llm-prompt-assembler.ts'), 'utf8')) + '\nglobalThis.api={assemblePromptPayload,assembleGroupPromptPayload,formatRichMediaForHistory};', context);
const snapshot = { sourceUrl: parsed.url, status: 'ready', note: { ...parsed, images: parsed.images.map((image, i) => ({ ...image, ref: `data:image/png;base64,IMAGE${i + 1}` })) } };
const message = { id: 'x', sessionId: 's', role: 'user', content: '[小红书链接]', mediaType: 'xhs_link', mediaData: { xhsNote: snapshot }, status: 'sent', createdAt: '2026-09-13T00:00:00Z' };
for (const group of [false, true]) for (const chronological of [false, true]) for (const vision of [false, true]) {
    const msg = group ? { ...message, content: '[用户]: ' + context.api.formatRichMediaForHistory(message, '用户', '角色', true) } : message;
    const input = { character: { id: 'c', name: '角色' }, members: [], groupName: '群', memberNames: [], history: [msg], preset: null, worldBooks: [], regexes: [], timeAware: false, enableVision: vision,
        ...(chronological ? { unifiedRecentItems: [{ kind: 'history', historyIndex: 0 }] } : {}) };
    const result = (group ? context.api.assembleGroupPromptPayload : context.api.assemblePromptPayload)(input);
    const body = JSON.stringify(result);
    assert.match(body, /完整正文/); assert.match(body, /主评论/); assert.match(body, /回复人/);
    const images = result.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url');
    assert.equal(images.length, vision ? 3 : 0, JSON.stringify({ group, chronological, vision, result }));
    if (vision) assert.deepEqual(Array.from(images, p => p.image_url.url), snapshot.note.images.map(i => i.ref));
}
assert.equal(context.api.formatRichMediaForHistory({ ...message, isRetracted: true }, 'U', 'C'), '[小红书分享已撤回]');
const missing = structuredClone(message); missing.mediaData.xhsNote.note.images[1] = { url: 'https://ci.xiaohongshu.com/b', error: 'unavailable' };
const result = context.api.assemblePromptPayload({ character: { id: 'c', name: '角色' }, history: [missing], preset: null, worldBooks: [], regexes: [], enableVision: true, timeAware: false });
assert.match(JSON.stringify(result), /配图 3/); assert.doesNotMatch(JSON.stringify(result), /IMAGE2/);
assert.equal(message.mediaData.xhsNote.note.images.length, 3);
console.log('PASS actual single/group assemblers, chronological/default history, vision on/off, all ordered images, missing image labels, retraction');

if (process.argv.includes('--live')) {
    const live = await reader.readXhsNote('https://xhslink.cn/o/AYB7YzHqbGi');
    assert.match(live.title, /花园/); assert.equal(live.images.length, 5); assert.ok(live.comments.length > 0);
    for (const image of live.images) {
        const result = await reader.readXhsImage(image.url);
        assert.ok(result.base64.length > 1000); assert.match(result.mime, /^image\//);
    }
    console.log(`PASS live VPS fetch: ${live.images.length} images and ${live.comments.length} visible comments/replies`);
}
