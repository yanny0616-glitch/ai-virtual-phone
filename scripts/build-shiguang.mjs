import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import JSZip from 'jszip';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'custom-apps/shiguang');
const read = file => readFileSync(resolve(app, file), 'utf8');
const html = read('src/page.html').replace(/\{\{(STYLES|SCRIPTS)\}\}/g, (_, name) => read(name === 'STYLES' ? 'src/styles.css' : 'src/app.js'));
new Script(read('src/app.js'));
if (process.argv.includes('--check')) {
  if (read('index.html') !== html) throw new Error('拾光 index.html 与 src 不一致，请运行 shiguang:build');
  console.log('PASS 拾光源码、单文件产物和脚本语法一致');
} else {
  writeFileSync(resolve(app, 'index.html'), html);
  console.log('已生成拾光 index.html');
  if (process.argv.includes('--package')) {
    const manifest = JSON.parse(read('manifest.json'));
    const zip = new JSZip();
    for (const file of ['manifest.json','index.html','icon.svg','README.md']) zip.file(file, read(file));
    const out = resolve(root, 'out/custom-apps'); mkdirSync(out, { recursive: true });
    const file = resolve(out, `shiguang-${manifest.version}.zip`);
    writeFileSync(file, await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
    console.log(file);
  }
}
