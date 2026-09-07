// 一轮 = 用户说完、角色答了。角色连发几条气泡只算一轮，和宿主旧口径一致。

export function isTextMessage(message) {
  return !!message && !message.isRetracted && (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string" && message.content.trim().length > 0;
}

export function countRounds(messages) {
  let count = 0, last = "";
  for (const message of messages) {
    if (!isTextMessage(message)) continue;
    if (message.role === "assistant" && last === "user") count++;
    last = message.role;
  }
  return count;
}

/** 按字数切一批待整理消息，不在用户提问和角色回答之间下刀。 */
export function sliceBatch(messages, maxChars = 24000) {
  let count = 0, size = 0;
  for (const message of messages) {
    const previous = messages[count - 1];
    const answering = previous && previous.role === "user" && message.role === "assistant";
    if (count >= 2 && size + message.content.length > maxChars && !answering) break;
    count++; size += message.content.length;
  }
  return messages.slice(0, count);
}
