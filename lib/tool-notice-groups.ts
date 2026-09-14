import type { ChatMessage } from "./chat-storage";

// 一轮工具调用会在通知之间夹着不渲染的消息（原生 tool call 占位、tool 结果），isHidden 说哪些消息不显示，它们不打断分组
export function groupToolNotices<T extends Pick<ChatMessage,"id"|"mediaType"|"content">>(messages: T[], isHidden?: (msg: T) => boolean) {
    const groups=new Map<number,T[]>(), members=new Set<number>();
    let start=-1; let notices:T[]=[];
    const flush=()=>{if(notices.length>0){groups.set(start,notices);}start=-1;notices=[];};
    for(let i=0;i<messages.length;i++) {
        const msg=messages[i];
        if(msg.mediaType==="tool_call" || msg.mediaType==="tool_result" || (isHidden?.(msg) && msg.mediaType!=="tool_notice"))continue;
        if(msg.mediaType!=="tool_notice") {flush();continue;}
        if(start<0)start=i;
        else members.add(i);
        notices.push(msg);
    }
    flush();return {groups,members};
}
