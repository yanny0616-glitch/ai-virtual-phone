// ── 我的：账单小结、红包、地址和口味、配送设置、和聊天的联动开关、数据 ──
const TOGGLES = [
  ["incidents", "配送小插曲", "偶尔下雨、绕路，或者少送一样"],
  ["replyOnArrive", "送到后请 TA 说句话", "和角色有关的订单送达时，请 TA 在聊天里回应（会调用一次模型）"],
  ["autoAccept", "TA 点的外卖自动接单", "关掉后要你点开聊天里的卡片才开始配送"],
  ["contextOn", "让 TA 知道外卖进度", "聊天时 TA 能看到外卖到哪了，不会刚下单就问好不好吃"],
  ["aiShops", "AI 找店", "搜不到时让模型现编几家店和菜单（每次调用一次模型）"],
];

views.me = {
  title: "我的",
  tone: "brand",
  render() {
    const s = state.settings, now = Date.now(), coupons = usableCoupons(), fees = feeCoupons();
    const hidden = SEEDS.filter(x => s.hiddenSeeds.includes(x.id));
    const spent = round1c(state.orders.filter(o => o.status === "active").reduce((sum, o) => sum + paidOf(o) - (Number(o.refunded) || 0), 0));
    const rider = s.riderChar ? state.characters.find(c => c.id === s.riderChar) : null;
    const vip = isMember(now);
    const gifts = state.orders.filter(o => o.recipient && o.status === "active").length;
    const treats = state.orders.filter(o => o.source === "directive" && o.status === "active").length;
    return `
      <div class="hero me-hero"><span class="ava ph lg">我</span><span><b>我的外卖</b><small>给 TA 点过 ${gifts} 单 · TA 请过我 ${treats} 单</small></span></div>
      <section class="card stats">
        <div><b>${state.orders.length}</b><small>全部订单</small></div>
        <div><b><i>¥</i>${spent}</b><small>累计花费</small></div>
        <div><b><i>¥</i>${Math.round(coupons.reduce((sum, c) => sum + c.amount, 0) * 10) / 10}</b><small>可用红包</small></div>
      </section>
      <div class="me-entries">
        <button type="button" class="member-strip${vip ? " on" : ""}" data-act="open-member">${icon("crown", 15)}<span><b>${vip ? "外卖会员" : "开通外卖会员"}</b><small>${vip ? `${esc(when(s.member.until, now))} 到期 · 本月省 ${yuan(s.member.monthSaved || 0)}` : "每月 4 张红包 · 免配送费"}</small></span>${icon("right", 12)}</button>
        <button type="button" class="me-entry" data-act="open-coupons"><i>🎟️</i><span>领券中心</span>${claimableCount() ? `<em>${claimableCount()}</em>` : ""}</button>
        <button type="button" class="me-entry" data-act="open-errand"><i>🛵</i><span>跑腿帮买</span></button>
      </div>
      <section class="card">
        <h3>${icon("ticket", 14)}我的券包<small>${coupons.length + fees.length} 张可用</small></h3>
        ${coupons.length + fees.length ? `<div class="coupon-list">${fees.concat(coupons).slice(0, 6).map(c => couponCard(c, now)).join("")}</div>${coupons.length + fees.length > 6 ? '<button type="button" class="link" data-act="open-coupons">看全部</button>' : ""}` : '<p class="hint">退款、补偿和领到的券都在这里，下单时自动抵扣。</p>'}
      </section>
      <section class="card">
        <h3>${icon("pin", 14)}我的收货信息</h3>
        <div class="frow" data-act="my-address"><span>地址簿</span><b>${s.addresses.length ? `${s.addresses.length} 个 · ${esc(s.userAddress || "未选")}` : "还没有"}</b><span class="chev">${icon("right", 12)}</span></div>
        <label class="frow"><span>忌口</span><input data-change="set-text" data-key="userTaboo" placeholder="比如 不吃香菜、海鲜过敏" value="${esc(s.userTaboo)}"></label>
        <p class="hint">忌口会告诉给你点外卖的角色，AI 找店时也会参考。</p>
      </section>
      <section class="card">
        <h3>${icon("scooter", 14)}配送</h3>
        <div class="frow col"><span>新订单的速度</span><div class="seg">${Object.entries(SPEEDS).map(([k, v]) => `<button type="button" class="${s.speed === k ? "on" : ""}" data-act="set-speed" data-speed="${k}">${v.label}<small>${v.hint}</small></button>`).join("")}</div></div>
        ${TOGGLES.slice(0, 1).map(toggleRow).join("")}
        <label class="frow"><span>谁来送</span><select data-change="set-rider">${['<option value="">随机骑手</option>'].concat(state.characters.map(c => `<option value="${esc(c.id)}"${c.id === s.riderChar ? " selected" : ""}>${esc(c.name)}</option>`)).join("")}</select><span class="chev">${icon("right", 12)}</span></label>
        <p class="hint">${rider ? `之后的外卖都由 ${esc(rider.name)} 来送。TA 在聊天里知道自己正在给谁送、送到了没有，打赏也会告诉 TA。` : "选一位角色当骑手，之后的外卖就由 TA 来送。"}</p>
      </section>
      <section class="card">
        <h3>${icon("chat", 14)}和聊天的联动</h3>
        ${TOGGLES.slice(1, 4).map(toggleRow).join("")}
        <p class="hint">TA 想请你吃东西时，会在聊天里发一张外卖卡片；你也可以在聊天的 + 号面板里选「给 TA 点外卖」。</p>
      </section>
      <section class="card">
        <h3>${icon("store", 14)}店铺</h3>
        ${toggleRow(TOGGLES[4])}
        <label class="frow"${s.aiShops ? "" : " hidden"}><span>地区 / 风格</span><input data-change="set-text" data-key="locale" placeholder="比如 上海、架空古风小镇（可不填）" value="${esc(s.locale)}"></label>
        <div class="frow"><span>AI 生成的店</span><b>${state.aiShops.length} 家</b>${state.aiShops.length ? '<button type="button" class="mini danger" data-act="clear-ai-shops">全部删除</button>' : ""}</div>
        <div class="frow"><span>收藏的店</span><b>${s.likedShops.length} 家</b>${s.likedShops.length ? '<button type="button" class="mini" data-act="show-liked">去看看</button>' : ""}</div>
        ${hidden.length ? `<div class="frow"><span>隐藏的内置店</span><b>${hidden.length} 家</b><button type="button" class="mini" data-act="restore-seeds">恢复</button></div>` : ""}
      </section>
      <section class="card">
        <h3>${icon("cog", 14)}数据</h3>
        <div class="frow"><span>订单记录</span><b>${state.orders.length} 张</b>${state.orders.length ? '<button type="button" class="mini danger" data-act="clear-orders">清空已完成</button>' : ""}</div>
      </section>`;
  },
};
function toggleRow([key, label, hint]) {
  const on = !!state.settings[key];
  return `<div class="frow sw-row" data-act="toggle" data-key="${key}"><span class="grow"><b>${label}</b><small>${hint}</small></span><button type="button" class="sw${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${label}"></button></div>`;
}

