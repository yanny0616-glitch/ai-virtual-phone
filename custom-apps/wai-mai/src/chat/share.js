// ── 拼单（一人一半）、请群聊、把店 / 购物车 / 订单分享给 TA ──

/** 和 TA 拼单：你已经付了一半，发卡片问 TA 要不要出另一半；TA 用 [外卖拼单:同意/拒绝:…] 回应 */
async function sendSplitRequest(order) {
  const names = await namesFor(order.charId);
  const half = round1c(order.total - order.userPaid);
  const sent = await api.chat.sendCard({
    characterId: order.charId, role: "user", historyRole: "user",
    summary: `${names.userName}想和${names.charName}拼单外卖：${itemsText(order)}，一人 ${yuan(half)}。`,
    historyText: `[外卖拼单：${names.userName}在「${order.shopName}」点了${itemsText(order)}，一共 ${yuan(order.total)}，想和${names.charName}一人一半，${names.userName}已经付了自己那 ${yuan(order.userPaid)}。${names.charName}愿意出另一半 ${yuan(half)} 就在回复里写 [外卖拼单:同意:想说的话]，不愿意就写 [外卖拼单:拒绝:想说的话]。]`,
    card: { appLabel: "外卖", title: "一起拼个单？", subtitle: order.shopName, body: `一共 ${yuan(order.total)}，一人 ${yuan(half)}`, status: "等 TA 拼单", accentColor: ACCENT, sections: cardSections(order, ""), actions: [{ label: "查看订单" }] },
  });
  await patchOrder(order, { cardMessageId: sent.messageId, cardSessionId: sent.sessionId });
  await syncContext();
  api.chat.requestReply({ characterId: order.charId }).catch(error => console.warn("[外卖] 请求回复失败", error));
}

async function onSplitReply(charId, args) {
  const order = state.orders.find(o => o.status === "pending_pay" && o.source === "split" && o.charId === charId);
  if (!order) return null;
  const verdict = String(args[0] || ""), words = String(args[1] || "").trim();
  if (/拒|不|否/.test(verdict) && !/同意|可以|好/.test(verdict)) {
    await patchOrder(order, { status: "pay_declined", payWords: words });
    await updateOrderCard(order, { status: "TA 没有拼", actions: [{ label: "查看订单" }] });
    await api.notifications.create({ title: "TA 不想拼这单", body: words || "可以自己补上另一半，或者取消订单。", badgeDelta: 1, data: { orderId: order.id } }).catch(() => {});
    await syncContext();
    return order;
  }
  await patchOrder(order, { payWords: words });
  await startDelivery(order, Date.now());
  await updateOrderCard(order, { status: "拼单成功 · 配送中", sections: cardSections(order, hhmm(order.deliverAt)), actions: [{ label: "查看订单" }] });
  await api.notifications.create({ title: "拼单成功", body: `${order.shopName}，预计 ${hhmm(order.deliverAt)} 送到。`, badgeDelta: 1, data: { orderId: order.id } }).catch(() => {});
  return order;
}

/**
 * 请群聊：宿主不能往群会话里发卡片，所以群里靠不分角色的那份上下文知道这件事（见 groupContextText），
 * 订单页里再请大家各说一句，记在订单上。
 */
async function sendGroupCard(order) {
  let userName = "我";
  try { const profile = await api.user.getProfile(); if (profile && profile.name) userName = profile.name; } catch { /* 读不到就叫「我」 */ }
  await patchOrder(order, { userName });
  await syncContext();
  groupReactions(order).then(() => { if (!state.background) render(); }).catch(error => console.warn("[外卖] 群里的反应没生成出来", error));
}

