// ── 订单列表和订单详情（配送进度、催单、换速度、给骑手留话、自取码、售后、骑手打赏、评价、批量删除）──
/** 这一单你自己掏了多少（老订单没有 userPaid，自己付的就是合计） */
const paidOf = o => o.payer === "user" ? (o.userPaid != null ? Number(o.userPaid) : Number(o.total) || 0) : o.payer === "split" ? Number(o.userPaid) || 0 : 0;
const refundable = o => Math.max(0, round1c(paidOf(o) - (Number(o.refunded) || 0)));
const isPickup = o => o.mode === "pickup";

function orderStatus(o, now) {
  if (o.status === "pending_pay") return o.source === "payreq" ? { text: "等 TA 代付", tone: "wait" } : o.source === "split" ? { text: "等 TA 拼单", tone: "wait" } : { text: "待付款", tone: "wait" };
  if (o.status === "pay_declined") return { text: o.source === "split" ? "TA 没有拼" : "TA 没有代付", tone: "warn" };
  if (o.status === "canceled") return { text: "已取消", tone: "off" };
  const st = stageAt(o, now);
  if (!st) return { text: "处理中", tone: "wait" };
  if (isPickup(o)) return !st.delivered ? { text: st.key === "accepted" || st.key === "placed" ? "商家已接单" : "正在做", tone: "live" } : o.pickedUpAt ? { text: "已取餐", tone: "done" } : { text: "待取餐", tone: "live" };
  return st.delivered ? { text: "已送达", tone: "done" } : { text: st.label, tone: "live" };
}
function orderWho(o) {
  const c = o.charId ? state.characters.find(x => x.id === o.charId) : null;
  const name = c ? c.name : "TA";
  if (o.groupId) return `请「${o.groupName || "群聊"}」`;
  if (o.recipient) return `送给 ${name}`;
  if (o.source === "directive") return `${name} 请客`;
  if (o.source === "payreq") return `${name} 代付`;
  if (o.source === "split") return `和 ${name} 拼单`;
  if (isPickup(o)) return "到店自取";
  return "";
}
const itemCount = o => (o.items || []).reduce((n, it) => n + it.qty, 0);
const canDelete = (o, now) => !["live", "wait"].includes(orderStatus(o, now).tone);

