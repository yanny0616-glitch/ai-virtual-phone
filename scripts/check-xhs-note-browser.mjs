// Real React component + generated Tailwind CSS in mobile Chromium. No model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compile } from 'tailwindcss';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'out/review-xhs-note');
await fs.mkdir(out, { recursive: true });
const read = file => fs.readFile(path.join(root, file), 'utf8');
const source = await read('components/chat/xhs-link-card.tsx');
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
const process={env:{NODE_ENV:'production'}}, modules=${JSON.stringify(modules)}, cache={};
function require(name){
 if(name==='lucide-react')return new Proxy({}, {get:()=>()=>require('react').createElement('span',{'aria-hidden':true},'◇')});
 if(name==='@/lib/media-cache-storage')return {loadMediaBlob:async()=>({blob:new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#fce7eb"/><text x="400" y="240" text-anchor="middle" font-size="45" fill="#bd526d">小红书笔记 · 配图</text></svg>'],{type:'image/svg+xml'})})};
 if(name==='@/lib/xhs-note-client')return {retryXhsNote:()=>window.retried=true};
 if(cache[name])return cache[name].exports;
 const module={exports:{}};cache[name]=module;
 new Function('require','module','exports','process',modules[name])(require,module,module.exports,process);return module.exports;
}
const React=require('react'), root=require('react-dom/client').createRoot(document.getElementById('root')), Card=require('card').XhsLinkCard;
const msg={id:'x',sessionId:'s',mediaType:'xhs_link',mediaData:{xhsNote:{sourceUrl:'https://xhslink.cn/o/test',status:'loading',stage:'正在加载配图 2/5'}}};
const render=()=>root.render(React.createElement(Card,{message:structuredClone(msg)}));
const wait=()=>new Promise(resolve=>setTimeout(resolve,80));
const check=(value,label)=>{if(!value)throw Error(label)};
(async()=>{
 render();await wait();check(document.querySelector('[role=status]').textContent.includes('2/5'),'loading progress');
 msg.mediaData.xhsNote={...msg.mediaData.xhsNote,status:'ready',note:{url:'https://www.xiaohongshu.com/explore/test',title:'让角色读到笔记里的每一张图片',author:'作者',desc:'这里是完整正文。卡片保留摘要，角色可以读取正文和公开评论。',likedCount:'1,773',commentCount:'522',collectedCount:'942',images:Array.from({length:5},(_,i)=>({url:'https://ci.xiaohongshu.com/'+i,ref:'media-store://'+i})),imageCount:5,comments:[{user:'读者',content:'评论'}],warnings:[]}};
 render();await wait();await wait();
 const card=document.querySelector('#root>div');
 check(card.getBoundingClientRect().width<=document.documentElement.clientWidth,'mobile overflow');
 check(document.querySelector('img').src.startsWith('blob:'),'cover from local media');
 check(document.body.textContent.includes('5/5 张配图'),'all-image count');
 check(document.querySelector('a').target==='_blank' && document.querySelector('a').rel.includes('noopener'),'safe original link');
 check(!document.querySelector('[role=status]'),'loading placeholder removed');
 window.captureReady=true;
 await new Promise(resolve=>window.finishCapture=resolve);
 msg.mediaData.xhsNote.status='partial';msg.mediaData.xhsNote.error='第二张图暂时无法读取';render();await wait();
 check(document.querySelector('[role=status]').textContent.includes('第二张'),'partial failure notice');
 document.querySelector('button').click();check(window.retried,'retry button');
 msg.mediaData.xhsNote={sourceUrl:'https://xhslink.cn/o/test',status:'failed',error:'原链接需要登录'};render();await wait();
 check(document.querySelector('a').href==='https://xhslink.cn/o/test','original link retained on failure');
 window.browserResult={passed:true};
})().catch(e=>window.browserResult={passed:false,error:String(e)});
`;
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;padding:28px;background:#f7f5f2;font-family:system-ui}#root{display:flex;justify-content:flex-end}</style><div id="root"></div><script>${boot.replace(/<\/script/gi,'<\\/script')}</script>`);
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
            await fs.writeFile(path.join(out,'card-mobile.png'),Buffer.from(shot.data,'base64'));
            captured=true;await evaluate('window.finishCapture();true');
        }
        result=JSON.parse(await evaluate('JSON.stringify(window.browserResult||null)')||'null');if(result)break;
        await new Promise(r=>setTimeout(r,100));
    }
    if(!result?.passed)throw Error(JSON.stringify(result||{error:'browser timed out'}));
    console.log('PASS real React/mobile Chromium: loading, local cover, counts, original link, partial failure, retry, failed-link fallback');
} finally {
    socket?.close();child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    await fs.rm(profile,{recursive:true,force:true});
}
