// ── 启动 ──
// 三种启动方式共用这一段：桌面 / 聊天卡片 / + 号面板打开（有界面），
// 以及宿主为了后台事件或当轮上下文临时拉起的隐藏运行环境（没界面，只注册 handler）。

/** 从聊天卡片点进来：找到对应订单；角色点的单还没接就让用户确认 */
async function openFromCard(ctx) {
  const directiveId = ctx.directiveId || "";
  if (directiveId === "wm-order") {
    let order = state.orders.find(o => o.directiveMessageId === ctx.messageId);
    if (!order) {
      const args = Array.isArray(ctx.directiveArgs) ? ctx.directiveArgs : [];
      const charId = ctx.characterId || "";
      const names = charId ? await namesFor(charId) : { charName: "TA" };
      if (!await confirmBox(`收下${names.charName}点的外卖？`, `${args[0] || ""}：${args[1] || ""}`)) return;
      order = await acceptCharOrder({ messageId: ctx.messageId, sessionId: ctx.sessionId, charId, args });
    }
    go("order", { id: order.id });
    return;
  }
  const order = state.orders.find(o => o.cardMessageId === ctx.messageId)
    || (directiveId === "wm-pay" && ctx.characterId ? state.orders.find(o => o.charId === ctx.characterId && o.source === "payreq") : null)
    || (directiveId === "wm-split" && ctx.characterId ? state.orders.find(o => o.charId === ctx.characterId && o.source === "split") : null);
  if (order) go("order", { id: order.id });
}

async function boot() {
  if (!api) { document.body.innerHTML = '<p style="padding:24px;font-size:13px">这个页面要在小手机里作为自定义 APP 打开。</p>'; return; }
  let ctx = null;
  try { ctx = await api.app.getLaunchContext(); } catch { ctx = null; }
  state.background = !!(ctx && (ctx.background === true || ctx.source === "background_event"));

  const [chars] = await Promise.all([api.characters.list().catch(() => []), loadAll()]);
  state.characters = Array.isArray(chars) ? chars : (chars && chars.characters) || [];
  await registerChatHooks();
  state.ready = true;
  if (state.background) return;

  bindActions();
  $("btn-back").addEventListener("click", back);
  $("sheet-close").addEventListener("click", closeSheet);
  $("scrim").addEventListener("click", closeSheet);
  document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => go(b.dataset.tab)));

  if (ctx && ctx.source === "chat_plus_action" && ctx.isGroup && ctx.sessionId) {
    // 从群聊的「+」进来：记住这个群，以后首页也能直接选
    const participants = (Array.isArray(ctx.participants) ? ctx.participants : []).map(p => ({ id: String(p.id || ""), name: String(p.name || "") })).filter(p => p.id)
      .concat((Array.isArray(ctx.participantIds) ? ctx.participantIds : []).map(id => ({ id: String(id), name: "" })));
    const uniq = participants.filter((p, i) => participants.findIndex(x => x.id === p.id) === i).map(p => ({ id: p.id, name: p.name || (state.characters.find(c => c.id === p.id) || {}).name || "" }));
    const group = { sessionId: String(ctx.sessionId), name: String(ctx.groupName || "群聊").slice(0, 40), participants: uniq.slice(0, 30) };
    await saveSettings({ groups: [group, ...state.settings.groups.filter(g => g.sessionId !== group.sessionId)].slice(0, 12) });
    state.recipient = "g:" + group.sessionId;
  } else if (ctx && ctx.source === "chat_plus_action" && ctx.characterId && state.characters.some(c => c.id === ctx.characterId)) state.recipient = ctx.characterId;
  grantMemberCoupons().catch(error => console.warn("[外卖] 发会员红包失败", error));
  render(true);
  if (ctx && ctx.messageId) await openFromCard(ctx).catch(fail);

  // 打开时把角标清掉，并按现在的订单重写一遍常驻上下文（上次留下的过期内容在这里收掉）
  if (api.notifications && api.notifications.clearBadge) api.notifications.clearBadge().catch(() => {});
  for (const id of new Set(state.orders.flatMap(o => [o.charId, o.riderCharId]).filter(Boolean))) contextChars.add(id);
  syncContext();
  setInterval(tick, 2000);
  if (api.__mock) window.__wm = { state, go, render, shopById, actions, stageAt, contextText, groupContextText, namesFor, onChatMessage, syncContext, tick, draft, errand, checkoutState, priceOrder, cartItems, todaysOffers, usableCoupons, feeCoupons, isMember };
}
boot().catch(error => {
  console.error(error);
  const main = $("main");
  if (main) main.innerHTML = `<div class="empty"><p>启动失败</p><small>${esc(error && error.message ? error.message : error)}</small></div>`;
});
})();