const ORDER_TABS = [["all", "全部"], ["live", "进行中"], ["rate", "待评价"], ["after", "退款/售后"]];
views.orders = {
  title: "订单",
  tone: "plain",
  render() {
    const now = Date.now(), manage = state.orderManage;
    const rows = state.orders.map(o => ({ o, s: orderStatus(o, now) })).filter(({ o, s }) => state.orderTab === "live" ? ["live", "wait"].includes(s.tone)
      : state.orderTab === "rate" ? s.tone === "done" && !o.review && !o.recipient && !o.groupId
      : state.orderTab === "after" ? (o.afterSales && o.afterSales.length) || (o.issue && o.issue.resolved === "refund") || (o.status === "canceled" && paidOf(o) > 0) : true);
    const deletable = rows.filter(({ o }) => canDelete(o, now)).map(({ o }) => o.id);
    const picked = state.orderPicked.filter(id => deletable.includes(id));
    const tabs = `<div class="stabs">${ORDER_TABS.map(([key, label]) => `<button type="button" class="${state.orderTab === key ? "on" : ""}" data-act="order-tab" data-tab="${key}">${label}</button>`).join("")}${state.orders.length ? `<button type="button" class="manage-btn" data-act="order-manage">${manage ? "完成" : "管理"}</button>` : ""}</div>`;
    if (!rows.length) return `${tabs}<div class="empty"><span class="big">🧾</span><p>${state.orders.length ? "这一类下面没有订单" : "还没有订单"}</p><small>去首页挑一家店吧</small></div>`;
    return `${tabs}<div class="orders${manage ? " managing" : ""}">${rows.map(({ o, s }) => {
      const who = orderWho(o), shop = orderShop(o), items = o.items || [];
      const st = s.tone === "live" && !(isPickup(o) && o.deliverAt <= now) ? stageAt(o, now) : null;
      const id = esc(o.id), can = deletable.includes(o.id);
      return `<div class="order${manage && !can ? " locked" : ""}" data-act="${manage ? (can ? "order-pick" : "noop") : "open-order"}" data-id="${id}">
        <div class="order-top">${manage ? `<i class="chk${picked.includes(o.id) ? " on" : ""}">${can ? icon("check", 11) : ""}</i>` : ""}${shopCover(shop, 32)}<span><b>${esc(o.shopName)}</b><small>${esc(when(o.createdAt, now))}${who ? " · " + esc(who) : ""}</small></span><i class="st ${s.tone}">${esc(s.text)}</i></div>
        <div class="order-mid">${items.slice(0, 4).map(it => dishCover(itemEmoji(it.name, shop), shop.color, 40)).join("")}<span class="more">${items.length === 1 ? esc(items[0].name) : ""}</span>
          <span class="sum">${o.source === "directive" ? "<b>TA 请客</b>" : priceHtml(o.total, "ink")}<small>共 ${itemCount(o)} 件</small></span></div>
        ${st ? `<span class="bar"><i style="width:${Math.round(st.progress * 100)}%"></i></span>` : ""}
        ${manage ? "" : `<div class="order-foot"><small>${isPickup(o) && o.code && s.text === "待取餐" ? `取餐码 <b class="code-sm">${esc(o.code)}</b>` : st ? esc(remainText(st.remainMs)) : s.tone === "done" ? `${esc(when(o.deliverAt, now))} ${isPickup(o) ? "做好" : "送达"}` : ""}</small>
          ${shopById(o.shopId) ? `<button type="button" class="mini" data-act="order-again" data-id="${id}">再来一单</button>` : ""}
          <button type="button" class="mini hot" data-act="open-order" data-id="${id}">${st ? "看进度" : s.tone === "done" && !o.review && !o.recipient && !o.groupId ? "去评价" : "查看"}</button></div>`}
      </div>`;
    }).join("")}</div>
    ${manage ? `<div class="manage-bar"><button type="button" class="pick-all" data-act="order-pick-all"><i class="chk${picked.length && picked.length === deletable.length ? " on" : ""}">${icon("check", 11)}</i>全选</button><small>进行中的订单不能删</small><button type="button" class="btn sm danger" data-act="order-delete-picked"${picked.length ? "" : " disabled"}>删除${picked.length ? `（${picked.length}）` : ""}</button></div>` : ""}`;
  },
};
actions["order-tab"] = d => { state.orderTab = d.tab; render(true); };
actions["noop"] = () => toast("进行中的订单不能删");
actions["order-manage"] = () => { state.orderManage = !state.orderManage; state.orderPicked = []; render(); };
actions["order-pick"] = d => {
  const list = state.orderPicked;
  state.orderPicked = list.includes(d.id) ? list.filter(x => x !== d.id) : list.concat(d.id);
  render();
};
actions["order-pick-all"] = () => {
  const now = Date.now(), all = state.orders.filter(o => canDelete(o, now)).map(o => o.id);
  state.orderPicked = state.orderPicked.length === all.length ? [] : all;
  render();
};
actions["order-delete-picked"] = async () => {
  const now = Date.now(), list = state.orders.filter(o => state.orderPicked.includes(o.id) && canDelete(o, now));
  if (!list.length || !await confirmBox(`删除 ${list.length} 张订单？`, "只删除外卖 APP 里的记录，聊天里的卡片不受影响。")) return;
  await busy("正在删除…", async () => { for (const o of list) { await cancelArrival(o); await deleteOrder(o); } });
  await syncContext();
  state.orderPicked = []; state.orderManage = false;
  toast(`删掉了 ${list.length} 张`);
  render();
};
actions["open-order"] = d => {
  if (state.view === "order") { state.params = { id: d.id }; render(true); return; }
  go("order", { id: d.id });
};

const TRACK_STEPS = [["accepted", "接单"], ["cooking", "备餐"], ["picked", "取餐"], ["riding", "配送"], ["delivered", "送达"]];
const ERRAND_STEPS = [["accepted", "接单"], ["cooking", "购买"], ["picked", "买齐"], ["riding", "配送"], ["delivered", "送达"]];
const PICKUP_STEPS = [["accepted", "接单"], ["cooking", "制作"], ["delivered", "做好"]];
const STATE_EMOJI = { pending_pay: "⏳", pay_declined: "🙅", canceled: "🚫" };
const RIDER_NOTES = ["放门口就好", "到了打电话", "麻烦快一点", "小心别洒了"];
const RIDER_ACK = ["好的，收到", "好嘞，知道了", "收到，放心", "OK 马上"];
const TIPS = [2, 5, 10];

