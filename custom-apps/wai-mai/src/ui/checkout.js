// ── 结算：送给谁（自己 / 角色 / 群聊）、配送或自取、地址、时间、优惠、付款方式（钱包 / 找 TA 代付 / 和 TA 拼单）──
const draft = { when: "asap", time: "", note: "", payMode: "wallet", accountId: "", payChar: "", couponId: "auto", address: null, perHead: true, useFeeCoupon: true };

function draftAddress() {
  if (draft.address !== null) return draft.address;
  if (isGroupRecipient()) return "";
  if (state.recipient) return state.settings.charAddress[state.recipient] || "";
  return state.settings.userAddress || "";
}
/** 约定的送达 / 取餐时刻（毫秒）；尽快返回 0 */
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
const round1c = n => Math.round(n * 10) / 10;

/** 结算页要用的一整套数：店、商品（请群聊按人数乘过）、优惠、算好的价钱、这次要从钱包付多少 */
function checkoutState() {
  const shop = shopById(state.cart.shopId);
  let items = cartItems();
  if (!shop || !items.length) return null;
  const group = recipientGroup();
  const heads = group && draft.perHead ? groupSize(group) : 1;
  if (heads > 1) items = items.map(it => ({ ...it, qty: it.qty * heads }));
  const pickup = state.mode === "pickup" && !state.recipient;
  const member = isMember();
  const feeCoupon = !pickup && !member && shop.fee > 0 && draft.useFeeCoupon ? feeCoupons()[0] || null : null;
  const opts = { pickup, freeFee: member || !!feeCoupon };
  const base = priceOrder(items, shop, opts);
  const list = usableCoupons({ subtotal: base.subtotal, shopId: shop.id });
  const coupon = draft.couponId === "none" || !list.length ? null
    : draft.couponId === "auto" ? list.find(c => c.amount <= base.total) || list[list.length - 1]
    : list.find(c => c.id === draft.couponId) || null;
  const p = priceOrder(items, shop, { ...opts, coupon: coupon ? coupon.amount : 0 });
  const solo = !state.recipient;                       // 只有给自己点才能找人代付、拼单
  const mode = solo ? draft.payMode : "wallet";
  const payNow = mode === "char" ? 0 : mode === "split" ? round1c(p.total / 2) : p.total;
  const accounts = (state.wallet && state.wallet.accounts) || [];
  const account = accounts.find(a => a.id === draft.accountId);
  const lack = payNow > 0 && !!account && Number(account.balance) < payNow;
  return { shop, items, heads, group, pickup, member, feeCoupon, coupons: list, coupon, p, mode, payNow, accounts, account, lack };
}
/** 结算页底部的停靠条：合计 + 付款按钮 */
function payDock() {
  const c = checkoutState();
  if (!c) return "";
  const saved = round1c(c.p.off + c.p.coupon + c.p.feeOff + c.p.pickupOff);
  const label = c.lack ? "余额不足" : c.mode === "char" ? "发给 TA 代付" : c.mode === "split" ? `付我那一半 ${yuan(c.payNow)}` : "提交订单";
  return `<span class="dock-sum"><span class="dock-total">合计 ${priceHtml(c.p.total)}</span><small>${saved > 0 ? `已优惠 ${yuan(saved)}` : c.pickup ? "到店自取" : `含配送费 ${c.p.fee ? yuan(c.p.fee) : "0"}`}</small></span>
    <button type="button" class="btn" data-act="place-order"${c.lack ? " disabled" : ""}>${label}</button>`;
}
/** 顺手带一件：这家店里几块钱的小东西，购物车里还没有的 */
function addonDishes(shop) {
  const inCart = new Set(Object.keys(state.cart.items).map(k => (state.cart.base || {})[k] || k));
  return shop.dishes.filter(d => !inCart.has(d.name) && d.price <= 12 && !dishSpecs(d, shop).length).slice(0, 4);
}

