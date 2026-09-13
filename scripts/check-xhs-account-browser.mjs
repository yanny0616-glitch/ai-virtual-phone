// Real React component + generated Tailwind CSS in mobile Chromium. No model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compile } from 'tailwindcss';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'out/review-xhs-account');
await fs.mkdir(out, { recursive: true });
const read = file => fs.readFile(path.join(root, file), 'utf8');
const source = await read('components/settings/xhs-account-settings.tsx');
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
const React=require('react'),root=require('react-dom/client').createRoot(document.getElementById('root')),Card=require('card').XhsAccountSettings;
let state='unconfigured';const requests=[];
window.fetch=async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);if(body.action==='save')state='ready';if(body.action==='clear')state='unconfigured';return {ok:true,json:async()=>({state,configured:state!=='unconfigured',message:state==='ready'?'已登录，搜索与账号操作可用':state==='expired'?'登录已失效，公开链接仍可读':'公开链接可读，搜索未登录'})};};
const wait=()=>new Promise(r=>setTimeout(r,120));const check=(value,label)=>{if(!value)throw Error(label)};
const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
(async()=>{
root.render(React.createElement(Card));await wait();await wait();
check(document.querySelector('#root').textContent.includes('搜索未登录'),'unconfigured status');
const input=document.querySelector('input');check(input.type==='password','masked cookie field');
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'a1=test; web_session=secret-test');input.dispatchEvent(new Event('input',{bubbles:true}));await wait();
check(!button('保存').disabled,'save enabled');button('保存').click();await wait();await wait();
check(document.querySelector('#root').textContent.includes('已登录'),'ready status');check(input.value==='','cookie field cleared');check(!document.querySelector('#root').textContent.includes('secret-test'),'cookie not echoed');
state='expired';button('重新检测').click();await wait();check(document.querySelector('#root').textContent.includes('登录已失效'),'expired status');
check(document.querySelector('section').getBoundingClientRect().width<=document.documentElement.clientWidth,'mobile width');
window.captureReady=true;await new Promise(r=>window.finishCapture=r);
button('清除').click();await wait();check(document.querySelector('#root').textContent.includes('搜索未登录'),'cleared status');
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
            await fs.writeFile(path.join(out,'account-mobile.png'),Buffer.from(shot.data,'base64'));
            captured=true;await evaluate('window.finishCapture();true');
        }
        result=JSON.parse(await evaluate('JSON.stringify(window.browserResult||null)')||'null');if(result)break;
        await new Promise(r=>setTimeout(r,100));
    }
    if(!result?.passed)throw Error(JSON.stringify(result||{error:'browser timed out'}));
    console.log('PASS real React/mobile Chromium: masked Cookie entry, save/reset, login states, clear, mobile layout');
} finally {
    socket?.close();child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    await fs.rm(profile,{recursive:true,force:true});
}
