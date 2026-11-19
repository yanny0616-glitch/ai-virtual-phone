// ── 结算：送给谁、地址、时间、红包、付款方式（钱包 / 找 TA 代付）──
const draft = { when: "asap", time: "", note: "", payMode: "wallet", accountId: "", payChar: "", couponId: "auto", address: null };

function draftAddress() {
  if (draft.address !== null) return draft.address;
  if (state.recipient) return state.settings.charAddress[state.recipient] || "";
  return state.settings.userAddress || "";
}
function draftCoupon(total) {
  const list = usableCoupons();
  if (draft.couponId === "none" || !list.length) return null;
  if (draft.couponId === "auto") return list.find(c => c.amount <= total) || list[list.length - 1];
  return list.find(c => c.id === draft.couponId) || null;
}
/** 约定的送达时刻（毫秒）；尽快返回 0 */
function draftSchedule(now) {
  if (draft.when === "asap") return 0;
  if (draft.when === "custom") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(draft.time || "");
    if (!m) return 0;
    const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);   // 已经过了的钟点算明天
    return d.getTime();
  }
  return now + Number(draft.when) * 60000;
}

/** 结算页要用的一整套数：店、购物车、选中的红包、算好的价钱、付款账户够不够 */
function checkoutState() {
  const shop = shopById(state.cart.shopId), items = cartItems();
  if (!shop || !items.length) return null;
  const coupon = draftCoupon(priceOrder(items, shop, 0).total);
  const p = priceOrder(items, shop, coupon ? coupon.amount : 0);
  const accounts = (state.wallet && state.wallet.accounts) || [];
  const account = accounts.find(a => a.id === draft.accountId);
  const lack = draft.payMode === "wallet" && !!account && Number(account.balance) < p.total;
  return { shop, items, coupon, p, accounts, account, lack };
}
/** 结算页底部的停靠条：合计 + 付款按钮 */
function payDock() {
  const c = checkoutState();
  if (!c) return "";
  const saved = c.p.off + c.p.coupon;
  return `<span class="dock-sum"><span class="dock-total">合计 ${priceHtml(c.p.total)}</span><small>${saved > 0 ? `已优惠 ${yuan(saved)}` : `含配送费 ${c.p.fee ? yuan(c.p.fee) : "0"}`}</small></span>
    <button type="button" class="btn" data-act="place-order"${c.lack ? " disabled" : ""}>${draft.payMode === "char" ? "发给 TA 代付" : c.lack ? "余额不足" : "提交订单"}</button>`;
}

