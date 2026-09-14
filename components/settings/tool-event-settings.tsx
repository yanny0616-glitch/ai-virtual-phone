"use client";
import {useEffect,useState} from "react";
import {loadCharacters} from "@/lib/character-storage";
import {loadToolEventKey,saveToolEventKey,enableToolEventReceive,toolEventRequest,type ToolEventStatus} from "@/lib/tool-event-client";
import type {McpServerConfig} from "@/lib/settings-types";
export function ToolEventSettings({server}:{server:McpServerConfig}){
 const isGarden=server.url.replace(/\/$/,"")==="https://galatea.abysslumina.com/mcp";
 const [state,setState]=useState<ToolEventStatus>();const [characterId,setCharacter]=useState("");const [mode,setMode]=useState<"auto"|"receive">("auto");const [adapter,setAdapter]=useState<"garden"|"webhook">(isGarden?"garden":"webhook");
 const [token,setToken]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [pairKey,setPairKey]=useState(()=>loadToolEventKey());const [characters]=useState(()=>loadCharacters());
 useEffect(()=>{let alive=true;void toolEventRequest({action:"status",serverId:server.id}).then(s=>{if(!alive)return;setState(s);setCharacter(s.config?.characterId||"");setMode(s.config?.mode||"auto");setAdapter(s.config?.adapter||(isGarden?"garden":"webhook"));}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[server.id,isGarden]);
 async function act(action:string){saveToolEventKey(pairKey);setBusy(true);setError("");try{
  const s=await toolEventRequest({action,serverId:server.id,...(action==="save"?{characterId,mode,adapter,serverUrl:server.url,token:adapter==="garden"?(token||server.accessToken||Object.entries(server.headers||{}).find(([k])=>k.toLowerCase()==="authorization")?.[1]||""):undefined}:{})});
  setState(s);setToken("");if(action==="save"||action==="start")enableToolEventReceive(true);
 }catch(e){setError(e instanceof Error?e.message:"操作失败");}finally{setBusy(false);}}
 async function copyAdapter(){try{await navigator.clipboard.writeText(JSON.stringify({url:`${window.location.origin}/api/tool-events/ingest`,headers:{Authorization:`Bearer ${state?.ingressToken}`},body:{version:1,sourceId:server.id,eventId:"每条事件的唯一ID；重试使用原ID",reason:"notification",message:"交给角色的事件文本"}},null,2));}catch{setError("复制失败，请从下方手动复制。");}}
 const cls="min-h-10 w-full rounded-lg border border-black/15 bg-transparent px-3 text-sm dark:border-white/20";
 const changed=!state?.config||state.config.characterId!==characterId||state.config.mode!==mode||state.config.adapter!==adapter||state.config.serverUrl!==server.url||Boolean(token);
 return <details className="rounded-xl border border-black/10 p-3 dark:border-white/10">
 <summary className="cursor-pointer text-sm font-medium">事件唤醒（可选）</summary>
 <div className="mt-3 flex flex-col gap-2">
 <p role="status" className="text-xs">{state?({connected:"已启用",connecting:"正在连接",stopped:"已停止"}[state.status]||state.status):"正在读取状态"} · 本来源待处理 {state?.pending||0} 条</p>
 <label className="menu-desc">本机连接码<input className={cls} type="password" autoComplete="off" value={pairKey} onChange={e=>setPairKey(e.target.value)} placeholder="沿用原花园唤醒连接码"/></label>
 <label className="menu-desc">事件接入方式<select className={cls} value={adapter} onChange={e=>setAdapter(e.target.value as "garden"|"webhook")}><option value="webhook">通用 Webhook（外部适配器投递）</option>{isGarden&&<option value="garden">花园唤醒桥</option>}</select></label>
 <label className="menu-desc">目标角色<select className={cls} value={characterId} onChange={e=>setCharacter(e.target.value)}><option value="">请选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <label className="menu-desc">处理方式<select className={cls} value={mode} onChange={e=>setMode(e.target.value as "auto"|"receive")}><option value="auto">自动交给角色处理（Float 运行时）</option><option value="receive">仅接收至聊天，不自动调用</option></select></label>
 {adapter==="garden"&&<label className="menu-desc">花园 Machine Token<input className={cls} type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder={state?.config?.hasToken?"已保存；留空保留或复用当前 MCP Token":"留空使用当前 MCP Token"}/></label>}
 <p className="menu-desc">每个 MCP 来源独立配置，不自动开启。VPS 暂存事件，Float 打开后交给角色；不代表手机关闭时仍能执行模型或工具。修改配置后需保存并重新启动。</p>
 <p className="menu-desc">{adapter==="garden"?"花园断线后停止，需手动恢复。":"Webhook 需要服务或适配器主动投递；配置它不会让一个只提供工具的 MCP 自动产生事件。"}</p>
 {(error||state?.lastError)&&<p role="alert" className="text-xs text-red-500">{error||state?.lastError}</p>}
 <div className="flex flex-wrap gap-2">{[["save","保存配置"],["start","启动"],["stop","停止"],["status","刷新状态"],...(adapter==="webhook"?[["credentials","获取本来源投递配置"]]:[]),["clear","删除本来源配置及待处理事件"]].map(([action,label])=><button key={action} type="button" disabled={busy||(action==="save"&&!characterId)||(action==="start"&&changed)} onClick={()=>{if(action!=="clear"||window.confirm("仅删除这个来源的唤醒配置和待处理事件？"))void act(action);}} className="min-h-10 rounded-lg bg-black/10 px-3 text-xs disabled:opacity-40 dark:bg-white/10">{label}</button>)}</div>
 {state?.ingressToken&&<div className="flex flex-col gap-2"><p className="menu-desc">仅交给这个来源的适配器，不要发给模型。它不能选择角色或管理其他来源。</p><input aria-label="投递端点" className={cls} readOnly value={`${window.location.origin}/api/tool-events/ingest`}/><input aria-label="来源 ID" className={cls} readOnly value={server.id}/><input aria-label="投递密钥" className={cls} type="password" readOnly value={state.ingressToken}/><button type="button" className="ui-btn" onClick={()=>void copyAdapter()}>复制适配器配置</button></div>}
 </div></details>;
}