actions["set-rider"] = async (d, node) => { await saveSettings({ riderChar: node.value }); render(); };
actions["toggle"] = async d => {
  await saveSettings({ [d.key]: !state.settings[d.key] });
  if (d.key === "contextOn") await syncContext();
  render();
};
actions["set-text"] = async (d, node) => {
  await saveSettings({ [d.key]: node.value.trim().slice(0, 80) });
  if (d.key === "userTaboo") await syncContext();
};
actions["show-liked"] = () => { state.onlyLiked = true; state.category = "全部"; state.query = ""; go("home"); };
actions["set-speed"] = async d => { await saveSettings({ speed: d.speed }); render(); };
actions["restore-seeds"] = async () => { await saveSettings({ hiddenSeeds: [] }); toast("内置店铺已恢复"); render(); };
actions["clear-ai-shops"] = async () => {
  if (!await confirmBox("删除全部 AI 店铺？", "已有订单不受影响。")) return;
  for (const s of [...state.aiShops]) await api.db.delete("shops", s.id);
  state.aiShops = [];
  if (!shopById(state.cart.shopId)) state.cart = emptyCart();
  render();
};
actions["clear-orders"] = async () => {
  const now = Date.now();
  const done = state.orders.filter(o => o.status === "canceled" || isDelivered(o, now));
  if (!done.length) { toast("没有已完成的订单"); return; }
  if (!await confirmBox(`清空 ${done.length} 张已完成的订单？`, "配送中和等待付款的订单会保留。聊天里的卡片不受影响。")) return;
  for (const o of done) await deleteOrder(o);
  await syncContext();
  render();
};
