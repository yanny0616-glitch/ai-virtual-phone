// ── 跑腿帮买：列个清单，骑手去店里买齐了送过来。东西钱按你估的价先付，跑腿费按距离 ──
const ERRAND_STORES = [
  { key: "超市", emoji: "🛒", km: 1.2 },
  { key: "药店", emoji: "💊", km: 0.9 },
  { key: "便利店", emoji: "🏪", km: 0.4 },
  { key: "水果店", emoji: "🍉", km: 0.8 },
  { key: "就近随便买", emoji: "📍", km: 0.6 },
];
const errand = { store: "便利店", items: [{ name: "", price: "" }], to: "", note: "" };
const errandFee = km => round1c(6 + km * 2);

function errandState() {
  const store = ERRAND_STORES.find(s => s.key === errand.store) || ERRAND_STORES[0];
  const items = errand.items.map(it => ({ name: String(it.name || "").trim().slice(0, 30), qty: 1, price: Math.max(0, round1c(Number(it.price) || 0)) })).filter(it => it.name);
  const goods = round1c(items.reduce((s, it) => s + it.price, 0));
  const fee = errandFee(store.km), feeOff = isMember() ? Math.min(fee, 3) : 0;
  return { store, items, goods, fee, feeOff, total: round1c(goods + fee - feeOff) };
}

views.errand = {
  title: "跑腿帮买",
  tone: "plain",
  render() {
    const e = errandState();
    const toName = errand.to ? (state.characters.find(c => c.id === errand.to) || {}).name || "TA" : "";
    return `
      <section class="card errand-head"><b>🛵 帮你跑一趟</b><small>写下要买的东西，骑手去店里买齐了送到。估个价先付，多退少不补（做成红包退）。</small></section>
      <section class="card">
        <h3>${icon("store", 14)}去哪买</h3>
        <div class="errand-stores">${ERRAND_STORES.map(s => `<button type="button" class="${s.key === e.store.key ? "on" : ""}" data-act="errand-store" data-key="${esc(s.key)}"><i>${s.emoji}</i>${esc(s.key)}<small>${s.km}km</small></button>`).join("")}</div>
      </section>
      <section class="card">
        <h3>${icon("bag", 14)}买什么<small>价格估个大概</small></h3>
        <div class="errand-items">${errand.items.map((it, i) => `<div class="errand-item"><input data-change="errand-input" data-i="${i}" data-key="name" maxlength="30" placeholder="${["一瓶冰可乐", "一盒创可贴", "两卷纸巾", "一把雨伞"][i % 4]}" value="${esc(it.name)}"><span class="yuan-in">¥<input type="number" inputmode="decimal" min="0" step="0.5" data-change="errand-input" data-i="${i}" data-key="price" data-rerender="1" placeholder="0" value="${esc(it.price)}"></span>${errand.items.length > 1 ? `<button type="button" class="addr-del" data-act="errand-del" data-i="${i}" aria-label="删掉这样">×</button>` : ""}</div>`).join("")}</div>
        ${errand.items.length < 8 ? `<button type="button" class="add-row" data-act="errand-add">+ 再加一样</button>` : ""}
      </section>
      <section class="card addr">
        <h3>${icon("pin", 14)}送给谁</h3>
        <div class="whos">${[["", '<span class="ava ph sm">我</span>', "我自己"]].concat(state.characters.map(c => [c.id, avatarHtml(c, "sm"), c.name])).map(([id, ava, name]) => `<button type="button" class="who${errand.to === id ? " on" : ""}" data-act="errand-to" data-id="${esc(id)}">${ava}${esc(name)}</button>`).join("")}</div>
        <div class="frow"><span>送到</span><b>${esc(errand.to ? state.settings.charAddress[errand.to] || `${toName} 那边` : state.settings.userAddress || "你这边")}</b></div>
        <label class="frow"><span>备注</span><input data-change="errand-input" data-key="note" maxlength="60" placeholder="比如：可乐要冰的、买不到就换同类" value="${esc(errand.note)}"></label>
      </section>
      <section class="card receipt">
        <div class="line sub"><span>商品（估价）</span><b>${yuan(e.goods)}</b></div>
        <div class="line sub"><span>跑腿费 · ${e.store.km}km${e.feeOff ? '<i class="tag vip">会员减 3</i>' : ""}</span><b>${e.feeOff ? `<s>${yuan(e.fee)}</s> ${yuan(e.fee - e.feeOff)}` : yuan(e.fee)}</b></div>
        <div class="line total"><span>合计</span><b>${yuan(e.total)}</b></div>
      </section>`;
  },
};
function errandDock() {
  const e = errandState();
  return `<span class="dock-sum"><span class="dock-total">合计 ${priceHtml(e.total)}</span><small>${e.items.length ? `${e.items.length} 样 · 跑腿费 ${yuan(e.fee - e.feeOff)}` : "先写要买什么"}</small></span>
    <button type="button" class="btn" data-act="errand-place"${e.items.length ? "" : " disabled"}>去下单</button>`;
}

