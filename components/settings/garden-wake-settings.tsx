"use client";
import {useEffect,useState} from "react";
import {loadCharacters} from "@/lib/character-storage";
import {loadGardenWakeKey,saveGardenWakeKey,enableGardenWakeReceive,gardenWakeRequest,type GardenWakeStatus} from "@/lib/garden-wake-client";
import type {McpServerConfig} from "@/lib/settings-types";
export function GardenWakeSettings({server}:{server:McpServerConfig}){
 const [state,setState]=useState<GardenWakeStatus>();const [characterId,setCharacter]=useState("");const [mode,setMode]=useState<"auto"|"receive">("auto");const [token,setToken]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 const [pairKey,setPairKey]=useState(()=>loadGardenWakeKey());
 const [characters]=useState(()=>loadCharacters());
 useEffect(()=>{let alive=true;void gardenWakeRequest({action:"status"}).then(s=>{if(!alive)return;setState(s);setCharacter(s.config?.characterId||"");setMode(s.config?.mode||"auto");}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
 async function act(action:string){saveGardenWakeKey(pairKey);setBusy(true);setError("");try{
  const s=await gardenWakeRequest({action,...(action==="save"?{characterId,mode,serverId:server.id,token:token||server.accessToken||server.headers?.Authorization||""}:{})});setState(s);setToken("");if(action==="save"||action==="start")enableGardenWakeReceive(true);if(action==="clear")enableGardenWakeReceive(false);
 }catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}
 const cls="min-h-10 w-full rounded-lg border border-black/15 bg-transparent px-3 text-sm dark:border-white/20";
 return <section className="flex flex-col gap-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
 <strong className="text-sm">花园事件唤醒</strong>
 <p role="status" className="text-xs">{state?({connected:"已连接",connecting:"正在连接",stopped:"已停止"}[state.status]||state.status):"正在读取状态"} · 待处理 {state?.pending||0} 条</p>
 <label className="menu-desc">本机唤醒连接码<input className={cls} type="password" autoComplete="off" value={pairKey} onChange={e=>setPairKey(e.target.value)} placeholder="首次填写 VPS 提供的私有连接码"/></label>
 <label className="menu-desc">唤醒角色<select className={cls} value={characterId} onChange={e=>setCharacter(e.target.value)}><option value="">请选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label className="menu-desc">处理方式<select className={cls} value={mode} onChange={e=>setMode(e.target.value as "auto"|"receive")}><option value="auto">自动交给角色处理（Float 运行时）</option><option value="receive">仅接收至聊天，不自动调用</option></select></label>
 <label className="menu-desc">花园 Machine Token<input className={cls} type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder={state?.config?.hasToken?"已保存，留空保留或使用当前 MCP Token":"留空使用当前 MCP 的 Token"}/></label>
 <p className="menu-desc">VPS 收到事件后暂存；手机锁屏或关闭后，下次打开 Float 再处理，不代表离线运行角色。Token 仅存本机服务端，不发送给模型。保存配置会停止旧连接，请手动启动。</p>
 <p className="menu-desc">断线后停止，不自动重连。配置与启动不会替你发帖；自动处理时角色仍可按现有工具权限调用花园。</p>
 {(error||state?.lastError)&&<p role="alert" className="text-xs text-red-500">{error||state?.lastError}</p>}
 <div className="flex flex-wrap gap-2">{[["save","保存配置"],["start","启动连接"],["stop","停止连接"],["status","刷新状态"],["clear","清除配置及待处理事件"]].map(([action,label])=><button key={action} type="button" disabled={busy||(action==="save"&&!characterId)||(action==="start"&&(!state?.config||state.config.characterId!==characterId||state.config.mode!==mode||state.config.serverId!==server.id||Boolean(token)))} onClick={()=>{if(action!=="clear"||window.confirm("清除唤醒配置和待处理事件？"))void act(action);}} className="min-h-10 rounded-lg bg-black/10 px-3 text-xs disabled:opacity-40 dark:bg-white/10">{label}</button>)}</div>
 </section>;
}
