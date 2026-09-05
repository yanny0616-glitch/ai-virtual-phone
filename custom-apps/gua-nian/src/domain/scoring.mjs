// 输入都是调用时的值；不读取 S、时钟、存储或宿主 SDK。
export function fitScore(localHour) {
  const gaussian = (peak, sigma) => Math.exp(-Math.pow(localHour - peak, 2) / (2 * sigma * sigma));
  return Math.round(100 * Math.min(1, gaussian(13, 3) * 0.75 + gaussian(21, 2.5)));
}

export function calculateScore({ localHour, fireAt, armedBefore, streak, lastArmedAt, quota, maxUnanswered, minGapMin }) {
  const pq = Math.round(Math.min(100, armedBefore / Math.max(1, quota) * 100));
  const pr = Math.round(Math.min(100, maxUnanswered > 0 ? streak / maxUnanswered * 100 : streak * 25));
  let pg = 0;
  if (minGapMin > 0 && lastArmedAt) {
    const distance = (fireAt - lastArmedAt) / 60000;
    if (distance < minGapMin * 2) pg = Math.round(Math.max(0, Math.min(100, (1 - distance / (minGapMin * 2)) * 100)));
  }
  return { fit: fitScore(localHour), pq, pr, pg, press: Math.round(pq * 0.4 + pr * 0.4 + pg * 0.2) };
}

// 消息按时间升序；3 分钟内的气泡归一轮，满 30 分钟才算未回应。
export function countUnansweredRounds(messages, nowMs) {
  let previousTime = null, rounds = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") break;
    if (previousTime === null || previousTime - message.t > 3 * 60000) {
      if (nowMs - message.t >= 30 * 60000) rounds++;
    }
    previousTime = message.t;
  }
  return rounds;
}
