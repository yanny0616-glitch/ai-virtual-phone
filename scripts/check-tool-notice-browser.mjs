// Real React component + generated Tailwind CSS in mobile Chromium. No model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compile } from 'tailwindcss';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'out/review-tool-notices');
await fs.mkdir(out, { recursive: true });
const read = file => fs.readFile(path.join(root, file), 'utf8');
const source = await read('components/chat/tool-notice-group.tsx');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const cssCompiler = await compile(await read('node_modules/tailwindcss/theme.css') + '\n@tailwind utilities;');
const strings = [...source.matchAll(/"([^"\n]+)"/g)].flatMap(m => m[1].split(/\s+/));
const css = await read('node_modules/tailwindcss/preflight.css') + cssCompiler.build(strings);
const modules = {
    react: await read('node_modules/react/cjs/react.production.js'),
    'react/jsx-runtime': await read('node_modules/react/cjs/react-jsx-runtime.production.js'),
    'react-dom': await read('node_modules/react-dom/cjs/react-dom.production.js'),
    'react-dom/client': await read('node_modules/react-dom/cjs/react-dom-client.production.js'),
    scheduler: await read('node_modules/scheduler/cjs/scheduler.production.js'),
    card: code,
};
const boot = `
const process={env:{NODE_ENV:'production'}},modules=${JSON.stringify(modules)},cache={};
function require(name){if(cache[name])return cache[name].exports;const module={exports:{}};cache[name]=module;new Function('require','module','exports','process',modules[name])(require,module,module.exports,process);return module.exports;}
const React=require('react'),root=require('react-dom/client').createRoot(document.getElementById('root')),Card=require('card').ToolNoticeGroup;
const messages=[{id:'1',content:'正在执行 play…'},{id:'2',content:'× play: params 必须是对象'},{id:'3',content:'正在执行 play…'},{id:'4',content:'✓ play 执行成功'}];
const wait=()=>new Promise(r=>setTimeout(r,100));const check=(v,label)=>{if(!v)throw Error(label)};
(async()=>{
root.render(React.createElement(Card,{messages,onContextMenu:id=>window.selected=id}));await wait();
const details=document.querySelector('details'),summary=document.querySelector('summary');
check(!details.open,'collapsed by default');check(summary.textContent.includes('4 条记录'),'record count');check(summary.textContent.includes('1 条失败'),'failure count');
summary.click();await wait();check(details.open,'expand');check(document.querySelectorAll('p').length===4,'all details retained');
document.querySelector('p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));check(window.selected==='1','record context menu');
check(details.getBoundingClientRect().width<=document.documentElement.clientWidth,'mobile width');
summary.click();await wait();window.captureReady=true;await new Promise(r=>window.finishCapture=r);
root.render(React.createElement(Card,{messages:messages.slice(0,3)}));await wait();check(document.querySelector('summary').textContent.includes('工具执行中'),'running update');
window.browserResult={passed:true};
})().catch(e=>window.browserResult={passed:false,error:String(e)});
`;
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;padding:28px;background:#f7f5f2;font-family:system-ui}#root{display:block}</style><div id="root"></div><script>${boot.replace(/<\/script/gi,'<\\/script')}</script>`);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-browser-'));
const child = spawn('chromium', ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio:'ignore' });
process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
let socket;
try {
    let port;
    for(let i=0;i<100;i++){try{port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(r=>setTimeout(r,100));}}
    if (!port) throw new Error('Chromium did not start');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    const pending=new Map();let serial=0;
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:pathToFileURL(path.join(out,'index.html')).href});
    let captured=false,result;
    for(let i=0;i<150;i++){
        if(!captured && await evaluate('Boolean(window.captureReady)')){
            const shot=await send('Page.captureScreenshot',{format:'png'});
            await fs.writeFile(path.join(out,'tool-notices-mobile.png'),Buffer.from(shot.data,'base64'));
            captured=true;await evaluate('window.finishCapture();true');
        }
        result=JSON.parse(await evaluate('JSON.stringify(window.browserResult||null)')||'null');if(result)break;
        await new Promise(r=>setTimeout(r,100));
    }
    if(!result?.passed)throw Error(JSON.stringify(result||{error:'browser timed out'}));
    console.log('PASS tool groups on mobile Chromium: default collapse, all details retained, failure count, context menu, running updates');
} finally {
    socket?.close();child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    await fs.rm(profile,{recursive:true,force:true});
}