views.checkout = {
  title: "确认订单",
  tone: "plain",
  render() {
    const wallet = state.wallet, list = (wallet && wallet.accounts) || [];
    if (!draft.accountId && wallet) draft.accountId = wallet.defaultAccountId || (list[0] && list[0].id) || "";
    if (!draft.payChar && state.characters[0]) draft.payChar = state.characters[0].id;
    const c = checkoutState();
    if (!c) return '<div class="empty"><span class="big">🛒</span><p>购物车是空的</p></div>';
    const { shop, items, heads, group, pickup, member, feeCoupon, coupons, p, mode, accounts, account, lack } = c;
    const toChar = !!state.recipient && !group, solo = !state.recipient;
    const sched = draftSchedule(Date.now());
    const seg = (key, value, label) => `<button type="button" class="${draft[key] === value ? "on" : ""}" data-act="draft-set" data-key="${key}" data-value="${esc(value)}">${esc(label)}</button>`;
    const pay = (value, ico, label, hint) => `<button type="button" class="pay${mode === value ? " on" : ""}" data-act="draft-set" data-key="payMode" data-value="${value}"><i>${icon(ico, 15)}</i><span>${label}<small>${esc(hint)}</small></span></button>`;
    const payChar = state.characters.find(x => x.id === draft.payChar);
    const who = (id, ava, name) => `<button type="button" class="who${state.recipient === id ? " on" : ""}" data-act="set-recipient" data-id="${esc(id)}">${ava}${esc(name)}</button>`;
    const whos = [who("", '<span class="ava ph sm">我</span>', "我自己")]
      .concat(state.characters.map(x => who(x.id, avatarHtml(x, "sm"), x.name)))
      .concat(state.settings.groups.map(g => who("g:" + g.sessionId, '<span class="ava ph grp sm">群</span>', g.name || "群聊")));
    const addrChips = solo && !pickup && state.settings.addresses.length > 1
      ? `<div class="addr-chips">${state.settings.addresses.map(a => `<button type="button" class="${draftAddress() === a.text ? "on" : ""}" data-act="draft-set" data-key="address" data-value="${esc(a.text)}"><i>${esc(a.tag)}</i>${esc(a.text)}</button>`).join("")}</div>` : "";
    const where = pickup
      ? `<div class="frow"><span>自取地点</span><b>${esc(shop.name)} · 距你 ${shopStats(shop).km}km</b></div>`
      : group
        ? `<div class="frow"><span>送到</span><b>群里大家手上（${groupSize(group)} 人）</b></div>
           <div class="frow sw-row" data-act="draft-toggle" data-key="perHead"><span class="grow"><b>每样按人数点</b><small>${draft.perHead ? `每样 ×${groupSize(group)}，一人一份` : "按购物车里的份数点"}</small></span><button type="button" class="sw${draft.perHead ? " on" : ""}" role="switch" aria-checked="${draft.perHead}" aria-label="每样按人数点"></button></div>`
        : `${addrChips}<label class="frow"><span>地址</span><input data-change="draft-input" data-key="address" placeholder="${toChar ? esc(recipientName()) + " 那边的地址（可不填）" : "你的收货地址（可不填）"}" value="${esc(draftAddress())}"></label>`;
    const addons = addonDishes(shop);
    const feeLine = pickup ? "" : `<div class="line sub"><span>配送费${p.feeOff ? `<i class="tag ${member ? "vip" : "addr"}">${member ? "会员免" : "运费券"}</i>` : ""}</span><b>${p.fee ? (p.feeOff ? `<s>${yuan(p.fee)}</s> 0` : yuan(p.fee)) : "免费"}</b></div>`;
    return `
      <section class="card addr">
        <h3>${icon("pin", 14)}送给谁</h3>
        <div class="whos">${whos.join("")}</div>
        ${solo ? `<div class="modes slim"><button type="button" class="${pickup ? "" : "on"}" data-act="set-mode" data-mode="delivery">外卖配送</button><button type="button" class="${pickup ? "on" : ""}" data-act="set-mode" data-mode="pickup">到店自取 · 立减一成</button></div>` : ""}
        ${where}
        <label class="frow"><span>${group ? "附言" : "备注"}</span><input data-change="draft-input" data-key="note" maxlength="60" placeholder="${group ? "群里的大家会知道，比如：今天我请客！" : pickup ? "比如：少辣、晚点来拿" : "少辣、不要香菜、放门口…"}" value="${esc(draft.note)}"></label>
      </section>
      <section class="card">
        <h3>${icon("clock", 14)}${pickup ? "取餐时间" : "送达时间"}<small>${sched ? `约定 ${esc(when(sched))}` : esc(pickup ? pickupHint(shop) : etaHint(shop))}</small></h3>
        <div class="seg">${seg("when", "asap", pickup ? "尽快做好" : "尽快")}${seg("when", "30", "30 分钟后")}${seg("when", "60", "1 小时后")}${seg("when", "custom", "指定")}</div>
        ${draft.when === "custom" ? `<label class="frow"><span>${pickup ? "几点来取" : "几点送到"}</span><input type="time" data-change="draft-input" data-key="time" data-rerender="1" value="${esc(draft.time)}"></label>` : ""}
        ${sched ? `<p class="hint">如果约定的时间比最快${pickup ? "做好" : "送达"}还早，就按尽快。</p>` : ""}
      </section>
      <section class="card receipt">
        <div class="receipt-head">${shopCover(shop, 30)}<span><b>${esc(shop.name)}</b><small>共 ${items.reduce((n, it) => n + it.qty, 0)} 件${heads > 1 ? ` · 按 ${heads} 人份` : ""}</small></span></div>
        ${items.map(it => `<div class="line">${dishCover(itemEmoji(it.name, shop), shop.color, 30)}<span>${esc(it.name)}</span><span>×${it.qty}</span><b>${yuan(it.price * it.qty)}</b></div>`).join("")}
        ${addons.length ? `<div class="addons"><small>顺手带一件</small><div>${addons.map(d => `<button type="button" class="addon" data-act="addon-add" data-name="${esc(d.name)}">${dishCover(d.emoji, shop.color, 34)}<span>${esc(d.name)}</span>${priceHtml(dishPrice(d, shop), "sm")}<i class="plus-dot">+</i></button>`).join("")}</div></div>` : ""}
        <div class="cut"></div>
        ${p.pack ? `<div class="line sub"><span>包装费</span><b>${yuan(p.pack)}</b></div>` : ""}
        ${feeLine}
        ${p.pickupOff ? `<div class="line sub"><span>自取立减</span><b class="minus">−${yuan(p.pickupOff)}</b></div>` : ""}
        ${p.off ? `<div class="line sub"><span>满减</span><b class="minus">−${yuan(p.off)}</b></div>` : ""}
        ${coupons.length ? `<label class="line sub"><span>红包</span><select data-change="draft-input" data-key="couponId" data-rerender="1">
            <option value="auto"${draft.couponId === "auto" ? " selected" : ""}>自动选最划算的</option>
            ${coupons.map(x => `<option value="${esc(x.id)}"${draft.couponId === x.id ? " selected" : ""}>${yuan(x.amount)} · ${esc(x.reason)}${x.min ? `（满 ${x.min}）` : ""}</option>`).join("")}
            <option value="none"${draft.couponId === "none" ? " selected" : ""}>不用红包</option></select><b class="minus">${p.coupon ? "−" + yuan(p.coupon) : ""}</b></label>` : ""}
        ${!pickup && !member && shop.fee > 0 && !feeCoupon ? `<button type="button" class="upsell" data-act="open-member">${icon("crown", 13)}<span>开通会员，这单就能省 ${yuan(shop.fee)} 配送费</span>${icon("right", 12)}</button>` : ""}
        <div class="line total"><span>合计</span><b>${yuan(p.total)}</b></div>
      </section>
      <section class="card">
        <h3>${icon("wallet", 14)}付款方式</h3>
        <div class="pays">${pay("wallet", "wallet", "钱包付款", account ? `${account.title || "账户"} ${account.balanceLabel || yuan(account.balance)}` : "从小手机钱包扣")}${solo && state.characters.length ? pay("char", "heart", "找 TA 代付", "TA 看心情决定") + pay("split", "gift", "和 TA 拼单", `一人一半，你付 ${yuan(round1c(p.total / 2))}`) : ""}</div>
        ${mode !== "wallet" ? `<label class="frow"><span>${mode === "char" ? "请谁付" : "和谁拼"}</span><select data-change="draft-input" data-key="payChar" data-rerender="1">${state.characters.map(x => `<option value="${esc(x.id)}"${x.id === draft.payChar ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select><span class="chev">${icon("right", 12)}</span></label>
          <p class="hint">${mode === "char" ? `会在聊天里发一张代付请求，由 ${esc(payChar ? payChar.name : "TA")} 按自己的性格决定付不付。TA 同意后才开始配送。` : `你先付自己那一半，再问 ${esc(payChar ? payChar.name : "TA")} 要不要一起拼。TA 答应了才开始配送；不答应可以自己补上另一半，或者取消（你付的那一半退成红包）。`}</p>` : ""}
        ${mode !== "char" ? (wallet
          ? `${accounts.length > 1 ? `<label class="frow"><span>付款账户</span><select data-change="draft-input" data-key="accountId" data-rerender="1">${accounts.map(a => `<option value="${esc(a.id)}"${a.id === draft.accountId ? " selected" : ""}>${esc(a.title || "账户")}（${esc(a.balanceLabel || yuan(a.balance))}）</option>`).join("")}</select><span class="chev">${icon("right", 12)}</span></label>` : ""}${lack ? '<p class="hint warn">这个账户余额不够，换一个账户，或者找 TA 代付。</p>' : ""}`
          : '<p class="hint warn">读不到钱包。请在权限里允许本 APP 读取钱包和付款。</p>') : ""}
      </section>`;
  },
};

actions["draft-set"] = d => { draft[d.key] = d.value; render(); };
actions["draft-input"] = (d, node) => { draft[d.key] = node.value; if (d.rerender) render(); };
actions["draft-toggle"] = d => { draft[d.key] = !draft[d.key]; render(); };
actions["addon-add"] = async d => {
  const shop = shopById(state.cart.shopId), dish = shop && dishOf(d.name, shop);
  if (dish && await addToCart(shop.id, dish, dish.name)) { toast(`加了一份${dish.name}`); render(); }
};

actions["to-checkout"] = async () => {
  try { state.wallet = await api.wallet.get(); } catch (error) { state.wallet = null; console.warn("[外卖] 读取钱包失败", error); }
  draft.address = null;
  go("checkout", {});
};

actions["place-order"] = async () => {
  const c = checkoutState();
  if (!c) return;
  const { shop, items, group, pickup, member, feeCoupon, coupon, p, mode, payNow } = c;
  if (p.short > 0) { toast(`还差 ${yuan(p.short)} 起送`); return; }
  const byChar = mode === "char", split = mode === "split";
  if ((byChar || split) && !draft.payChar) { toast("先选一位角色"); return; }
  const now = Date.now();
  const address = pickup || group ? "" : draftAddress().trim();
  const rider = !pickup && state.settings.riderChar ? state.characters.find(x => x.id === state.settings.riderChar) : null;
  const data = {
    no: nextOrderNo(now), shopId: shop.id, shopName: shop.name, shopFactor: shop.factor, items,
    mode: pickup ? "pickup" : "", code: pickup ? `A${100 + Math.floor(Math.random() * 900)}` : "",
    subtotal: p.subtotal, pack: p.pack, fee: p.fee, feeOff: p.feeOff, pickupOff: p.pickupOff, off: p.off, coupon: p.coupon, couponId: coupon ? coupon.id : "", total: p.total,
    freeBy: p.feeOff ? (member ? "member" : "coupon") : "",
    recipient: group ? "" : state.recipient,
    groupId: group ? group.sessionId : "", groupName: group ? group.name || "群聊" : "", groupMembers: group ? (group.participants || []).map(x => x.id) : [],
    charId: group ? "" : state.recipient || (byChar || split ? draft.payChar : ""),
    payer: byChar ? "char" : split ? "split" : "user", source: byChar ? "payreq" : split ? "split" : "app", userPaid: payNow,
    riderName: rider ? rider.name : "", riderCharId: rider ? rider.id : "",
    note: draft.note.trim(), address, scheduledFor: draftSchedule(now), speed: state.settings.speed, status: "pending_pay", createdAt: now,
  };
  const order = await busy(byChar || split ? "正在发给 TA…" : "正在下单…", async () => {
    // 先建单再扣款：扣款失败就把单删掉，不会出现「钱扣了却没有订单」
    const created = await createOrder(data);
    if (payNow > 0) {
      let paid = null, payError = null;
      try { paid = await api.wallet.pay({ amount: payNow, accountId: draft.accountId, title: `外卖 · ${shop.name}${split ? "（拼单我那一半）" : ""}`, detail: items.map(it => `${it.name}×${it.qty}`).join("、").slice(0, 200), category: "外卖", relatedOrderId: data.no }); }
      catch (error) { payError = error; }
      if (payError || !paid || paid.ok === false) {
        await deleteOrder(created);
        throw new Error((payError && payError.message) || (paid && paid.error) || "付款失败");
      }
    }
    if (coupon && p.coupon > 0) await useCoupon(coupon, created.id);
    if (feeCoupon && p.feeOff > 0 && !member) await useCoupon(feeCoupon, created.id);
    if (member && p.feeOff > 0) await noteMemberSaving(p.feeOff);
    // 记住这次填的地址，下次不用再写
    if (address && state.recipient && !group) await saveSettings({ charAddress: { ...state.settings.charAddress, [state.recipient]: address } });
    else if (address && !state.recipient && address !== state.settings.userAddress) {
      const rest = state.settings.addresses.filter(a => a.text !== address);
      await saveSettings({ userAddress: address, addresses: [{ id: uid("addr"), tag: "其他", text: address }, ...rest].slice(0, 12) });
    }
    if (byChar) await sendPayRequest(created);
    else if (split) await sendSplitRequest(created);
    else {
      await startDelivery(created, now);
      if (created.recipient) await sendGiftCard(created);
      if (created.groupId) await sendGroupCard(created);
    }
    return created;
  });
  if (!order) return;
  state.cart = emptyCart();
  draft.note = ""; draft.when = "asap"; draft.couponId = "auto"; draft.address = null; draft.payMode = "wallet"; draft.perHead = true;
  if (state.mode === "pickup") state.mode = "delivery";
  toast(byChar ? "已发给 TA，等 TA 回复" : split ? "已付你那一半，等 TA 答应拼单" : pickup ? `下单成功，取餐码 ${order.code}` : "下单成功");
  state.stack = []; state.view = "orders"; state.params = {};
  go("order", { id: order.id });
};
