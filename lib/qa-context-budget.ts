import type { QaContextEntry } from "./qa-agent-engine";

// A planning weight in character-equivalent units, not provider-billed tokens.
// Images are image blocks, not millions of base64 characters of text.
export const QA_IMAGE_CONTEXT_WEIGHT = 4096;
export function estimateQaEntryChars(entry:QaContextEntry):number {
    let total=entry.content.length;
    for(const file of entry.files ?? [])total+=file.name.length+file.content.length;
    total+=(entry.images?.length ?? 0)*QA_IMAGE_CONTEXT_WEIGHT;
    for(const call of entry.toolCalls ?? [])total+=call.name.length+JSON.stringify(call.args ?? {}).length;
    return total;
}
export function shouldCompactBeforeQaTurn(current:number,incoming:number,budget:number):boolean {
    return current>0 && (current>=budget || (incoming<budget && current+incoming>=budget));
}