function stepsHtml(steps, stageIdx) {
  const lastOn = steps.reduce((last, [key], i) => STAGE_ORDER.indexOf(key) <= stageIdx ? i : last, -1);
  return `<div class="steps">${steps.map(([, label], i) => `<span class="${i <= lastOn ? "on" : ""}${i === lastOn ? " now" : ""}"><i>${i <= lastOn ? icon("check", 10) : ""}</i>${label}</span>`).join("")}</div>`;
}
/** 骑手头像：是角色就用角色头像 */
function riderChar(o) { return o.riderCharId ? state.characters.find(x => x.id === o.riderCharId) || null : null; }

/** 自取单的头部：大号取餐码 + 做好没有 */
function pickupHead(o, st, now) {
  const ready = st.delivered, stageIdx = STAGE_ORDER.indexOf(st.key);
  const [n, unit] = remainParts(st.remainMs), left = unit.replace("后送达", "");
  return `<section class="card status pickup">
      <div class="code-box"><small>取餐码</small><b>${esc(o.code || "—")}</b><span>${ready ? (o.pickedUpAt ? `${esc(when(o.pickedUpAt, now))} 取走了` : "餐做好了，报码取餐") : `预计 ${hhmm(o.deliverAt)} 做好，还要 ${n} ${left}`}</span></div>
      ${stepsHtml(PICKUP_STEPS, stageIdx)}
      <div class="rider-row"><i>${icon("pin", 16)}</i><span><b>${esc(o.shopName)}</b><small>距你 ${shopStats(orderShop(o)).km}km · 到店报取餐码</small></span>
        ${ready && !o.pickedUpAt ? `<button type="button" class="mini hot" data-act="order-picked-up" data-id="${esc(o.id)}">我已取餐</button>` : ""}</div>
    </section>`;
}

/** 骑手那一行之后：给骑手留话（配送中）/ 评价骑手、打赏（送到后） */
function riderExtras(o, live, delivered) {
  if (isPickup(o) || !o.rider) return "";
  const id = esc(o.id), rc = riderChar(o);
  if (live) {
    const sent = (o.notes || []).map(x => x.text);
    return `<div class="rider-notes"><small>给骑手捎句话</small>${RIDER_NOTES.map(t => `<button type="button" class="${sent.includes(t) ? "on" : ""}" data-act="rider-note" data-id="${id}" data-text="${esc(t)}"${sent.includes(t) ? " disabled" : ""}>${esc(t)}</button>`).join("")}</div>`;
  }
  if (!delivered) return "";
  return `<section class="card rider-card"><div class="rider-row"><i>${rc ? avatarHtml(rc, "sm") : icon("scooter", 17)}</i><span><b>骑手 ${esc(o.rider)}</b><small>${o.riderRate ? (o.riderRate === "good" ? "你给了好评" : "你给了差评") : "这次送得怎么样？"}${o.riderTip ? ` · 打赏了 ${yuan(o.riderTip)}` : ""}</small></span>
      ${o.riderRate ? "" : `<button type="button" class="mini" data-act="rider-rate" data-id="${id}" data-rate="bad">不满意</button><button type="button" class="mini hot" data-act="rider-rate" data-id="${id}" data-rate="good">满意</button>`}</div>
    ${o.riderTip ? "" : `<div class="tips"><small>打赏骑手</small>${TIPS.map(n => `<button type="button" data-act="rider-tip" data-id="${id}" data-amount="${n}">${yuan(n)}</button>`).join("")}</div>`}</section>`;
}

