// ── 优惠：领券中心（平台券、运费券、商家券）、天天抽奖、会员 ──
const DAY_MS = 86400000;
/** 某天结束的时刻；plusDays = 2 就是后天晚上 23:59 */
function endOfDay(now, plusDays) { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime() + (plusDays || 0) * DAY_MS; }
const monthKey = now => { const d = new Date(now || Date.now()); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
const claimedToday = () => (state.settings.claimed.day === today() ? state.settings.claimed.ids : []);

/** 今天领券中心里有哪些券。商家券每天换 6 家店，按日期算，同一天看到的都一样 */
function todaysOffers() {
  const day = today();
  const list = [
    { id: "p_free", kind: "cash", amount: 3, min: 0, title: "3 元无门槛", note: "全场通用" },
    { id: "p_full30", kind: "cash", amount: 5, min: 30, title: "满 30 减 5", note: "全场通用" },
    { id: "p_full60", kind: "cash", amount: 12, min: 60, title: "满 60 减 12", note: "全场通用" },
    { id: "p_fee", kind: "fee", amount: 0, min: 0, title: "运费券", note: "免一单配送费" },
  ];
  const pool = SEEDS.filter(s => s.minOrder > 0 && !state.settings.hiddenSeeds.includes(s.id));
  for (let i = 0; i < 6 && pool.length; i++) {
    const s = pool.splice(hashSeed(`${day}|${i}`) % pool.length, 1)[0];
    const amount = 3 + hashSeed(day + s.id) % 6;
    const min = Math.max(s.minOrder + 10, amount * 5);
    list.push({ id: "s_" + s.id, kind: "cash", amount, min, shopId: s.id, title: `满 ${min} 减 ${amount}`, note: s.name });
  }
  return list;
}
function claimableCount() { const got = claimedToday(); return todaysOffers().filter(o => !got.includes(o.id)).length; }
async function claimOffer(offer) {
  const got = claimedToday();
  if (got.includes(offer.id)) return false;
  const reason = offer.kind === "fee" ? "运费券" : offer.shopId ? `${offer.note} 店铺红包` : `领券中心 · ${offer.title}`;
  await addCoupon(offer.amount, reason, { kind: offer.kind, min: offer.min, shopId: offer.shopId || "", expireAt: endOfDay(Date.now(), 2) });
  await saveSettings({ claimed: { day: today(), ids: [...got, offer.id] } });
  return true;
}
/** 店铺页信息卡里那一条店铺券 */
function shopCouponHtml(shop) {
  const offer = todaysOffers().find(o => o.shopId === shop.id);
  if (!offer) return "";
  const got = claimedToday().includes(offer.id);
  return `<div class="shop-coupon"><b>${priceHtml(offer.amount)}</b><span><em>店铺红包</em><small>满 ${offer.min} 可用 · 本店专享 · 3 天内有效</small></span><button type="button" class="mini${got ? "" : " hot"}" data-act="claim-offer" data-id="${esc(offer.id)}"${got ? " disabled" : ""}>${got ? "已领" : "领取"}</button></div>`;
}
function couponLimit(c) {
  if (couponKind(c) === "fee") return "免一单配送费";
  const shop = c.shopId ? shopById(c.shopId) : null;
  return `${c.min ? `满 ${c.min} 可用` : "无门槛"}${shop ? ` · 仅限${shop.name}` : ""}`;
}
function couponExpire(c, now) {
  if (!c.expireAt) return "长期有效";
  const days = Math.floor((endOfDay(c.expireAt) - endOfDay(now)) / DAY_MS);
  return days <= 0 ? "今天到期" : days === 1 ? "明天到期" : `${days} 天后到期`;
}
function couponCard(c, now) {
  const fee = couponKind(c) === "fee";
  return `<div class="coupon${fee ? " fee" : ""}"><b>${fee ? "<i>免运费</i>" : priceHtml(c.amount)}</b><span><em>${esc(c.reason)}</em><small>${esc(couponLimit(c))} · ${esc(couponExpire(c, now))}</small></span></div>`;
}

// ── 天天抽奖：一天一次，转盘八格 ──
const PRIZES = [
  { label: "¥1", amount: 1, w: 20 }, { label: "¥2", amount: 2, w: 20 }, { label: "¥3", amount: 3, w: 15 }, { label: "运费券", fee: true, w: 15 },
  { label: "¥5", amount: 5, w: 10 }, { label: "谢谢参与", w: 12 }, { label: "¥8", amount: 8, w: 6 }, { label: "¥18", amount: 18, w: 2 },
];
let wheelTurn = 0;   // 转盘已经转到的角度，下一次接着往后转
function wheelHtml() {
  const done = state.settings.lotteryDay === today();
  return `<section class="card lottery" id="lottery">
    <h3>${icon("gift", 14)}天天抽奖<small>${done ? "今天抽过了，明天再来" : "每天一次，抽到的红包自动放进券包"}</small></h3>
    <div class="wheel-box"><div class="wheel" id="wheel" style="transform:rotate(${wheelTurn}deg)">${PRIZES.map((p, i) => `<span style="--i:${i}"><b>${esc(p.label)}</b></span>`).join("")}</div>
      <button type="button" class="wheel-go" data-act="spin"${done ? " disabled" : ""}>${done ? "明天<br>再来" : "抽"}</button><i class="wheel-pin"></i></div>
  </section>`;
}
actions["spin"] = async () => {
  if (state.settings.lotteryDay === today()) { toast("今天已经抽过啦"); return; }
  const total = PRIZES.reduce((s, p) => s + p.w, 0);
  let r = Math.random() * total, idx = 0;
  while (idx < PRIZES.length - 1 && (r -= PRIZES[idx].w) >= 0) idx++;
  const prize = PRIZES[idx];
  await saveSettings({ lotteryDay: today() });          // 先记下，转的时候再点也不会抽第二次
  // 第 i 格的中心在 i*45+22.5 度；把它转到正上方的指针下面
  wheelTurn += 360 * 5 + (360 - (idx * 45 + 22.5) - wheelTurn % 360);
  const wheel = $("wheel");
  if (wheel) { wheel.classList.add("spinning"); wheel.style.transform = `rotate(${wheelTurn}deg)`; }
  const btn = document.querySelector('[data-act="spin"]'); if (btn) btn.disabled = true;
  await new Promise(r2 => setTimeout(r2, 2300));
  if (prize.fee) await addCoupon(0, "抽奖 · 运费券", { kind: "fee", expireAt: endOfDay(Date.now(), 2) });
  else if (prize.amount) await addCoupon(prize.amount, "抽奖红包", { expireAt: endOfDay(Date.now(), 2) });
  toast(prize.fee ? "抽中一张运费券！" : prize.amount ? `抽中 ${yuan(prize.amount)} 红包！` : "差一点点，明天再来");
  render();
};

views.coupons = {
  title: "领券中心",
  tone: "brand",
  render() {
    const now = Date.now(), got = claimedToday(), offers = todaysOffers();
    const offerRow = o => {
      const taken = got.includes(o.id);
      return `<div class="offer${o.kind === "fee" ? " fee" : ""}"><b>${o.kind === "fee" ? "<i>免运费</i>" : priceHtml(o.amount)}</b><span><em>${esc(o.title)}</em><small>${esc(o.note)} · 领后 3 天内有效</small></span>
        <button type="button" class="mini${taken ? "" : " hot"}" data-act="claim-offer" data-id="${esc(o.id)}"${taken ? " disabled" : ""}>${taken ? "已领" : "领取"}</button></div>`;
    };
    const mine = [...usableCoupons(), ...feeCoupons()];
    const gone = state.coupons.filter(c => !couponLive(c, now)).length;
    return `
      <div class="hero promo-hero"><b>${claimableCount() ? `今天还能领 ${claimableCount()} 张` : "今天的券都领完了"}</b><small>领到的券下单时自动挑最划算的那张</small>
        ${claimableCount() ? '<button type="button" class="btn" data-act="claim-all">一键全领</button>' : ""}</div>
      ${wheelHtml()}
      <section class="card"><h3>${icon("ticket", 14)}平台券</h3><div class="offers">${offers.filter(o => !o.shopId).map(offerRow).join("")}</div></section>
      <section class="card"><h3>${icon("store", 14)}今日商家券<small>每天换一批店</small></h3><div class="offers">${offers.filter(o => o.shopId).map(o => offerRow(o).replace('<span><em>', `<span class="go" data-act="open-shop" data-id="${esc(o.shopId)}"><em>`)).join("")}</div></section>
      <section class="card"><h3>${icon("wallet", 14)}我的券包<small>${mine.length} 张可用${gone ? ` · ${gone} 张已用或过期` : ""}</small></h3>
        ${mine.length ? `<div class="coupon-list">${mine.map(c => couponCard(c, now)).join("")}</div>` : '<p class="hint">还没有能用的券。退款、补偿、抽奖、领到的券都会放在这里。</p>'}</section>`;
  },
};
actions["open-coupons"] = () => go("coupons");
actions["open-lottery"] = () => { go("coupons"); const node = $("lottery"); if (node) node.scrollIntoView({ block: "start" }); };
actions["claim-offer"] = async d => {
  const offer = todaysOffers().find(o => o.id === d.id);
  if (!offer || !await claimOffer(offer)) { toast("今天已经领过这张了"); return; }
  toast(offer.kind === "fee" ? "运费券已放进券包" : `领到 ${yuan(offer.amount)} 红包`);
  render();
};
actions["claim-all"] = async () => {
  let n = 0;
  for (const offer of todaysOffers()) if (await claimOffer(offer)) n++;
  toast(n ? `领到 ${n} 张券` : "今天的都领过了");
  render();
};

// ── 会员：每单免配送费（自取除外），每月发 4 张会员红包 ──
const MEMBER_PLANS = [{ id: "m30", days: 30, price: 15, label: "月卡" }, { id: "m90", days: 90, price: 39, label: "季卡" }];
const MEMBER_MONTHLY = { count: 4, amount: 4, min: 20 };
/** 会员每个月第一次打开时发当月的会员红包 */
async function grantMemberCoupons() {
  const now = Date.now(), month = monthKey(now);
  if (!isMember(now) || state.settings.member.granted === month) return;
  const d = new Date(now), monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
  for (let i = 0; i < MEMBER_MONTHLY.count; i++) await addCoupon(MEMBER_MONTHLY.amount, "会员红包", { min: MEMBER_MONTHLY.min, expireAt: monthEnd });
  await saveSettings({ member: { ...state.settings.member, granted: month } });
}
/** 这一单会员免了多少配送费，记到会员卡上 */
async function noteMemberSaving(amount) {
  if (!(amount > 0)) return;
  const m = state.settings.member, month = monthKey();
  await saveSettings({ member: { ...m, saved: Math.round(((Number(m.saved) || 0) + amount) * 10) / 10, month, monthSaved: Math.round(((m.month === month ? Number(m.monthSaved) || 0 : 0) + amount) * 10) / 10 } });
}
views.member = {
  title: "外卖会员",
  tone: "brand",
  render() {
    const m = state.settings.member, now = Date.now(), on = isMember(now);
    const monthSaved = m.month === monthKey(now) ? Number(m.monthSaved) || 0 : 0;
    return `
      <div class="hero member-hero"><i class="crown">👑</i><span><b>${on ? "外卖会员" : "开通外卖会员"}</b><small>${on ? `有效期至 ${new Date(m.until).getMonth() + 1} 月 ${new Date(m.until).getDate()} 日` : "每单免配送费，每月再送 4 张红包"}</small></span></div>
      <section class="card member-card">
        <div class="stats"><div><b><i>¥</i>${monthSaved}</b><small>本月已省</small></div><div><b><i>¥</i>${Number(m.saved) || 0}</b><small>累计已省</small></div><div><b>${on ? Math.max(1, Math.ceil((m.until - now) / DAY_MS)) : 0}</b><small>剩余天数</small></div></div>
      </section>
      <section class="card"><h3>${icon("crown", 14)}会员权益</h3>
        <div class="perks"><div><i>🛵</i><b>每单免配送费</b><small>外卖配送全免，跑腿减 3 元</small></div>
          <div><i>🧧</i><b>每月 ${MEMBER_MONTHLY.count} 张 ${yuan(MEMBER_MONTHLY.amount)} 红包</b><small>满 ${MEMBER_MONTHLY.min} 可用，当月有效</small></div>
          <div><i>📒</i><b>省下的钱都记着</b><small>每次免掉的配送费算进会员卡</small></div></div></section>
      <section class="card"><h3>${icon("wallet", 14)}${on ? "续费" : "开通"}<small>从小手机钱包扣</small></h3>
        <div class="plans">${MEMBER_PLANS.map(p => `<button type="button" class="plan" data-act="buy-member" data-id="${p.id}"><b>${p.label}</b>${priceHtml(p.price)}<small>${p.days} 天 · 约 ${yuan(Math.round(p.price / p.days * 30 * 10) / 10)}/月</small></button>`).join("")}</div></section>`;
  },
};
actions["open-member"] = () => go("member");
actions["buy-member"] = async d => {
  const plan = MEMBER_PLANS.find(p => p.id === d.id);
  if (!plan || !await confirmBox(`${isMember() ? "续费" : "开通"}外卖会员${plan.label}？`, `从钱包付 ${yuan(plan.price)}，有效 ${plan.days} 天。`)) return;
  const ok = await busy("正在付款…", async () => {
    const paid = await api.wallet.pay({ amount: plan.price, title: `外卖会员 · ${plan.label}`, detail: `${plan.days} 天`, category: "外卖" });
    if (!paid || paid.ok === false) throw new Error((paid && paid.error) || "付款失败");
    const m = state.settings.member, now = Date.now();
    await saveSettings({ member: { ...m, until: Math.max(now, Number(m.until) || 0) + plan.days * DAY_MS } });
    await grantMemberCoupons();
    return true;
  });
  if (ok) { toast("会员已开通，配送费全免"); render(); }
};