/** 群里每个人对这顿外卖说一句：[名字:一句话] 一行一个 */
async function groupReactions(order) {
  const members = (order.groupMembers || []).map(id => state.characters.find(c => c.id === id)).filter(Boolean);
  if (!members.length) return [];
  const delivered = Date.now() >= Number(order.deliverAt);
  const instruction = `${order.userName || "我"}在群里请大家吃外卖：「${order.shopName}」的${itemsText(order)}，每人一份。${order.note ? `${order.userName || "我"}说：「${order.note}」。` : ""}${delivered ? "外卖刚送到大家手上。" : `外卖还在路上，预计 ${hhmm(order.deliverAt)} 送到，大家都还没吃到。`}`;
  const record = { appTags: ["waimai", "group"], instruction, historyLimit: 8 };
  let result;
  try { result = await api.ai.generate({ ...record, sessionId: order.groupId }); }
  catch { result = await api.ai.generate({ ...record, characterIds: members.map(c => c.id), groupName: order.groupName }); }   // 群可能被删了
  const text = String(result && result.text || "");
  const talk = [];
  for (const m of text.matchAll(/[\[【]([^:：\]】\n]{1,20})[:：]\s*([^\]】\n]{1,80})[\]】]/g)) {
    const who = members.find(c => c.name === m[1].trim() || m[1].includes(c.name));
    if (who && !talk.some(t => t.id === who.id)) talk.push({ id: who.id, name: who.name, line: m[2].trim() });
  }
  if (!talk.length) throw new Error("没按格式回");
  await patchOrder(order, { groupTalk: talk, groupTalkAt: Date.now() });
  return talk;
}
actions["group-talk"] = async d => {
  const order = state.orders.find(o => o.id === d.id);
  if (!order) return;
  try { await busy("在问群里…", () => groupReactions(order)); render(); }
  catch (error) { fail(error, "群里没人接话"); }
};

// ── 分享给 TA：店、购物车（帮我看看）、订单（晒单）──
let shareDraft = null;
function shareTarget(kind, id) {
  if (kind === "shop") { const shop = shopById(id); return shop ? { kind, shop } : null; }
  if (kind === "cart") { const shop = shopById(state.cart.shopId), items = cartItems(); return shop && items.length ? { kind, shop, items } : null; }
  const order = state.orders.find(o => o.id === id);
  return order ? { kind, order, shop: orderShop(order) } : null;
}
const SHARE_TITLE = { shop: "推荐给 TA", cart: "让 TA 帮我看看", order: "晒给 TA 看" };