views.order = {
  title: "订单详情",
  tone: "plain",
  render(p) {
    const o = orderById(p.id);
    if (!o) return '<div class="empty"><span class="big">🧾</span><p>这张订单已经删除了</p></div>';
    const now = Date.now(), s = orderStatus(o, now), st = o.status === "active" ? stageAt(o, now) : null;
    const who = orderWho(o), shop = orderShop(o), id = esc(o.id), errand = o.mode === "errand";
    const live = st && !st.delivered;
    const stageIdx = st ? STAGE_ORDER.indexOf(st.key) : -1;
    const chatBtn = o.charId ? `<button type="button" class="mini" data-act="open-chat" data-id="${esc(o.charId)}">去聊天</button>` : "";
    const againBtn = shopById(o.shopId) ? `<button type="button" class="mini" data-act="order-again" data-id="${id}">再来一单</button>` : "";
    const shareBtn = state.characters.length && st && st.delivered ? `<button type="button" class="mini" data-act="share-open" data-kind="order" data-id="${id}">${icon("share", 11)}晒单</button>` : "";
    let head = "";
    if (st && isPickup(o)) {
      head = pickupHead(o, st, now);
    } else if (live) {
      const [n, unit] = remainParts(st.remainMs), left = unit.replace("后送达", "");
      const picked = stageIdx >= STAGE_ORDER.indexOf("picked");
      const rc = riderChar(o);
      const homeAva = o.groupId ? '<span class="ava ph grp">群</span>' : o.recipient ? avatarHtml(state.characters.find(x => x.id === o.recipient)) : '<span class="ava ph">我</span>';
      const latest = st.passed[st.passed.length - 1];
      head = `<div class="mapwrap">${mapHtml(o, shop, now, picked ? `${n} ${left}` : errand ? "去买东西" : "去取餐", homeAva, { fromLabel: errand ? o.storeName || "店里" : "商家", riderHtml: rc ? avatarHtml(rc, "sm") : "" })}</div>
        <section class="card status">
          <h2>${esc(s.text)}</h2>
          <p class="eta-line">预计 <b>${hhmm(o.deliverAt)}</b> 送达，还有 <b>${n}</b> ${left}${who ? ` · ${esc(who)}` : ""}</p>
          ${stepsHtml(errand ? ERRAND_STEPS : TRACK_STEPS, stageIdx)}
          <div class="rider-row"><i>${rc ? avatarHtml(rc, "sm") : icon("scooter", 17)}</i><span><b>骑手 ${esc(o.rider || "")}</b><small>${esc(latest ? latest.text : s.text)}</small></span>
            <button type="button" class="mini hot" data-act="order-urge" data-id="${id}"${o.urged ? " disabled" : ""}>${o.urged ? "已催单" : "催单"}</button>${rc ? `<button type="button" class="mini" data-act="open-chat" data-id="${esc(rc.id)}">${icon("phone", 11)}</button>` : chatBtn}</div>
          ${riderExtras(o, true, false)}
          <div class="rider-row speed"><span>配送速度</span><div class="seg">${Object.entries(SPEEDS).map(([k, v]) => `<button type="button" class="${o.speed === k ? "on" : ""}" data-act="order-speed" data-id="${id}" data-speed="${k}">${v.label}</button>`).join("")}</div></div>
        </section>`;
    } else if (st) {
      const took = Math.max(1, Math.round((o.deliverAt - (o.paidAt || o.createdAt)) / 60000));
      head = `<section class="card status"><div class="status-top"><div><h2>${errand ? "跑腿已送达" : "订单已送达"}</h2><p class="eta-line">${esc(when(o.deliverAt, now))} 送到${who ? " · " + esc(who) : ""} · 用时 ${took} 分钟</p></div><i class="big">🛍️</i></div>
        ${againBtn || chatBtn || shareBtn ? `<div class="quick">${againBtn}${shareBtn}${chatBtn}</div>` : ""}</section>`;
    } else {
      const tip = o.status === "pending_pay" ? (o.source === "payreq" ? "代付请求已经发到聊天里，TA 同意后开始配送。" : o.source === "split" ? `你已经付了自己那一半 ${yuan(o.userPaid)}，TA 答应拼单后开始配送。` : "这张订单还没付款。")
        : o.status === "pay_declined" ? `TA ${o.source === "split" ? "不想拼" : "没有帮你付"}${o.payWords ? `：「${esc(o.payWords)}」` : "。"}` : "订单已取消。";
      head = `<section class="card status"><div class="status-top"><div><h2>${esc(s.text)}</h2><p class="eta-line">${tip}</p></div><i class="big">${STATE_EMOJI[o.status] || "🧾"}</i></div></section>`;
    }
    const delivered = !!(st && st.delivered);
    const issue = o.issue && delivered ? o.issue : null;
    const mine = o.payer === "user" || o.payer === "split";
    const canCancel = o.status === "pending_pay" || o.status === "pay_declined" || (live && stageIdx < STAGE_ORDER.indexOf("picked") && mine);
    const rest = round1c(o.total - paidOf(o));
    const waitingChar = o.status === "pay_declined" || (o.status === "pending_pay" && (o.source === "payreq" || o.source === "split"));
    const feed = st ? st.passed.map(e => ({ at: e.at, text: e.text })).concat((o.notes || []).filter(x => x.at <= now).flatMap(x => [{ at: x.at, text: `你：${x.text}`, me: true }, ...(x.reply && x.replyAt <= now ? [{ at: x.replyAt, text: `骑手：${x.reply}` }] : [])])).sort((a, b) => b.at - a.at) : [];
    const sales = o.afterSales || [];
    return `${head}
      ${waitingChar ? `<div class="btns"><button type="button" class="btn" data-act="order-pay-self" data-id="${id}">${o.source === "split" ? `另一半我来付 ${yuan(rest)}` : `改成自己付 ${yuan(rest)}`}</button><button type="button" class="btn ghost" data-act="open-chat" data-id="${esc(o.charId)}">去聊天</button></div>` : ""}
      ${issue ? `<section class="card issue"><h3>这一单出了点状况</h3><p>${esc(issue.text)}。</p>${issue.resolved
        ? `<p class="hint">${issue.resolved === "refund" ? `已退 ${yuan(issue.amount)} 红包，下次下单自动抵扣。` : "你选择了不计较。"}</p>`
        : (mine ? `<div class="btns"><button type="button" class="btn" data-act="issue-refund" data-id="${id}">申请退款 ${yuan(Math.min(issue.amount, refundable(o)))}</button><button type="button" class="btn ghost" data-act="issue-skip" data-id="${id}">算了</button></div><p class="hint">退款以红包形式返还（钱包暂不支持原路退回）。</p>` : "")}</section>` : ""}
      ${o.groupId && st ? `<section class="card group-talk"><h3>${icon("chat", 14)}群里怎么说<small>${esc(o.groupName || "群聊")}</small></h3>${o.groupTalk && o.groupTalk.length
        ? `<div class="talk">${o.groupTalk.map(t => `<div>${avatarHtml(state.characters.find(c => c.id === t.id), "sm")}<span><b>${esc(t.name)}</b>${esc(t.line)}</span></div>`).join("")}</div>${delivered && o.groupTalkAt < o.deliverAt ? `<button type="button" class="mini" data-act="group-talk" data-id="${id}">送到了，再听听</button>` : ""}`
        : `<p class="hint">群聊里的大家已经知道你请客了。</p><button type="button" class="mini hot" data-act="group-talk" data-id="${id}">看看大家怎么说</button>`}</section>` : ""}
      ${riderExtras(o, false, delivered)}
      ${delivered && !o.recipient && !o.groupId ? `<section class="card rate-card"><h3>${o.review ? "我的评价" : "这一单怎么样？"}</h3>${o.review
        ? `<p class="stars">${"★".repeat(o.review.stars)}${"☆".repeat(5 - o.review.stars)}</p>${o.review.text ? `<p class="hint">${esc(o.review.text)}</p>` : ""}`
        : `<div class="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-act="order-rate" data-id="${id}" data-stars="${n}" aria-label="${n} 星">★</button>`).join("")}</div><p class="hint">点星星打分${o.charId ? "，TA 之后聊天时会知道你觉得怎么样" : ""}。</p>`}</section>` : ""}
      ${st ? `<section class="card"><h3>${icon("box", 14)}${isPickup(o) ? "订单动态" : "配送动态"}${delivered && chatBtn ? `<small>${chatBtn}</small>` : ""}</h3><ol class="feed">${feed.map((e, i) => `<li class="${i === 0 ? "now" : ""}${e.me ? " me" : ""}"><time>${hhmm(e.at)}</time><span>${esc(e.text)}</span></li>`).join("")}</ol></section>` : ""}
      <section class="card receipt">
        <div class="receipt-head">${shopCover(shop, 30)}<span><b>${esc(o.shopName)}</b><small>共 ${itemCount(o)} 件${who ? " · " + esc(who) : ""}</small></span>${live ? againBtn : ""}</div>
        ${(o.items || []).map(it => `<div class="line">${dishCover(itemEmoji(it.name, shop), shop.color, 30)}<span>${esc(it.name)}</span><span>×${it.qty}</span><b>${it.price ? yuan(it.price * it.qty) : ""}</b></div>`).join("")}
        <div class="cut"></div>
        ${o.source === "directive" ? '<div class="line total"><span>合计</span><b>TA 请客</b></div>' : `
          ${o.pack ? `<div class="line sub"><span>包装费</span><b>${yuan(o.pack)}</b></div>` : ""}
          ${isPickup(o) ? "" : `<div class="line sub"><span>${errand ? "跑腿费" : "配送费"}</span><b>${o.fee ? (o.feeOff ? `<s>${yuan(o.fee)}</s> ${o.feeOff >= o.fee ? "0" : yuan(round1c(o.fee - o.feeOff))}` : yuan(o.fee)) : "免费"}</b></div>`}
          ${o.pickupOff ? `<div class="line sub"><span>自取立减</span><b class="minus">−${yuan(o.pickupOff)}</b></div>` : ""}
          ${o.off ? `<div class="line sub"><span>满减</span><b class="minus">−${yuan(o.off)}</b></div>` : ""}
          ${o.coupon ? `<div class="line sub"><span>红包</span><b class="minus">−${yuan(o.coupon)}</b></div>` : ""}
          <div class="line total"><span>合计</span><b>${yuan(o.total)}</b></div>
          ${o.payer === "split" ? `<div class="line sub"><span>你付了</span><b>${yuan(o.userPaid)}</b></div>` : ""}
          ${o.refunded ? `<div class="line sub"><span>已退（红包）</span><b class="minus">${yuan(o.refunded)}</b></div>` : ""}`}
        ${delivered ? `<i class="stamp">已<br>${isPickup(o) ? "做好" : "送达"}</i>` : ""}
      </section>
      ${delivered && mine ? `<section class="card after"><h3>${icon("shield", 14)}售后${sales.length ? `<small>已处理 ${sales.length} 次</small>` : ""}</h3>
        ${sales.map(x => `<div class="line sub"><span>${esc(x.label)}${x.item ? `「${esc(x.item)}」` : ""}</span><b class="minus">退 ${yuan(x.amount)}</b></div>`).join("")}
        ${refundable(o) > 0 ? `<button type="button" class="upsell" data-act="after-open" data-id="${id}">${icon("chat", 13)}<span>少送、洒了、送错、太慢？申请售后</span>${icon("right", 12)}</button>` : '<p class="hint">已经全额退完了。</p>'}</section>` : ""}
      <section class="card kv">
        <div><span>订单号</span><b>${esc(o.no)}</b></div>
        <div><span>下单时间</span><b>${esc(when(o.createdAt, now))}</b></div>
        ${o.code ? `<div><span>取餐码</span><b>${esc(o.code)}</b></div>` : ""}
        ${o.address ? `<div><span>地址</span><b>${esc(o.address)}</b></div>` : ""}
        ${o.note ? `<div><span>${o.source === "directive" ? "TA 的留言" : o.groupId ? "附言" : "备注"}</span><b>${esc(o.note)}</b></div>` : ""}
        ${o.rider && st ? `<div><span>骑手</span><b>${esc(o.rider)}</b></div>` : ""}
      </section>
      <div class="btns">
        ${canCancel ? `<button type="button" class="btn ghost danger" data-act="order-cancel" data-id="${id}">取消订单</button>` : ""}
        ${!live && o.status !== "pending_pay" && !(isPickup(o) && st && !o.pickedUpAt) ? `<button type="button" class="btn ghost danger" data-act="order-delete" data-id="${id}">删除订单</button>` : ""}
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
actions["rider-note"] = async d => {
  const o = orderById(d.id), now = Date.now();
  if (!o || !isOnTheWay(o, now) || (o.notes || []).some(x => x.text === d.text)) return;
  const reply = RIDER_ACK[(hashSeed(o.id + d.text) >>> 0) % RIDER_ACK.length];
  await patchOrder(o, { notes: (o.notes || []).concat({ at: now, text: d.text, reply, replyAt: Math.min(now + 6000, o.deliverAt - 1000) }) });
  toast("已经告诉骑手了");
  render();
};
actions["rider-rate"] = async d => {
  const o = orderById(d.id);
  if (!o || o.riderRate) return;
  await patchOrder(o, { riderRate: d.rate === "bad" ? "bad" : "good" });
  toast(d.rate === "bad" ? "已反馈，我们会提醒骑手" : "谢谢你的好评");
  render();
};
actions["rider-tip"] = async d => {
  const o = orderById(d.id), amount = Number(d.amount) || 0;
  if (!o || o.riderTip || !amount) return;
  if (!await confirmBox(`打赏骑手 ${yuan(amount)}？`, "从钱包默认账户付款。")) return;
  try {
    await busy("正在打赏…", async () => {
      const paid = await api.wallet.pay({ amount, title: `外卖 · 打赏骑手${o.rider}`, detail: o.shopName, category: "外卖", relatedOrderId: o.no });
      if (!paid || paid.ok === false) throw new Error((paid && paid.error) || "付款失败");
      await patchOrder(o, { riderTip: amount });
      const rc = riderChar(o);
      if (rc) {
        const names = await namesFor(rc.id);
        await api.chat.writeHistory({ characterId: rc.id, role: "user", content: `[外卖：${names.userName}给送外卖的${names.charName}打赏了 ${yuan(amount)}。]` }).catch(() => {});
        await syncContext();
      }
    });
    toast(`打赏了 ${yuan(amount)}`);
    render();
  } catch (error) { fail(error, "打赏没成功"); }
};
actions["order-picked-up"] = async d => {
  const o = orderById(d.id);
  if (!o || o.pickedUpAt) return;
  await patchOrder(o, { pickedUpAt: Date.now() });
  toast("取到啦，趁热吃");
  render();
};
actions["order-pay-self"] = async d => {
  const o = orderById(d.id);
  if (!o || !["pending_pay", "pay_declined"].includes(o.status)) return;
  const rest = round1c(o.total - paidOf(o));
  const wallet = await api.wallet.get();
  const account = (wallet.accounts || []).find(a => a.id === wallet.defaultAccountId) || (wallet.accounts || [])[0];
  if (!await confirmBox(o.source === "split" ? "另一半自己付？" : "改成自己付？", `从「${account ? account.title || "钱包" : "钱包"}」付 ${yuan(rest)}，付完马上开始配送。`)) return;
  try {
    await busy("正在付款…", async () => {
      if (rest > 0) {
        const paid = await api.wallet.pay({ amount: rest, accountId: account ? account.id : undefined, title: `外卖 · ${o.shopName}`, detail: itemsText(o).slice(0, 200), category: "外卖", relatedOrderId: o.no });
        if (!paid || paid.ok === false) throw new Error((paid && paid.error) || "付款失败");
      }
      await patchOrder(o, { payer: "user", source: "app", charId: "", userPaid: o.total });
      await startDelivery(o, Date.now());
      await updateOrderCard(o, { status: "已自己付款", actions: [{ label: "查看订单" }] });
    });
  } catch (error) { fail(error, "付款没成功"); return; }
  render();
};
actions["order-cancel"] = async d => {
  const o = orderById(d.id);
  if (!o) return;
  const refund = refundable(o);
  if (!await confirmBox("取消这张订单？", refund > 0 ? `已付的 ${yuan(refund)} 会以红包返还（钱包暂不支持原路退回）。` : "取消后不会配送。")) return;
  await cancelArrival(o);
  await patchOrder(o, { status: "canceled", canceledAt: Date.now(), refunded: round1c((Number(o.refunded) || 0) + refund) });
  if (refund > 0) await addCoupon(refund, `订单 ${o.no} 取消退回`);
  await updateOrderCard(o, { status: "已取消", actions: [{ label: "查看订单" }] });
  if (o.charId && o.cardMessageId) {
    const names = await namesFor(o.charId);
    await api.chat.writeHistory({ characterId: o.charId, role: "user", content: `[外卖：${names.userName}取消了「${o.shopName}」的这份外卖，不会送来了。]` }).catch(() => {});
  }
  await syncContext();
  toast(refund > 0 ? "已取消，退款已发成红包" : "已取消");
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
  state.recipient = o.groupId ? "g:" + o.groupId : o.recipient || "";
  state.mode = isPickup(o) && !state.recipient ? "pickup" : "delivery";
  go("shop", { id: shop.id });
};

