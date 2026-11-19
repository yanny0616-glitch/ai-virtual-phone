// ── 和聊天打通：订单卡片、送达任务、代付、角色点单、把进度告诉角色 ──
// 订单的三种「和角色有关」：
//   recipient = 角色 id、payer = "user"   你给 TA 点
//   recipient = ""、payer = "char"、source = "payreq"     你点、请 TA 代付
//   recipient = ""、payer = "char"、source = "directive"  TA 主动给你点
const ACCENT = "#f5a800";

async function namesFor(charId) {
  if (state.names[charId]) return state.names[charId];
  const [character, profile] = await Promise.all([
    api.characters.get(charId).catch(() => null),
    api.user.getProfile({ characterId: charId }).catch(() => null),
  ]);
  const known = state.characters.find(c => c.id === charId);
  const names = { charName: (character && character.name) || (known && known.name) || "对方", userName: (profile && profile.name) || "你" };
  state.names[charId] = names;
  return names;
}

function itemsText(order) { return (order.items || []).map(it => it.qty > 1 ? `${it.name}×${it.qty}` : it.name).join("、"); }
function issueText(order) { return order.issue && order.issue.text ? `不过${order.issue.text}。` : ""; }
function isDelivered(order, now) { return order.status === "active" && Number(order.deliverAt) > 0 && now >= order.deliverAt; }
function isOnTheWay(order, now) { return order.status === "active" && Number(order.deliverAt) > now; }

function cardSections(order, etaLabel) {
  const rows = (order.items || []).slice(0, 6).map(it => ({ label: it.name, value: `×${it.qty}${it.price ? " · " + yuan(it.price * it.qty) : ""}` }));
  const info = [{ label: "店铺", value: order.shopName }];
  if (etaLabel) info.push({ label: "预计送达", value: etaLabel });
  if (order.note) info.push({ label: "备注", value: order.note });
  info.push({ label: "订单号", value: order.no });
  return [{ title: "餐品", rows }, { title: "配送", rows: info }];
}

/** 付款完成（或角色请客）后开始配送：算时间线、挂送达任务、同步上下文 */
async function startDelivery(order, now) {
  const built = buildTimeline({
    seed: `${order.no}|${order.shopName}|${order.createdAt}`, startAt: now, speed: order.speed || state.settings.speed,
    incidents: state.settings.incidents, items: order.items, scheduledFor: order.scheduledFor || 0, shopFactor: order.shopFactor || 1,
  });
  await patchOrder(order, { status: "active", paidAt: now, speed: order.speed || state.settings.speed, timeline: built.timeline, deliverAt: built.deliverAt, rider: built.rider, issue: built.issue });
  await scheduleArrival(order);
  await syncContext();
  return order;
}

/** 送达那一刻要做的事交给宿主的定时任务：APP 关着也会执行，小手机整个关着则重开后补跑 */
async function scheduleArrival(order) {
  const actions = [];
  const title = order.recipient ? "TA 的外卖送到了" : "外卖到了";
  let body = `${order.shopName}：${itemsText(order)}`;
  let names = null;
  if (order.charId) names = await namesFor(order.charId);
  if (order.recipient && names) body = `给${names.charName}点的 ${body}`;
  actions.push({ type: "notification", title, body: body.slice(0, 120), badgeDelta: 1, data: { orderId: order.id } });
  if (order.cardMessageId) {
    actions.push({ type: "chat.updateCard", messageId: order.cardMessageId, sessionId: order.cardSessionId || "", status: "已送达", sections: cardSections(order, `${hhmm(order.deliverAt)} 已送达`), actions: [{ label: "查看订单" }] });
  }
  if (order.charId && names) {
    actions.push({ type: "chat.history", characterId: order.charId, role: "user", content: arrivalHistory(order, names) });
    if (state.settings.contextOn) actions.push({ type: "chat.setContext", characterId: order.charId, label: "外卖", text: contextText(order.charId, order.deliverAt + 1000, false) });
    if (state.settings.replyOnArrive) actions.push({ type: "chat.reply", characterId: order.charId });
  }
  await api.tasks.schedule({ id: `wm_arrive_${order.id}`, delayMs: Math.max(1000, order.deliverAt - Date.now()), actions });
}
async function cancelArrival(order) { try { await api.tasks.cancel(`wm_arrive_${order.id}`); } catch { /* 任务可能已经跑完 */ } }