actions["open-errand"] = () => go("errand", {});
actions["errand-store"] = d => { errand.store = d.key; render(); };
actions["errand-to"] = d => { errand.to = d.id; render(); };
actions["errand-add"] = () => { errand.items.push({ name: "", price: "" }); render(); setTimeout(() => { const list = document.querySelectorAll(".errand-item input[data-key=name]"); if (list.length) list[list.length - 1].focus(); }, 30); };
actions["errand-del"] = d => { errand.items.splice(Number(d.i), 1); render(); };
actions["errand-input"] = (d, node) => {
  if (d.key === "note") errand.note = node.value;
  else if (errand.items[Number(d.i)]) errand.items[Number(d.i)][d.key] = node.value;
  if (d.rerender) render(); else renderCartBar();
};
actions["errand-place"] = async () => {
  const e = errandState();
  if (!e.items.length) { toast("先写要买什么"); return; }
  const now = Date.now(), to = errand.to;
  const rider = state.settings.riderChar ? state.characters.find(x => x.id === state.settings.riderChar) : null;
  const data = {
    no: nextOrderNo(now), shopId: "", shopName: `跑腿帮买 · ${e.store.key}`, storeName: e.store.key, shopFactor: 0.8, items: e.items,
    mode: "errand", subtotal: e.goods, pack: 0, fee: e.fee, feeOff: e.feeOff, pickupOff: 0, off: 0, coupon: 0, couponId: "", total: e.total,
    recipient: to, charId: to, payer: "user", source: "app", userPaid: e.total,
    riderName: rider ? rider.name : "", riderCharId: rider ? rider.id : "",
    note: errand.note.trim(), address: to ? state.settings.charAddress[to] || "" : state.settings.userAddress || "",
    scheduledFor: 0, speed: state.settings.speed, status: "pending_pay", createdAt: now,
  };
  let order;
  try {
    order = await busy("正在下单…", async () => {
      const created = await createOrder(data);
      if (e.total > 0) {
        let paid = null, payError = null;
        try { paid = await api.wallet.pay({ amount: e.total, title: `跑腿帮买 · ${e.store.key}`, detail: e.items.map(it => it.name).join("、").slice(0, 200), category: "外卖", relatedOrderId: data.no }); }
        catch (error) { payError = error; }
        if (payError || !paid || paid.ok === false) { await deleteOrder(created); throw new Error((payError && payError.message) || (paid && paid.error) || "付款失败"); }
      }
      if (e.feeOff) await noteMemberSaving(e.feeOff);
      await startDelivery(created, now);
      if (created.recipient) await sendGiftCard(created);
      return created;
    });
  } catch (error) { fail(error, "没下成"); return; }
  errand.items = [{ name: "", price: "" }]; errand.note = "";
  toast("骑手接单了");
  state.stack = []; state.view = "orders"; state.params = {};
  go("order", { id: order.id });
};