/** 退一笔售后：记在订单上，不超过你实际付的钱，以红包退回 */
async function refundOrder(o, amount, reason, extra) {
  const n = Math.min(round1c(amount), refundable(o));
  if (n <= 0) return 0;
  await addCoupon(n, reason);
  await patchOrder(o, { refunded: round1c((Number(o.refunded) || 0) + n), ...extra });
  return n;
}
actions["issue-refund"] = async d => {
  const o = orderById(d.id);
  if (!o || !o.issue || o.issue.resolved) return;
  const n = await refundOrder(o, o.issue.amount, o.issue.type === "missing" ? `少送「${o.issue.item}」退款` : "餐品洒漏补偿", { issue: { ...o.issue, resolved: "refund", amount: Math.min(o.issue.amount, refundable(o)) } });
  toast(n ? `已退 ${yuan(n)} 红包` : "这一单已经退完了");
  render();
};
actions["issue-skip"] = async d => {
  const o = orderById(d.id);
  if (!o || !o.issue || o.issue.resolved) return;
  await patchOrder(o, { issue: { ...o.issue, resolved: "skip" } });
  render();
};

// ── 售后：少送（退那一件）、洒了（退一半餐费）、送错（全退）、太慢（退配送费）──
const AFTER_TYPES = [
  { key: "missing", label: "少送了", hint: "选少了哪样，退那一份" },
  { key: "spilled", label: "洒了 / 漏了", hint: "退一半餐费" },
  { key: "wrong", label: "送错了", hint: "整单退" },
  { key: "slow", label: "送得太慢", hint: "退配送费" },
];
function afterAmount(o, key, item) {
  if (key === "missing") { const it = (o.items || []).find(x => x.name === item); return it ? it.price : 0; }
  if (key === "spilled") return round1c((o.subtotal || 0) / 2);
  if (key === "wrong") return refundable(o);
  if (key === "slow") return Math.max(0, (o.fee || 0) - (o.feeOff || 0));
  return 0;
}
let afterDraft = null;
function afterSheetHtml(o) {
  const done = (o.afterSales || []).map(x => x.type);
  const types = AFTER_TYPES.filter(t => !done.includes(t.key) && !(t.key === "slow" && (isPickup(o) || afterAmount(o, "slow") <= 0)));
  if (!types.some(t => t.key === afterDraft.type)) afterDraft.type = types[0] ? types[0].key : "";
  const priced = (o.items || []).filter(it => it.price > 0);
  if (afterDraft.type === "missing" && !priced.some(it => it.name === afterDraft.item)) afterDraft.item = priced[0] ? priced[0].name : "";
  const amount = Math.min(afterAmount(o, afterDraft.type, afterDraft.item), refundable(o));
  if (!types.length) return '<p class="hint">能申请的售后都申请过了。</p>';
  return `<div class="rows">${types.map(t => `<button type="button" class="row${afterDraft.type === t.key ? " on" : ""}" data-act="after-type" data-type="${t.key}"><span>${esc(t.label)}<small> · ${esc(t.hint)}</small></span><em>${icon("check", 12)}</em></button>`).join("")}</div>
    ${afterDraft.type === "missing" ? `<div class="chips after-items">${priced.map(it => `<button type="button" class="${afterDraft.item === it.name ? "on" : ""}" data-act="after-item" data-name="${esc(it.name)}">${esc(it.name)}</button>`).join("")}</div>` : ""}
    <p class="hint">预计退 <b>${yuan(amount)}</b>，以红包返还，下次下单自动抵扣。这一单还能退 ${yuan(refundable(o))}。</p>
    <button type="button" class="btn" data-act="after-submit" data-id="${esc(o.id)}"${amount > 0 ? "" : " disabled"}>提交售后</button>`;
}
actions["after-open"] = d => {
  const o = orderById(d.id);
  if (!o) return;
  afterDraft = { id: o.id, type: "", item: "" };
  openSheet("申请售后", afterSheetHtml(o));
};
actions["after-type"] = d => { const o = orderById(afterDraft.id); afterDraft.type = d.type; $("sheet-body").innerHTML = afterSheetHtml(o); };
actions["after-item"] = d => { const o = orderById(afterDraft.id); afterDraft.item = d.name; $("sheet-body").innerHTML = afterSheetHtml(o); };
actions["after-submit"] = async d => {
  const o = orderById(d.id);
  if (!o || !afterDraft || (o.afterSales || []).some(x => x.type === afterDraft.type)) return;
  const t = AFTER_TYPES.find(x => x.key === afterDraft.type);
  if (!t) return;
  const item = t.key === "missing" ? afterDraft.item : "";
  const want = afterAmount(o, t.key, item);
  const n = Math.min(round1c(want), refundable(o));
  if (n <= 0) return;
  await refundOrder(o, n, `售后：${t.label}${item ? `「${item}」` : ""}`, { afterSales: (o.afterSales || []).concat({ type: t.key, label: t.label, item, amount: n, at: Date.now() }) });
  closeSheet();
  toast(`已退 ${yuan(n)} 红包`);
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
  if (arrived.length) { const a = arrived[0]; toast(isPickup(a) ? `${a.shopName} 的餐做好了，取餐码 ${a.code}` : `${a.shopName} 的外卖送到了`); syncContext(); }
  const moving = state.orders.some(o => isOnTheWay(o, now));
  if ((moving || arrived.length) && ["orders", "order", "home"].includes(state.view) && !$("app").classList.contains("sheet-open") && document.activeElement && document.activeElement.tagName !== "INPUT") render();
}
