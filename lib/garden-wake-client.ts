import {kvGet,kvSet} from "./kv-db";
const KEY="float_garden_wake_receive_v1";
export const gardenWakeEnabled=()=>kvGet(KEY)==="true";
export function enableGardenWakeReceive(enabled:boolean){kvSet(KEY,String(enabled));}
export type GardenWakeEvent={id:string;characterId:string;serverId:string;mode:"auto"|"receive";message:string;reason:string;createdAt:string};
export type GardenWakeStatus={status:string;lastError:string;pending:number;config:null|{characterId:string;serverId:string;mode:"auto"|"receive";hasToken:boolean};acceptedIds?:string[];events?:GardenWakeEvent[]};
export async function gardenWakeRequest(body:Record<string,unknown>):Promise<GardenWakeStatus>{
 const res=await fetch("/api/garden-wake",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const data=await res.json();if(!res.ok)throw Error(data.error||"唤醒服务请求失败");return data;
}
