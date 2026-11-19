// ── 订单列表和订单详情（配送进度、催单、换速度、少送退款、评价）──
function orderStatus(o, now) {
  if (o.status === "pending_pay") return o.source === "payreq" ? { text: "等 TA 代付", tone: "wait" } : { text: "待付款", tone: "wait" };
  if (o.status === "pay_declined") return { text: "TA 没有代付", tone: "warn" };
  if (o.status === "canceled") return { text: "已取消", tone: "off" };
  const st = stageAt(o, now);
  if (!st) return { text: "处理中", tone: "wait" };
  return st.delivered ? { text: "已送达", tone: "done" } : { text: st.label, tone: "live" };
}
function orderWho(o) {
  const c = o.charId ? state.characters.find(x => x.id === o.charId) : null;
  const name = c ? c.name : "TA";
  if (o.recipient) return `送给 ${name}`;
  if (o.source === "directive") return `${name} 请客`;
  if (o.source === "payreq") return `${name} 代付`;
  return "";
}
const itemCount = o => (o.items || []).reduce((n, it) => n + it.qty, 0);

const ORDER_TABS = [["all", "全部"], ["live", "进行中"], ["rate", "待评价"]];
views.orders = {
  title: "订单",
  tone: "plain",
  render() {
    const now = Date.now();
    const rows = state.orders.map(o => ({ o, s: orderStatus(o, now) })).filter(({ o, s }) => state.orderTab === "live" ? ["live", "wait"].includes(s.tone)
      : state.orderTab === "rate" ? s.tone === "done" && !o.review && !o.recipient : true);
    const tabs = `<div class="stabs">${ORDER_TABS.map(([key, label]) => `<button type="button" class="${state.orderTab === key ? "on" : ""}" data-act="order-tab" data-tab="${key}">${label}</button>`).join("")}</div>`;
    if (!rows.length) return `${tabs}<div class="empty"><span class="big">🧾</span><p>${state.orders.length ? "这一类下面没有订单" : "还没有订单"}</p><small>去首页挑一家店吧</small></div>`;
    return `${tabs}<div class="orders">${rows.map(({ o, s }) => {
      const who = orderWho(o), shop = orderShop(o), items = o.items || [];
      const st = s.tone === "live" ? stageAt(o, now) : null;
      const id = esc(o.id);
      return `<div class="order" data-act="open-order" data-id="${id}">
        <div class="order-top">${shopCover(shop, 32)}<span><b>${esc(o.shopName)}</b><small>${esc(when(o.createdAt, now))}${who ? " · " + esc(who) : ""}</small></span><i class="st ${s.tone}">${esc(s.text)}</i></div>
        <div class="order-mid">${items.slice(0, 4).map(it => dishCover(itemEmoji(it.name, shop), shop.color, 40)).join("")}<span class="more">${items.length === 1 ? esc(items[0].name) : ""}</span>
          <span class="sum">${o.source === "directive" ? "<b>TA 请客</b>" : priceHtml(o.total, "ink")}<small>共 ${itemCount(o)} 件</small></span></div>
        ${st ? `<span class="bar"><i style="width:${Math.round(st.progress * 100)}%"></i></span>` : ""}
        <div class="order-foot"><small>${st ? esc(remainText(st.remainMs)) : s.tone === "done" ? `${esc(when(o.deliverAt, now))} 送达` : ""}</small>
          ${shopById(o.shopId) ? `<button type="button" class="mini" data-act="order-again" data-id="${id}">再来一单</button>` : ""}
          <button type="button" class="mini hot" data-act="open-order" data-id="${id}">${st ? "看进度" : s.tone === "done" && !o.review && !o.recipient ? "去评价" : "查看"}</button></div>
      </div>`;
    }).join("")}</div>`;
  },
};
actions["order-tab"] = d => { state.orderTab = d.tab; render(true); };
actions["open-order"] = d => {
  if (state.view === "order") { state.params = { id: d.id }; render(true); return; }
  go("order", { id: d.id });
};

const TRACK_STEPS = [["accepted", "接单"], ["cooking", "备餐"], ["picked", "取餐"], ["riding", "配送"], ["delivered", "送达"]];
const STATE_EMOJI = { pending_pay: "⏳", pay_declined: "🙅", canceled: "🚫" };

