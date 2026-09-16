import {kvGet,kvSet} from "./kv-db";
const PAIR_KEY="float_garden_wake_pair_key";
export function loadToolEventKey(){return typeof window!=="undefined"?window.localStorage.getItem(PAIR_KEY)||"":"";}
export function saveToolEventKey(key:string){window.localStorage.setItem(PAIR_KEY,key.trim());}
const KEY="float_garden_wake_receive_v1";
export const toolEventEnabled=()=>kvGet(KEY)==="true";
export function enableToolEventReceive(enabled:boolean){kvSet(KEY,String(enabled));}
export type ToolEventEvent={id:string;messageId:string;sourceId:string;serverUrl:string;characterId:string;serverId:string;mode:"auto"|"receive"|"server";message:string;reason:string;createdAt:string};
export type ToolEventStatus={status:string;lastError:string;pending:number;config:null|{characterId:string;serverId:string;mode:"auto"|"receive"|"server";hasToken:boolean;serverUrl:string;adapter:"garden"|"webhook"};ingressToken?:string;sourceId?:string;acceptedIds?:string[];events?:ToolEventEvent[];sources?:{serverId:string;characterId:string;mode:"auto"|"receive"|"server";adapter:"garden"|"webhook";serverUrl:string;status:string;lastError:string}[]};
export async function toolEventRequest(body:Record<string,unknown>):Promise<ToolEventStatus>{
 const res=await fetch("/api/tool-events",{method:"POST",headers:{"Content-Type":"application/json","x-float-events-key":loadToolEventKey()},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const data=await res.json();if(!res.ok)throw Error(data.error||"唤醒服务请求失败");return data;
}
