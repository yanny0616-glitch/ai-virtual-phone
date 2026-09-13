import type { ChatMessage } from "./chat-storage";

export function groupToolNotices<T extends Pick<ChatMessage,"id"|"mediaType"|"content">>(messages: T[]) {
    const groups=new Map<number,T[]>(), members=new Set<number>();
    let start=-1; let notices:T[]=[];
    const flush=()=>{if(notices.length>1){groups.set(start,notices);}start=-1;notices=[];};
    for(let i=0;i<messages.length;i++) {
        const msg=messages[i];
        if(msg.mediaType==="tool_call" || msg.mediaType==="tool_result")continue;
        if(msg.mediaType!=="tool_notice") {flush();continue;}
        if(start<0)start=i;
        else members.add(i);
        notices.push(msg);
    }
    flush();return {groups,members};
}