actions["share-open"] = d => {
  const target = shareTarget(d.kind, d.id);
  if (!target) return;
  if (!state.characters.length) { toast("还没有角色，先在小手机里创建一个"); return; }
  shareDraft = { kind: d.kind, id: d.id || "", to: shareDraft && state.characters.some(c => c.id === shareDraft.to) ? shareDraft.to : state.characters[0].id, reply: true, words: "" };
  openSheet(SHARE_TITLE[d.kind], shareSheetHtml());
};
function shareSheetHtml() {
  const t = shareTarget(shareDraft.kind, shareDraft.id);
  if (!t) return "";
  const preview = t.kind === "shop"
    ? `${shopCover(t.shop, 36)}<span><b>${esc(t.shop.name)}</b><small>${esc(t.shop.tagline || t.shop.category)}</small></span>`
    : t.kind === "cart"
      ? `${shopCover(t.shop, 36)}<span><b>${esc(t.shop.name)}</b><small>${esc(t.items.map(it => `${it.name}×${it.qty}`).join("、"))}</small></span>`
      : `${shopCover(t.shop, 36)}<span><b>${esc(t.order.shopName)}</b><small>${esc(itemsText(t.order))}${t.order.review ? ` · ${t.order.review.stars} 星` : ""}</small></span>`;
  return `<div class="share-card">${preview}</div>
    <div class="share-to">${state.characters.map(c => `<button type="button" class="${c.id === shareDraft.to ? "on" : ""}" data-act="share-to" data-id="${esc(c.id)}">${avatarHtml(c)}<span>${esc(c.name)}</span></button>`).join("")}</div>
    <input id="share-words" maxlength="60" placeholder="${t.kind === "cart" ? "比如：点这些够不够？" : t.kind === "order" ? "比如：这家真的好吃！" : "比如：下次一起吃这家"}" value="${esc(shareDraft.words)}">
    <div class="frow sw-row" data-act="share-reply"><span class="grow"><b>请 TA 回一句</b><small>发完让 TA 接着说</small></span><button type="button" class="sw${shareDraft.reply ? " on" : ""}" role="switch" aria-checked="${shareDraft.reply}" aria-label="请 TA 回一句"></button></div>
    <button type="button" class="btn" data-act="share-send">发给 ${esc((state.characters.find(c => c.id === shareDraft.to) || {}).name || "TA")}</button>`;
}
const keepWords = () => { const n = $("share-words"); if (n && shareDraft) shareDraft.words = n.value; };
actions["share-to"] = d => { keepWords(); shareDraft.to = d.id; $("sheet-body").innerHTML = shareSheetHtml(); };
actions["share-reply"] = () => { keepWords(); shareDraft.reply = !shareDraft.reply; $("sheet-body").innerHTML = shareSheetHtml(); };
actions["share-send"] = async () => {
  keepWords();
  const t = shareTarget(shareDraft.kind, shareDraft.id), to = shareDraft.to, words = shareDraft.words.trim();
  if (!t || !to) return;
  try {
    await busy("正在发…", async () => {
      const names = await namesFor(to), u = names.userName, c = names.charName;
      const say = words ? `，还说：「${words}」` : "";
      let card, historyText, summary;
      if (t.kind === "shop") {
        const top = t.shop.dishes.filter(x => x.tag).concat(t.shop.dishes).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
        historyText = `[外卖分享：${u}给${c}分享了一家外卖店「${t.shop.name}」（${t.shop.category}，评分 ${t.shop.rating}）：${t.shop.tagline || ""}。招牌有 ${top.map(x => x.name).join("、")}${say}。]`;
        summary = `${u}分享了一家店：${t.shop.name}`;
        card = { appLabel: "外卖", title: "给你看家店", subtitle: t.shop.name, body: t.shop.tagline || t.shop.category, status: `${t.shop.rating} 分`, accentColor: ACCENT,
          sections: [{ title: "招牌", rows: top.map(x => ({ label: x.name, value: yuan(dishPrice(x, t.shop)) })) }] };
      } else if (t.kind === "cart") {
        const p = priceOrder(t.items, t.shop, { pickup: state.mode === "pickup", freeFee: isMember() });
        const list = t.items.map(it => `${it.name}×${it.qty}`).join("、");
        historyText = `[外卖分享：${u}在「${t.shop.name}」挑了 ${list}，大概 ${yuan(p.total)}，还没下单，想听听${c}的意见${say}。]`;
        summary = `${u}想让你帮忙看看：${list}`;
        card = { appLabel: "外卖", title: "帮我看看点这些行不行", subtitle: t.shop.name, body: `大概 ${yuan(p.total)}`, status: "还没下单", accentColor: ACCENT,
          sections: [{ rows: t.items.slice(0, 6).map(it => ({ label: it.name, value: `×${it.qty}` })) }] };
      } else {
        const o = t.order, r = o.review;
        historyText = `[外卖分享：${u}给${c}晒了一单「${o.shopName}」的外卖：${itemsText(o)}${r ? `，打了 ${r.stars} 星${r.text ? `，评价是「${r.text}」` : ""}` : ""}${say}。]`;
        summary = `${u}晒了一单外卖：${o.shopName}`;
        card = { appLabel: "外卖", title: "晒一下这单", subtitle: o.shopName, body: itemsText(o), status: r ? "★".repeat(r.stars) : "已送达", accentColor: ACCENT,
          sections: words ? [{ rows: [{ label: "说", value: words }] }] : [] };
      }
      await api.chat.sendCard({ characterId: to, role: "user", historyRole: "user", summary, historyText, card });
      if (shareDraft.reply) api.chat.requestReply({ characterId: to }).catch(error => console.warn("[外卖] 请求回复失败", error));
    });
    closeSheet();
    toast(`已发给 ${(state.characters.find(x => x.id === to) || {}).name || "TA"}`);
    shareDraft.words = "";
  } catch (error) { fail(error, "没发出去"); }
};