function arrivalHistory(order, names) {
  const what = `「${order.shopName}」的外卖（${itemsText(order)}）`;
  const at = hhmm(order.deliverAt);
  if (order.recipient) return `[外卖：${names.userName}给${names.charName}点的${what}已在 ${at} 送到${names.charName}手上。${issueText(order)}]`;
  const how = order.source === "payreq" ? `${names.charName}帮${names.userName}付款的` : `${names.charName}给${names.userName}点的`;
  return `[外卖：${how}${what}已在 ${at} 送到${names.userName}手上。${issueText(order)}]`;
}

/** 你给 TA 点：往聊天里发一张订单卡，记下消息 id 以便送达时改状态 */
async function sendGiftCard(order) {
  const names = await namesFor(order.charId);
  const eta = hhmm(order.deliverAt);
  const sent = await api.chat.sendCard({
    characterId: order.charId, role: "user", historyRole: "user",
    summary: `${names.userName}给${names.charName}点了外卖：${itemsText(order)}，预计 ${eta} 送达。`,
    historyText: `[外卖：${names.userName}给${names.charName}点了「${order.shopName}」的外卖：${itemsText(order)}${order.note ? `；备注：${order.note}` : ""}。预计 ${eta} 送到${names.charName}那里，现在还在路上。]`,
    card: { appLabel: "外卖", title: "给你点了外卖", subtitle: order.shopName, status: "配送中", accentColor: ACCENT, sections: cardSections(order, eta), actions: [{ label: "查看订单" }] },
  });
  await patchOrder(order, { cardMessageId: sent.messageId, cardSessionId: sent.sessionId });
  // 卡片发出去才有消息 id，送达任务要带上它才能把卡片改成「已送达」（同 id 重挂即覆盖）
  await scheduleArrival(order);
}

/** 请 TA 代付：发请求卡并请 TA 回复；TA 用 [外卖代付:同意/拒绝:…] 回应，见 onPayReply */
async function sendPayRequest(order) {
  const names = await namesFor(order.charId);
  const sent = await api.chat.sendCard({
    characterId: order.charId, role: "user", historyRole: "user",
    summary: `${names.userName}请${names.charName}代付外卖 ${yuan(order.total)}：${itemsText(order)}。`,
    historyText: `[外卖代付请求：${names.userName}在「${order.shopName}」点了${itemsText(order)}，一共 ${yuan(order.total)}，想请${names.charName}帮忙付款。${names.charName}愿意就在回复里写 [外卖代付:同意:想说的话]，不愿意就写 [外卖代付:拒绝:想说的话]。]`,
    card: { appLabel: "外卖", title: "帮我付一下外卖", subtitle: order.shopName, body: `合计 ${yuan(order.total)}`, status: "等待代付", accentColor: ACCENT, sections: cardSections(order, ""), actions: [{ label: "查看订单" }] },
  });
  await patchOrder(order, { cardMessageId: sent.messageId, cardSessionId: sent.sessionId });
  await syncContext();
  api.chat.requestReply({ characterId: order.charId }).catch(error => console.warn("[外卖] 请求回复失败", error));
}

async function updateOrderCard(order, patch) {
  if (!order.cardMessageId) return;
  try { await api.chat.updateCard({ messageId: order.cardMessageId, sessionId: order.cardSessionId || "", ...patch }); }
  catch (error) { console.warn("[外卖] 更新卡片失败（卡片可能已被删除）", error); }
}

