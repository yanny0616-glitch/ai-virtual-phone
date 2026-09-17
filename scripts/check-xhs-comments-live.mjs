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
const reader = load('lib/server/xhs-reader.ts');
const server = load('lib/server/xhs-mcp.ts');
const url='https://xhslink.cn/o/AUUi1Y0LLfs';
const result=await server.callXhsMcpTool('read_xiaohongshu_comments',{url,limit:10});
const meta=result.structuredContent.floatXhsNote;
const note=meta.note;
const comments=note.images.filter(i=>i.commentIndex!==undefined);
assert.ok(comments.length>=3,'Expected publicly visible comment images');
assert.ok(meta.imageIndexes.filter(i=>note.images[i].commentIndex!==undefined).length>=3,'Expected downloadable comment images');
console.log(JSON.stringify({title:note.title,noteImages:note.imageCount,comments:note.comments.length,commentImages:note.commentImageCount,loadedImages:meta.imageIndexes.length,failures:note.images.filter(i=>i.error).map(i=>i.error)}));