views.order = {
  title: "订单详情",
  tone: "plain",
  render(p) {
    const o = orderById(p.id);
    if (!o) return '<div class="empty"><span class="big">🧾</span><p>这张订单已经删除了</p></div>';
    const now = Date.now(), s = orderStatus(o, now), st = o.status === "active" ? stageAt(o, now) : null;
    const who = orderWho(o), shop = orderShop(o), id = esc(o.id);
    const live = st && !st.delivered;
    const stageIdx = st ? STAGE_ORDER.indexOf(st.key) : -1;
    const chatBtn = o.charId ? `<button type="button" class="mini" data-act="open-chat" data-id="${esc(o.charId)}">去聊天</button>` : "";
    const againBtn = shopById(o.shopId) ? `<button type="button" class="mini" data-act="order-again" data-id="${id}">再来一单</button>` : "";
    let head = "";
    if (live) {
      const [n, unit] = remainParts(st.remainMs), left = unit.replace("后送达", "");
      const picked = stageIdx >= STAGE_ORDER.indexOf("picked");
      const lastOn = TRACK_STEPS.reduce((last, [key], i) => STAGE_ORDER.indexOf(key) <= stageIdx ? i : last, -1);
      const homeAva = o.recipient ? avatarHtml(state.characters.find(x => x.id === o.recipient)) : '<span class="ava ph">我</span>';
      const latest = st.passed[st.passed.length - 1];
      head = `<div class="mapwrap">${mapHtml(o, shop, now, picked ? `${n} ${left}` : "去取餐", homeAva)}</div>
        <section class="card status">
          <h2>${esc(s.text)}</h2>
          <p class="eta-line">预计 <b>${hhmm(o.deliverAt)}</b> 送达，还有 <b>${n}</b> ${left}${who ? ` · ${esc(who)}` : ""}</p>
          <div class="steps">${TRACK_STEPS.map(([key, label], i) => `<span class="${i <= lastOn ? "on" : ""}${i === lastOn ? " now" : ""}"><i>${i <= lastOn ? icon("check", 10) : ""}</i>${label}</span>`).join("")}</div>
          <div class="rider-row"><i>${icon("scooter", 17)}</i><span><b>骑手 ${esc(o.rider || "")}</b><small>${esc(latest ? latest.text : s.text)}</small></span>
            <button type="button" class="mini hot" data-act="order-urge" data-id="${id}"${o.urged ? " disabled" : ""}>${o.urged ? "已催单" : "催单"}</button>${chatBtn}</div>
          <div class="rider-row speed"><span>配送速度</span><div class="seg">${Object.entries(SPEEDS).map(([k, v]) => `<button type="button" class="${o.speed === k ? "on" : ""}" data-act="order-speed" data-id="${id}" data-speed="${k}">${v.label}</button>`).join("")}</div></div>
        </section>`;
    } else if (st) {
      const took = Math.max(1, Math.round((o.deliverAt - (o.paidAt || o.createdAt)) / 60000));
      head = `<section class="card status"><div class="status-top"><div><h2>订单已送达</h2><p class="eta-line">${esc(when(o.deliverAt, now))} 送到${who ? " · " + esc(who) : ""} · 用时 ${took} 分钟</p></div><i class="big">🛍️</i></div>
        ${againBtn || chatBtn ? `<div class="quick">${againBtn}${chatBtn}</div>` : ""}</section>`;
    } else {
      const tip = o.status === "pending_pay" ? (o.source === "payreq" ? "代付请求已经发到聊天里，TA 同意后开始配送。" : "这张订单还没付款。")
        : o.status === "pay_declined" ? `TA 没有帮你付${o.payWords ? `：「${esc(o.payWords)}」` : "。"}` : "订单已取消。";
      head = `<section class="card status"><div class="status-top"><div><h2>${esc(s.text)}</h2><p class="eta-line">${tip}</p></div><i class="big">${STATE_EMOJI[o.status] || "🧾"}</i></div></section>`;
    }
    const delivered = !!(st && st.delivered);
    const issue = o.issue && delivered ? o.issue : null;
    const canCancel = o.status === "pending_pay" || o.status === "pay_declined" || (live && stageIdx < STAGE_ORDER.indexOf("picked") && o.payer === "user");
    return `${head}
      ${o.status === "pay_declined" || (o.status === "pending_pay" && o.source === "payreq") ? `<div class="btns"><button type="button" class="btn" data-act="order-pay-self" data-id="${id}">改成自己付 ${yuan(o.total)}</button><button type="button" class="btn ghost" data-act="open-chat" data-id="${esc(o.charId)}">去聊天</button></div>` : ""}
      ${issue ? `<section class="card issue"><h3>这一单出了点状况</h3><p>${esc(issue.text)}。</p>${issue.resolved
        ? `<p class="hint">${issue.resolved === "refund" ? `已退 ${yuan(issue.amount)} 红包，下次下单自动抵扣。` : "你选择了不计较。"}</p>`
        : (o.payer === "user" ? `<div class="btns"><button type="button" class="btn" data-act="issue-refund" data-id="${id}">申请退款 ${yuan(issue.amount)}</button><button type="button" class="btn ghost" data-act="issue-skip" data-id="${id}">算了</button></div><p class="hint">退款以红包形式返还（钱包暂不支持原路退回）。</p>` : "")}</section>` : ""}
      ${delivered && !o.recipient ? `<section class="card rate-card"><h3>${o.review ? "我的评价" : "这一单怎么样？"}</h3>${o.review
        ? `<p class="stars">${"★".repeat(o.review.stars)}${"☆".repeat(5 - o.review.stars)}</p>${o.review.text ? `<p class="hint">${esc(o.review.text)}</p>` : ""}`
        : `<div class="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-act="order-rate" data-id="${id}" data-stars="${n}" aria-label="${n} 星">★</button>`).join("")}</div><p class="hint">点星星打分${o.charId ? "，TA 之后聊天时会知道你觉得怎么样" : ""}。</p>`}</section>` : ""}
      ${st ? `<section class="card"><h3>${icon("box", 14)}配送动态${delivered && chatBtn ? `<small>${chatBtn}</small>` : ""}</h3><ol class="feed">${st.passed.slice().reverse().map((e, i) => `<li class="${i === 0 ? "now" : ""}"><time>${hhmm(e.at)}</time><span>${esc(e.text)}</span></li>`).join("")}</ol></section>` : ""}
      <section class="card receipt">
        <div class="receipt-head">${shopCover(shop, 30)}<span><b>${esc(o.shopName)}</b><small>共 ${itemCount(o)} 件${who ? " · " + esc(who) : ""}</small></span>${live ? againBtn : ""}</div>
        ${(o.items || []).map(it => `<div class="line">${dishCover(itemEmoji(it.name, shop), shop.color, 30)}<span>${esc(it.name)}</span><span>×${it.qty}</span><b>${it.price ? yuan(it.price * it.qty) : ""}</b></div>`).join("")}
        <div class="cut"></div>
        ${o.source === "directive" ? '<div class="line total"><span>合计</span><b>TA 请客</b></div>' : `
          <div class="line sub"><span>配送费</span><b>${o.fee ? yuan(o.fee) : "免费"}</b></div>
          ${o.off ? `<div class="line sub"><span>满减</span><b class="minus">−${yuan(o.off)}</b></div>` : ""}
          ${o.coupon ? `<div class="line sub"><span>红包</span><b class="minus">−${yuan(o.coupon)}</b></div>` : ""}
          <div class="line total"><span>合计</span><b>${yuan(o.total)}</b></div>`}
        ${delivered ? '<i class="stamp">已<br>送达</i>' : ""}
      </section>
      <section class="card kv">
        <div><span>订单号</span><b>${esc(o.no)}</b></div>
        <div><span>下单时间</span><b>${esc(when(o.createdAt, now))}</b></div>
        ${o.address ? `<div><span>地址</span><b>${esc(o.address)}</b></div>` : ""}
        ${o.note ? `<div><span>${o.source === "directive" ? "TA 的留言" : "备注"}</span><b>${esc(o.note)}</b></div>` : ""}
        ${o.rider && st ? `<div><span>骑手</span><b>${esc(o.rider)}</b></div>` : ""}
      </section>
      <div class="btns">
        ${canCancel ? `<button type="button" class="btn ghost danger" data-act="order-cancel" data-id="${id}">取消订单</button>` : ""}
        ${!live && o.status !== "pending_pay" ? `<button type="button" class="btn ghost danger" data-act="order-delete" data-id="${id}">删除订单</button>` : ""}
      </div>`;
  },
};

actions["open-chat"] = d => api.chat.openConversation({ characterId: d.id });
actions["order-speed"] = async d => {
  const o = orderById(d.id), now = Date.now();
  if (!o || !isOnTheWay(o, now) || o.speed === d.speed) return;
  const next = changeSpeed(o, now, d.speed);
  await patchOrder(o, next);
  await scheduleArrival(o);
  await updateOrderCard(o, { sections: cardSections(o, hhmm(o.deliverAt)) });
  await syncContext();
  render();
};
actions["order-urge"] = async d => {
  const o = orderById(d.id), now = Date.now();
  if (!o || o.urged || !isOnTheWay(o, now)) return;
  await patchOrder(o, urge(o, now));
  await scheduleArrival(o);
  await syncContext();
  toast("已催单");
  render();
};
actions["order-pay-self"] = async d => {
  const o = orderById(d.id);
  if (!o || !["pending_pay", "pay_declined"].includes(o.status)) return;
  const wallet = await api.wallet.get();
  const account = (wallet.accounts || []).find(a => a.id === wallet.defaultAccountId) || (wallet.accounts || [])[0];
  if (!await confirmBox("改成自己付？", `从「${account ? account.title || "钱包" : "钱包"}」付 ${yuan(o.total)}，付完马上开始配送。`)) return;
  await busy("正在付款…", async () => {
    if (o.total > 0) {
      const paid = await api.wallet.pay({ amount: o.total, accountId: account ? account.id : undefined, title: `外卖 · ${o.shopName}`, detail: itemsText(o).slice(0, 200), category: "外卖", relatedOrderId: o.no });
      if (!paid || paid.ok === false) throw new Error((paid && paid.error) || "付款失败");
    }
    await patchOrder(o, { payer: "user", source: "app", charId: "" });
    await startDelivery(o, Date.now());
    await updateOrderCard(o, { status: "已自己付款", actions: [{ label: "查看订单" }] });
  });
  render();
};
actions["order-cancel"] = async d => {
  const o = orderById(d.id);
  if (!o) return;
  const paid = o.status === "active" && o.payer === "user" && o.total > 0;
  if (!await confirmBox("取消这张订单？", paid ? `已付的 ${yuan(o.total)} 会以红包返还（钱包暂不支持原路退回）。` : "取消后不会配送。")) return;
  await cancelArrival(o);
  await patchOrder(o, { status: "canceled", canceledAt: Date.now() });
  if (paid) await addCoupon(o.total, `订单 ${o.no} 取消退回`);
  await updateOrderCard(o, { status: "已取消", actions: [{ label: "查看订单" }] });
  if (o.charId && o.cardMessageId) {
    const names = await namesFor(o.charId);
    await api.chat.writeHistory({ characterId: o.charId, role: "user", content: `[外卖：${names.userName}取消了「${o.shopName}」的这份外卖，不会送来了。]` }).catch(() => {});
  }
  await syncContext();
  toast(paid ? "已取消，退款已发成红包" : "已取消");
  render();
};
actions["order-delete"] = async d => {
  const o = orderById(d.id);
  if (!o || !await confirmBox("删除这张订单？", "只删除外卖 APP 里的记录，聊天里的卡片不受影响。")) return;
  await cancelArrival(o);
  await deleteOrder(o);
  await syncContext();
  back();
};
actions["order-again"] = d => {
  const o = orderById(d.id), shop = o && shopById(o.shopId);
  if (!shop) return;
  const items = {}, base = {};
  for (const it of o.items) { const dish = dishOf(it.name, shop); if (dish) { items[it.name] = it.qty; base[it.name] = dish.name; } }
  if (!Object.keys(items).length) { toast("这家店现在没有这些商品了"); return; }
  state.cart = { shopId: shop.id, items, base };
  state.recipient = o.recipient || "";
  go("shop", { id: shop.id });
};
actions["issue-refund"] = async d => {
  const o = orderById(d.id);
  if (!o || !o.issue || o.issue.resolved) return;
  await addCoupon(o.issue.amount, o.issue.type === "missing" ? `少送「${o.issue.item}」退款` : "餐品洒漏补偿");
  await patchOrder(o, { issue: { ...o.issue, resolved: "refund" } });
  toast(`已退 ${yuan(o.issue.amount)} 红包`);
  render();
};
actions["issue-skip"] = async d => {
  const o = orderById(d.id);
  if (!o || !o.issue || o.issue.resolved) return;
  await patchOrder(o, { issue: { ...o.issue, resolved: "skip" } });
  render();
};
actions["order-rate"] = async d => {
  const o = orderById(d.id);
  if (!o || o.review) return;
  const stars = clamp(Number(d.stars) || 5, 1, 5);
  openSheet("说两句（可不写）", `<div class="stars big">${"★".repeat(stars)}${"☆".repeat(5 - stars)}</div><textarea id="review-text" rows="3" maxlength="120" placeholder="味道怎么样？"></textarea><button type="button" class="btn wide" data-act="order-rate-save" data-id="${esc(o.id)}" data-stars="${stars}">提交评价</button>`);
};
actions["order-rate-save"] = async d => {
  const o = orderById(d.id);
  if (!o) return;
  await patchOrder(o, { review: { stars: Number(d.stars), text: ($("review-text").value || "").trim(), at: Date.now() } });
  closeSheet();
  await syncContext();
  toast("评价已提交");
  render();
};

/** 订单页开着时每两秒对一次表；有订单刚好送到就提示一下 */
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const arrived = state.orders.filter(o => o.status === "active" && o.deliverAt > lastTick && o.deliverAt <= now);
  lastTick = now;
  if (arrived.length) { toast(`${arrived[0].shopName} 的外卖送到了`); syncContext(); }
  const moving = state.orders.some(o => isOnTheWay(o, now));
  if ((moving || arrived.length) && ["orders", "order", "home"].includes(state.view) && !$("app").classList.contains("sheet-open") && document.activeElement && document.activeElement.tagName !== "INPUT") render();
}
