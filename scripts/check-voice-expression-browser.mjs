// Full VoiceSettings component with project CSS in isolated Chromium; fixture data only.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/voice-expression-browser");
await fs.mkdir(out, { recursive: true });
const sources = {
  react: "node_modules/react/cjs/react.production.js",
  "react/jsx-runtime": "node_modules/react/cjs/react-jsx-runtime.production.js",
  "react-dom": "node_modules/react-dom/cjs/react-dom.production.js",
  "react-dom/client": "node_modules/react-dom/cjs/react-dom-client.production.js",
  scheduler: "node_modules/scheduler/cjs/scheduler.production.js",
  "@/lib/voice-expression": "lib/voice-expression.ts",
  "./bilingual-text": "lib/bilingual-text.ts",
  "@/components/ui/form": "components/ui/form.tsx",
  "./voice-expression-settings": "components/settings/voice-expression-settings.tsx",
  "@/components/ui/modal": "components/ui/modal.tsx",
  "@/components/ui/feedback": "components/ui/feedback.tsx",
  "lucide-react": "node_modules/lucide-react/dist/cjs/lucide-react.js",
  panel: "components/settings/voice-settings.tsx",
};
const modules = [];
for (const [id, file] of Object.entries(sources)) {
  let code = await fs.readFile(path.join(root, file), "utf8");
  if (file.endsWith(".ts") || file.endsWith(".tsx")) code = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  modules.push(`${JSON.stringify(id)}:function(module,exports,require){${code}\n}`);
}
modules.push('"../phone-settings-app":function(module,exports,require){exports.SettingsContext=require("react").createContext({setSubpageRightAction(){}});}');
modules.push('"@/lib/settings-storage":function(module,exports){exports.loadVoiceConfigs=()=>JSON.parse(localStorage.getItem("voices")||"[]");exports.saveVoiceConfigs=configs=>localStorage.setItem("voices",JSON.stringify(configs));}');
modules.push('"@/lib/tts-service":function(module,exports){exports.synthesizeChatSpeech=async()=>{throw Error("Audio API disabled in UI fixture");};}');
const test = String.raw`
const R=require('react'),Client=require('react-dom/client'),Panel=require('panel').VoiceSettings;
const defaults=require('@/lib/voice-expression').DEFAULT_VOICE_EXPRESSION_PROMPT;
const fixtures=[{id:'a',name:'MiniMax 语音',provider:'Minimax',model:'speech-2.8-hd',defaultVoice:'male-qn-qingse',apiKey:'',enableTTS:true},{id:'b',name:'其他配置',provider:'Minimax',model:'speech-02-hd',defaultVoice:'male-qn-qingse',apiKey:'',enableTTS:true}];
localStorage.setItem('voices',JSON.stringify(fixtures));
let root;
window.mount=()=>{root?.unmount();root=Client.createRoot(document.getElementById('root'));root.render(R.createElement(Panel));};
window.mount();
(async()=>{
 let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const pause=()=>new Promise(r=>setTimeout(r,80));
 const input=async(el,v)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));await pause();};
 const configs=()=>JSON.parse(localStorage.getItem('voices'));
 const toggle=()=>document.querySelector('[role=switch][aria-label="自然语音表达"]');
 const open=async name=>{document.querySelector('[aria-label="编辑 '+name+'"]').click();await pause();};
 await pause();await open('MiniMax 语音');
 check(!document.querySelector('textarea'),'legacy config starts disabled');
 check(toggle().classList.contains('ui-toggle'),'uses host Toggle');
 check(getComputedStyle(toggle()).width==='40px','project toggle CSS loaded');
 toggle().click();await pause();
 check(configs()[0].speechExpressionEnabled===true,'actual settings persist toggle');
 check(!configs()[1].speechExpressionEnabled,'other profile preserved');
 let area=document.querySelector('textarea');
 check(area.value===defaults,'default prompt shown');
 check(document.querySelector('label[for="'+area.id+'"]').textContent==='表达提示词','textarea label association');
 check(area.maxLength===2000,'prompt size limit');
 check(getComputedStyle(area).borderRadius===getComputedStyle(document.querySelector('.ui-input')).borderRadius,'same rounded input style');
 check(parseFloat(getComputedStyle(area).fontSize)<14,'host compact typography');
 check(!document.querySelector('input[type=checkbox]'),'no native blue checkbox');
 await input(area,'说话温柔、自然，少用笑声。');
 check(configs()[0].speechExpressionPrompt==='说话温柔、自然，少用笑声。','prompt persisted');
 window.mount();await pause();await open('MiniMax 语音');
 check(document.querySelector('textarea').value==='说话温柔、自然，少用笑声。','remount restores saved prompt');
 toggle().click();await pause();
 check(!document.querySelector('textarea'),'disable hides options');
 check(configs()[0].speechExpressionPrompt==='说话温柔、自然，少用笑声。','disable retains preference');
 toggle().click();await pause();
 const reset=[...document.querySelectorAll('button')].find(b=>b.textContent==='恢复默认');
 check(reset.classList.contains('ui-link-btn'),'uses host link button');
 reset.click();await pause();
 check(document.querySelector('textarea').value===defaults,'reset restores default');
 check(configs()[0].speechExpressionPrompt===undefined,'reset removes override');
 const body=document.querySelector('.modal-body');
 const row=toggle().closest('.ui-toggle-row');
 body.scrollTop=row.offsetTop-body.offsetTop-12;await pause();
 check(document.body.scrollWidth<=innerWidth,'no horizontal overflow');
 check(row.getBoundingClientRect().left>=0&&row.getBoundingClientRect().right<=innerWidth,'toggle fits viewport');
 check(document.querySelectorAll('[aria-label="自然语音表达"]').length===1,'one profile editor visible');
 window.visualReady=true;
 return {passed:true,checks};
})().then(r=>window.statusCheck=r,e=>window.statusCheck={passed:false,error:String(e.stack||e)});
`;
const bundle = `const modules={${modules.join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}\n${test}`;
await fs.writeFile(path.join(out, "bundle.js"), bundle);
const cssDir = process.env.FLOAT_UI_CSS_DIR || "/opt/float/current/.next/static/css";
const cssFiles = (await fs.readdir(cssDir)).filter(name => name.endsWith(".css")).sort();
if (!cssFiles.length) throw Error("Set FLOAT_UI_CSS_DIR to existing compiled project CSS; do not run a Next build locally.");
for (const name of cssFiles) await fs.copyFile(path.join(cssDir, name), path.join(out, name));
const cssLinks = cssFiles.map(name => `<link rel="stylesheet" href="${name}">`).join("");
await fs.writeFile(path.join(out, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>语音 API 配置预览</title>${cssLinks}<div id="root" class="p-4"></div><script src="bundle.js"></script>`);
const profile = await fs.mkdtemp(path.join(out, "profile-"));
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let i=0;i<100;i++) { try { port=Number((await fs.readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  if(!port)throw Error('Chromium did not start');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const pending=new Map();let serial=0;
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const t=pending.get(m.id);pending.delete(m.id);if(m.error)t.reject(Error(m.error.message));else t.resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  await send('Page.enable');
  for(const width of [320,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:`file://${out}/index.html?w=${width}`});
    // Each viewport starts with an empty isolated fixture.
    await send('Runtime.evaluate',{expression:'localStorage.clear()'});
    await send('Page.reload');
    let report;
    for(let i=0;i<150;i++){
      const result=await send('Runtime.evaluate',{expression:'JSON.stringify(window.statusCheck||null)',returnByValue:true});
      report=JSON.parse(result.result.value||'null');if(report)break;await new Promise(r=>setTimeout(r,100));
    }
    if(!report?.passed)throw Error(JSON.stringify(report||{error:'Browser test timed out'}));
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await fs.writeFile(path.join(out,`${width}.png`),Buffer.from(shot.data,'base64'));
    console.log(`${width}px: ${report.checks} browser checks passed`);
  }
}finally{
  socket?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
  await fs.rm(profile,{recursive:true,force:true});
}