/** 角色回应代付：对最近一张等这位角色付款的订单生效 */
async function onPayReply(charId, args) {
  const order = state.orders.find(o => o.status === "pending_pay" && o.charId === charId);
  if (!order) return null;
  const verdict = String(args[0] || "");
  const words = String(args[1] || "").trim();
  if (/拒|不|否/.test(verdict) && !/同意|可以|好/.test(verdict)) {
    await patchOrder(order, { status: "pay_declined", payWords: words });
    await updateOrderCard(order, { status: "TA 没有代付", actions: [{ label: "查看订单" }] });
    await api.notifications.create({ title: "代付被婉拒了", body: words || "可以改成自己付，或者取消订单。", badgeDelta: 1, data: { orderId: order.id } }).catch(() => {});
    await syncContext();
    return order;
  }
  await patchOrder(order, { payWords: words });
  await startDelivery(order, Date.now());
  await updateOrderCard(order, { status: "TA 已代付 · 配送中", sections: cardSections(order, hhmm(order.deliverAt)), actions: [{ label: "查看订单" }] });
  await api.notifications.create({ title: "TA 帮你付好了", body: `${order.shopName}，预计 ${hhmm(order.deliverAt)} 送到。`, badgeDelta: 1, data: { orderId: order.id } }).catch(() => {});
  return order;
}

/** 「皮蛋瘦肉粥、煎饺×2」→ [{ name, qty, price }]；价格能在已有店铺里对上就用，对不上记 0（TA 请客，不显示价格） */
function parseDirectiveItems(text, shop) {
  const known = new Map();
  for (const s of shop ? [shop] : allShops()) for (const d of s.dishes) if (!known.has(d.name)) known.set(d.name, d.price);
  return String(text || "").split(/[、，,；;＋+\n]+/).map(part => {
    let name = part.trim(), qty = 1;
    const m = name.match(/^(.*?)[\s]*(?:[×xX*＊]\s*(\d{1,2})|(\d{1,2})\s*[份杯个碗串只盒])$/);
    if (m) { name = m[1].trim(); qty = clamp(Number(m[2] || m[3]) || 1, 1, 20); }
    return name ? { name: name.slice(0, 30), qty, price: known.get(name) || 0 } : null;
  }).filter(Boolean).slice(0, 10);
}

/** 角色用 [点外卖:店铺:餐品:想说的话] 给你点了一份：建单、开始配送、把原卡片改成配送中 */
async function acceptCharOrder({ messageId, sessionId, charId, args }) {
  const existing = state.orders.find(o => o.directiveMessageId === messageId);
  if (existing) return existing;
  if (!charId) throw new Error("不知道是哪位角色点的外卖");
  const shopName = String(args[0] || "").trim().slice(0, 30) || "TA 挑的店";
  const shop = allShops().find(s => s.name === shopName) || null;
  const items = parseDirectiveItems(args[1], shop);
  if (!items.length) throw new Error("这张外卖卡片里没有写餐品");
  const words = String(args[2] || "").trim();
  const now = Date.now();
  const priced = items.every(it => it.price > 0);
  const order = await createOrder({
    no: nextOrderNo(now), shopId: shop ? shop.id : "", shopName, shopFactor: shop ? shop.factor : 1, items,
    subtotal: priced ? items.reduce((s, it) => s + it.price * it.qty, 0) : 0, fee: 0, off: 0, coupon: 0, total: 0,
    recipient: "", charId, payer: "char", source: "directive", note: /^(无|没有|none)$/i.test(words) ? "" : words, address: state.settings.userAddress || "",
    status: "pending_pay", createdAt: now, directiveMessageId: messageId, cardMessageId: messageId, cardSessionId: sessionId || "",
  });
  await startDelivery(order, now);
  await updateOrderCard(order, { status: "配送中", sections: cardSections(order, hhmm(order.deliverAt)), actions: [{ label: "查看订单" }] });
  const names = await namesFor(charId);
  await api.notifications.create({ title: `${names.charName}给你点了外卖`, body: `${shopName}：${itemsText(order)}，预计 ${hhmm(order.deliverAt)} 送到。`, badgeDelta: 1, data: { orderId: order.id } }).catch(() => {});
  return order;
}