views.checkout = {
  title: "确认订单",
  tone: "plain",
  render() {
    const toChar = !!state.recipient;
    if (toChar && draft.payMode === "char") draft.payMode = "wallet";
    const wallet = state.wallet, list = (wallet && wallet.accounts) || [];
    if (!draft.accountId && wallet) draft.accountId = wallet.defaultAccountId || (list[0] && list[0].id) || "";
    if (!draft.payChar && state.characters[0]) draft.payChar = state.characters[0].id;
    const c = checkoutState();
    if (!c) return '<div class="empty"><span class="big">🛒</span><p>购物车是空的</p></div>';
    const { shop, items, p, accounts, account, lack } = c;
    const sched = draftSchedule(Date.now());
    const seg = (key, value, label) => `<button type="button" class="${draft[key] === value ? "on" : ""}" data-act="draft-set" data-key="${key}" data-value="${esc(value)}">${esc(label)}</button>`;
    const pay = (value, ico, label, hint) => `<button type="button" class="pay${draft.payMode === value ? " on" : ""}" data-act="draft-set" data-key="payMode" data-value="${value}"><i>${icon(ico, 15)}</i><span>${label}<small>${esc(hint)}</small></span></button>`;
    const payChar = state.characters.find(x => x.id === draft.payChar);
    return `
      <section class="card addr">
        <h3>${icon("pin", 14)}送给谁</h3>
        <div class="whos">${[{ id: "", name: "我自己" }].concat(state.characters).map(x => `<button type="button" class="who${state.recipient === x.id ? " on" : ""}" data-act="set-recipient" data-id="${esc(x.id)}">${x.id ? avatarHtml(x, "sm") : '<span class="ava ph sm">我</span>'}${esc(x.name)}</button>`).join("")}</div>
        <label class="frow"><span>地址</span><input data-change="draft-input" data-key="address" placeholder="${toChar ? esc(recipientName()) + " 那边的地址（可不填）" : "你的收货地址（可不填）"}" value="${esc(draftAddress())}"></label>
        <label class="frow"><span>备注</span><input data-change="draft-input" data-key="note" maxlength="60" placeholder="少辣、不要香菜、放门口…" value="${esc(draft.note)}"></label>
      </section>
      <section class="card">
        <h3>${icon("clock", 14)}送达时间<small>${sched ? `约定 ${esc(when(sched))}` : esc(etaHint(shop))}</small></h3>
        <div class="seg">${seg("when", "asap", "尽快")}${seg("when", "30", "30 分钟后")}${seg("when", "60", "1 小时后")}${seg("when", "custom", "指定")}</div>
        ${draft.when === "custom" ? `<label class="frow"><span>几点送到</span><input type="time" data-change="draft-input" data-key="time" data-rerender="1" value="${esc(draft.time)}"></label>` : ""}
        ${sched ? `<p class="hint">如果约定的时间比最快送达还早，就按尽快送。</p>` : ""}
      </section>
      <section class="card receipt">
        <div class="receipt-head">${shopCover(shop, 30)}<span><b>${esc(shop.name)}</b><small>共 ${items.reduce((n, it) => n + it.qty, 0)} 件</small></span></div>
        ${items.map(it => `<div class="line">${dishCover(itemEmoji(it.name, shop), shop.color, 30)}<span>${esc(it.name)}</span><span>×${it.qty}</span><b>${yuan(it.price * it.qty)}</b></div>`).join("")}
        <div class="cut"></div>
        <div class="line sub"><span>配送费</span><b>${p.fee ? yuan(p.fee) : "免费"}</b></div>
        ${p.off ? `<div class="line sub"><span>满减</span><b class="minus">−${yuan(p.off)}</b></div>` : ""}
        ${usableCoupons().length ? `<label class="line sub"><span>红包</span><select data-change="draft-input" data-key="couponId" data-rerender="1">
            <option value="auto"${draft.couponId === "auto" ? " selected" : ""}>自动选一张</option>
            ${usableCoupons().map(x => `<option value="${esc(x.id)}"${draft.couponId === x.id ? " selected" : ""}>${yuan(x.amount)} · ${esc(x.reason)}</option>`).join("")}
            <option value="none"${draft.couponId === "none" ? " selected" : ""}>不用红包</option></select><b class="minus">${p.coupon ? "−" + yuan(p.coupon) : ""}</b></label>` : ""}
        <div class="line total"><span>合计</span><b>${yuan(p.total)}</b></div>
      </section>
      <section class="card">
        <h3>${icon("wallet", 14)}付款方式</h3>
        <div class="pays">${pay("wallet", "wallet", "钱包付款", account ? `${account.title || "账户"} ${account.balanceLabel || yuan(account.balance)}` : "从小手机钱包扣")}${toChar ? "" : pay("char", "heart", "找 TA 代付", payChar ? `请 ${payChar.name} 帮忙付` : "TA 同意后才配送")}</div>
        ${draft.payMode === "wallet"
          ? (wallet
            ? `${accounts.length > 1 ? `<label class="frow"><span>付款账户</span><select data-change="draft-input" data-key="accountId" data-rerender="1">${accounts.map(a => `<option value="${esc(a.id)}"${a.id === draft.accountId ? " selected" : ""}>${esc(a.title || "账户")}（${esc(a.balanceLabel || yuan(a.balance))}）</option>`).join("")}</select><span class="chev">${icon("right", 12)}</span></label>` : ""}${lack ? '<p class="hint warn">这个账户余额不够，换一个账户，或者找 TA 代付。</p>' : ""}`
            : '<p class="hint warn">读不到钱包。请在权限里允许本 APP 读取钱包和付款。</p>')
          : (state.characters.length
            ? `<label class="frow"><span>请谁付</span><select data-change="draft-input" data-key="payChar" data-rerender="1">${state.characters.map(x => `<option value="${esc(x.id)}"${x.id === draft.payChar ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select><span class="chev">${icon("right", 12)}</span></label><p class="hint">会在聊天里发一张代付请求，由 TA 按自己的性格决定付不付。TA 同意后才开始配送。</p>`
            : '<p class="hint warn">还没有角色可以代付。</p>')}
      </section>`;
  },
};

actions["draft-set"] = d => { draft[d.key] = d.value; render(); };
actions["draft-input"] = (d, node) => { draft[d.key] = node.value; if (d.rerender) render(); };

actions["to-checkout"] = async () => {
  try { state.wallet = await api.wallet.get(); } catch (error) { state.wallet = null; console.warn("[外卖] 读取钱包失败", error); }
  draft.address = null;
  go("checkout", {});
};

actions["place-order"] = async () => {
  const shop = shopById(state.cart.shopId), items = cartItems();
  if (!shop || !items.length) return;
  const now = Date.now();
  const coupon = draftCoupon(priceOrder(items, shop, 0).total);
  const p = priceOrder(items, shop, coupon ? coupon.amount : 0);
  if (p.short > 0) { toast(`还差 ${yuan(p.short)} 起送`); return; }
  const byChar = draft.payMode === "char" && !state.recipient;
  if (byChar && !draft.payChar) { toast("先选一位角色"); return; }
  const address = draftAddress().trim();
  const data = {
    no: nextOrderNo(now), shopId: shop.id, shopName: shop.name, shopFactor: shop.factor, items,
    subtotal: p.subtotal, fee: p.fee, off: p.off, coupon: p.coupon, couponId: coupon ? coupon.id : "", total: p.total,
    recipient: state.recipient, charId: state.recipient || (byChar ? draft.payChar : ""), payer: byChar ? "char" : "user", source: byChar ? "payreq" : "app",
    note: draft.note.trim(), address, scheduledFor: draftSchedule(now), speed: state.settings.speed, status: "pending_pay", createdAt: now,
  };
  const order = await busy(byChar ? "正在发给 TA…" : "正在下单…", async () => {
    // 先建单再扣款：扣款失败就把单删掉，不会出现「钱扣了却没有订单」
    const created = await createOrder(data);
    if (!byChar && p.total > 0) {
      let paid = null, payError = null;
      try { paid = await api.wallet.pay({ amount: p.total, accountId: draft.accountId, title: `外卖 · ${shop.name}`, detail: items.map(it => `${it.name}×${it.qty}`).join("、").slice(0, 200), category: "外卖", relatedOrderId: data.no }); }
      catch (error) { payError = error; }
      if (payError || !paid || paid.ok === false) {
        await deleteOrder(created);
        throw new Error((payError && payError.message) || (paid && paid.error) || "付款失败");
      }
    }
    if (coupon && p.coupon > 0) await useCoupon(coupon, created.id);
    // 记住这次填的地址，下次不用再写
    if (address) {
      if (state.recipient) await saveSettings({ charAddress: { ...state.settings.charAddress, [state.recipient]: address } });
      else await saveSettings({ userAddress: address });
    }
    if (byChar) await sendPayRequest(created);
    else {
      await startDelivery(created, now);
      if (created.recipient) await sendGiftCard(created);
    }
    return created;
  });
  if (!order) return;
  state.cart = emptyCart();
  draft.note = ""; draft.when = "asap"; draft.couponId = "auto"; draft.address = null;
  toast(byChar ? "已发给 TA，等 TA 回复" : "下单成功");
  state.stack = []; state.view = "orders"; state.params = {};
  go("order", { id: order.id });
};
