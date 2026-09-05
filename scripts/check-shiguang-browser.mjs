// Lightweight component + IndexedDB browser check; does not build the Next app.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/shiguang-browser-check");
await fs.mkdir(out, { recursive: true });
const fixtureDir = path.join(root, "scripts/fixtures/shiguang");
await fs.writeFile(path.join(out, "ts-loader.cjs"), `const ts = require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`);
await fs.writeFile(path.join(out, "css-loader.cjs"), 'module.exports=function(){return "";};');
const { webpack } = require("next/dist/compiled/webpack/webpack");
await new Promise((resolve, reject) => webpack({
    mode: "development", devtool: false, context: root,
    entry: path.join(fixtureDir, "browser.tsx"),
    output: { path: out, filename: "test.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: {
        "@/lib/shiguang-summarizer$": path.join(fixtureDir, "summary.ts"),
        "@/lib/short-term-assembler$": path.join(fixtureDir, "timeline.ts"),
        "@/lib/chat-storage$": path.join(fixtureDir, "chat.ts"),
        [path.join(root, "lib/kv-db")]: path.join(fixtureDir, "kv.ts"),
        "@": root,
    } },
    module: { rules: [ { test: /\.tsx?$/, exclude: /node_modules/, use: path.join(out, "ts-loader.cjs") }, { test: /\.css$/, use: path.join(out, "css-loader.cjs") } ] },
}, (err, stats) => err || stats.hasErrors() ? reject(err || new Error(stats.toString({ all:false, errors:true }))) : resolve()));
const css = await fs.readFile(path.join(root, "components/memory/shiguang.css"), "utf8");
await fs.writeFile(path.join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:sans-serif}button,input,textarea{font:inherit}${css}</style></head><body><div id="root"></div><script src="test.js"></script></body></html>`);
const profile = await fs.mkdtemp(path.join(out, "profile-"));
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
    let port;
    for (let i=0;i<100;i++) {
        try { port = Number((await fs.readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]); break; } catch { await new Promise(r=>setTimeout(r,100)); }
    }
    if (!port) throw new Error("Chromium did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
    await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
    const pending = new Map(); let serial=0;
    socket.onmessage = event => { const msg=JSON.parse(event.data); if(msg.id){const task=pending.get(msg.id);pending.delete(msg.id);if(msg.error)task.reject(new Error(msg.error.message));else task.resolve(msg.result);} };
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    await send("Page.enable");
    for (const [width,theme] of [[320,"light"],[390,"light"],[736,"dark"]]) {
        await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:true});
        await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:theme}]});
        await send("Page.navigate",{url:`file://${out}/index.html?w=${width}&theme=${theme}`});
        let report;
        for(let i=0;i<150;i++) {
            const result=await send("Runtime.evaluate",{expression:"JSON.stringify(window.shiguangCheck || null)",returnByValue:true});
            report=JSON.parse(result.result.value || "null");
            if(report)break;
            await new Promise(r=>setTimeout(r,100));
        }
        if(!report?.passed) throw new Error(JSON.stringify(report || {error:"browser check timed out"}));
        const shot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true});
        await fs.writeFile(path.join(out,`${width}-${theme}.png`),Buffer.from(shot.data,"base64"));
        console.log(`${width}px ${theme}: ${report.checks} browser checks passed`);
    }
} finally {
    socket?.close(); child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit",resolve); });
    await fs.rm(profile,{recursive:true,force:true});
}