async function onChatMessage(payload) {
  const msg = payload && payload.message;
  if (!msg || payload.isGroup || msg.role !== "assistant" || msg.mediaType !== "app_card" || msg.isRetracted) return;
  const data = msg.mediaData || {};
  const args = Array.isArray(data.appDirectiveArgs) ? data.appDirectiveArgs : [];
  if (data.appDirectiveId === "wm-order" && state.settings.autoAccept) {
    await acceptCharOrder({ messageId: msg.id, sessionId: payload.sessionId, charId: payload.characterId, args });
  } else if (data.appDirectiveId === "wm-pay") {
    await onPayReply(payload.characterId, args);
  } else return;
  if (!state.background) render();
}

/**
 * 给某位角色看的外卖近况。precise = true 用「还要几分钟」（当轮现算）；
 * false 只写钟点（常驻那份，写下之后时间还会往前走，不能写相对时间）。
 */
function contextText(charId, now, precise) {
  const names = state.names[charId];
  if (!names) return "";
  const u = names.userName, lines = [];
  for (const o of state.orders) {
    if (o.charId !== charId) continue;
    const what = `「${o.shopName}」的外卖（${itemsText(o)}）`;
    if (o.status === "pending_pay" && o.source === "payreq") {
      lines.push(`${u}请你代付${what}，共 ${yuan(o.total)}，还在等你答复：同意写 [外卖代付:同意:想说的话]，拒绝写 [外卖代付:拒绝:想说的话]。`);
      continue;
    }
    if (o.status !== "active" || !o.deliverAt) continue;
    const mine = o.recipient === charId;            // 送给角色的
    const whose = mine ? `${u}给你点的` : o.source === "payreq" ? `你帮${u}付款的` : `你给${u}点的`;
    if (now < o.deliverAt) {
      const stage = stageAt(o, now);
      const progress = precise ? `现在${stage.label}，${remainText(stage.remainMs)}（预计 ${hhmm(o.deliverAt)}）` : `预计 ${hhmm(o.deliverAt)} 送到，在那之前都还在路上`;
      lines.push(`${whose}${what}还没送到：${progress}。${mine ? "送到之前你还没拿到，也没吃到。" : `${u}还没收到，别问好不好吃。`}`);
    } else if (now - o.deliverAt < 90 * 60000) {
      lines.push(`${whose}${what}已在 ${hhmm(o.deliverAt)} 送到${mine ? "你" : u}手上。${issueText(o)}${o.review && !mine ? `${u}的评价：${o.review.stars} 星${o.review.text ? "，" + o.review.text : ""}。` : ""}`);
    }
  }
  if (!lines.length) return "";
  const favs = favorites("");
  if (favs.length) lines.push(`${u}最近常点：${favs.join("、")}。`);
  if (state.settings.userTaboo) lines.push(`${u}的忌口：${state.settings.userTaboo}。`);
  return lines.join("\n");
}

/** 常驻那份上下文：群聊、线下、云端主动消息用它；普通私聊由下面的 provider 当轮现算 */
let contextChars = new Set();
async function syncContext() {
  if (!api.chat || !api.chat.setContext) return;
  try {
    const now = Date.now(), next = new Set();
    if (state.settings.contextOn) {
      const ids = [...new Set(state.orders.filter(o => o.charId).map(o => o.charId))];
      for (const id of ids) {
        await namesFor(id);
        const text = contextText(id, now, false);
        if (!text) continue;
        await api.chat.setContext({ characterId: id, label: "外卖", text });
        next.add(id);
      }
    }
    for (const id of contextChars) if (!next.has(id)) await api.chat.setContext({ characterId: id, label: "外卖", text: "" });
    contextChars = next;
  } catch (error) { console.warn("[外卖] 同步聊天上下文失败", error); }
}

async function registerChatHooks() {
  if (api.on) api.on("chat.message.created", payload => onChatMessage(payload));
  if (api.chat && api.chat.registerContextProvider) {
    try {
      await api.chat.registerContextProvider(async ({ characterId }) => {
        if (!state.settings.contextOn || !characterId) return "";
        if (!state.names[characterId]) return contextText(characterId, Date.now(), true) || (await namesFor(characterId), contextText(characterId, Date.now(), true));
        return contextText(characterId, Date.now(), true);
      });
    } catch (error) { console.warn("[外卖] 注册当轮上下文失败", error); }
  }
}
