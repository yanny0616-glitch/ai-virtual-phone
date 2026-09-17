import type { ChatMessage } from "./chat-storage";

/** Keep original persisted results. Reduce only the known duplicated play envelope. */
export function compactToolHistory(history: ChatMessage[]): ChatMessage[] {
    let latest=-1;
    for(let i=0;i<history.length;i++)if(history[i].mediaType==="tool_result")latest=i;
    return history.map((message,index)=>{
        if(message.mediaType!=="tool_result" || index===latest)return message;
        const compact=(text:string)=>text.replace(/(<action_result\b[^>]*\bname="play"[^>]*>)([\s\S]*?)(<\/action_result>)/g,(_,open:string,body:string,close:string)=>{
            try{return open+compactPlay(body)+close;}catch{return open+body+close;}
        });
        const native=message.nativeToolResult;
        const content=compact(message.content);
        if(native?.name==="play") {
            try {return {...message,content,nativeToolResult:{...native,content:compactPlay(native.content)}};}catch {return {...message,content};}
        }
        return content===message.content?message:{...message,content};
    });
}

function compactPlay(raw:string):string {
    const data=JSON.parse(raw);
    if(!data || typeof data!=="object" || !Array.isArray(data.logs_since_last_own_action) || !data.room || typeof data.content!=="string" || !("judgment" in data))return raw;
    const copy={...data};
    delete copy.created_at;
    // Retain identifiers, room state and every differing question, answer or hint.
    copy.logs_since_last_own_action=data.logs_since_last_own_action.filter((entry:Record<string,unknown>)=>!(entry.id===data.id && entry.content===data.content && entry.judgment===data.judgment && Object.keys(entry).every(key=>["created_at","updated_at","is_current_ask_result","slot"].includes(key) || JSON.stringify(entry[key])===JSON.stringify(data[key]))));
    if(!copy.logs_since_last_own_action.length)delete copy.logs_since_last_own_action;
    copy.room={...data.room};delete copy.room.created_at;
    return JSON.stringify(copy);
}
