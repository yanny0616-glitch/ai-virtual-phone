"use client";
import {useEffect} from "react";
import {hydrateKvDb} from "@/lib/kv-db";
import {gardenWakeEnabled,gardenWakeRequest} from "@/lib/garden-wake-client";
import {loadCharacters} from "@/lib/character-storage";
import {loadMcpServers} from "@/lib/tool-storage";
import {addChatContact,loadChatContacts,createOrGetSession,hydrateChatStorage,upsertImportedChatMessageAsync,CHAT_REQUEST_REPLY_EVENT} from "@/lib/chat-storage";
import {isBackgroundReplyGenerating,requestBackgroundChatReply} from "@/lib/follow-up-service";
let running=false;
export async function receiveGardenWakes(){
 if(running)return;running=true;
 try{
  await hydrateKvDb();if(!gardenWakeEnabled())return;
  await hydrateChatStorage();
  const state=await gardenWakeRequest({action:"events"});
  for(const event of state.events||[]){
   if(!loadCharacters().some(c=>c.id===event.characterId))continue;
   if(!loadMcpServers().some(s=>s.id===event.serverId&&s.enabled&&s.url.replace(/\/$/,"")==="https://galatea.abysslumina.com/mcp"))continue;
   if(!loadChatContacts().some(c=>c.characterId===event.characterId))addChatContact(event.characterId);
   const session=createOrGetSession(event.characterId);
   if(isBackgroundReplyGenerating(session.id))continue;
   await upsertImportedChatMessageAsync({id:`garden_wake_${event.id}`,sessionId:session.id,role:"user",content:event.message,status:"sent",createdAt:event.createdAt},{insertByCreatedAt:true});
   // Acknowledge durable inbound delivery before running tools: failed generation is never replayed automatically.
   const ack=await gardenWakeRequest({action:"ack",ids:[event.id]});
   if(!ack.acceptedIds?.includes(event.id))continue;
   window.dispatchEvent(new CustomEvent("chat-messages-updated",{detail:{sessionId:session.id}}));
   if(event.mode!=="auto")continue;
   const detail={source:"garden_wake",sessionId:session.id,characterId:event.characterId,handled:false,busy:false};
   window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT,{detail}));
   if(!detail.handled){detail.handled=true;await requestBackgroundChatReply(session.id);}
  }
 }catch{/* Configuration panel exposes transport status; leave unacknowledged events queued. */}
 finally{running=false;}
}
export function GardenWakeScheduler(){
 useEffect(()=>{
  let disposed=false;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{if(disposed)return;if(document.visibilityState==="visible"){
   if(navigator.locks)await navigator.locks.request("float-garden-wake",{ifAvailable:true},lock=>lock?receiveGardenWakes():undefined);
   else await receiveGardenWakes();
  }if(!disposed)timer=setTimeout(poll,20000);};
  timer=setTimeout(poll,3000);
  return()=>{disposed=true;clearTimeout(timer);};
 },[]);
 return null;
}
