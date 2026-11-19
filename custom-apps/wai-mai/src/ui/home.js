// ── 首页（地址、搜索、分类、红包、排序筛选、店铺列表）和店铺页（点菜 / 评价 / 商家、选规格、购物车）──
// 送给谁：state.recipient 是 "" 自己 / 角色 id / "g:群会话 id" 请群聊
const isGroupRecipient = () => String(state.recipient || "").startsWith("g:");
function recipientGroup() { return isGroupRecipient() ? state.settings.groups.find(g => g.sessionId === state.recipient.slice(2)) || null : null; }
const groupSize = g => (g && g.participants ? g.participants.length : 0) + 1;   // 群里的角色加上你自己
function recipientName() {
  if (!state.recipient) return "我自己";
  if (isGroupRecipient()) { const g = recipientGroup(); return g ? `「${g.name || "群聊"}」` : "群聊"; }
  const c = state.characters.find(x => x.id === state.recipient);
  return c ? c.name : "TA";
}
function avatarHtml(c, cls) {
  const src = c && (c.avatar || c.avatarUrl);
  return src ? `<img class="ava ${cls || ""}" src="${esc(src)}" alt="">` : `<span class="ava ph ${cls || ""}">${esc((c && c.name || "我").slice(0, 1))}</span>`;
}
function recipientAvatar(cls) {
  if (isGroupRecipient()) return `<span class="ava ph grp ${cls || ""}">群</span>`;
  return state.recipient ? avatarHtml(state.characters.find(c => c.id === state.recipient), cls) : `<span class="ava ph ${cls || ""}">我</span>`;
}
/** 这一单的收货地址：给自己点用自己的，给角色点用记在这位角色名下的 */
function currentAddress() {
  if (isGroupRecipient()) return "";
  return state.recipient ? (state.settings.charAddress[state.recipient] || "") : (state.settings.userAddress || "");
}
function addressLabel() {
  if (isGroupRecipient()) return `请${recipientName()}大家吃`;
  const address = currentAddress();
  if (state.recipient) return `${recipientName()} · ${address || "TA 那边"}`;
  return address || "添加收货地址";
}
const isLiked = id => state.settings.likedShops.includes(id);
/** 在这家店下过几次单（自己付的、送到了的才算） */
const boughtCount = id => state.orders.filter(o => o.shopId === id && o.status === "active" && o.payer !== "char").length;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

function shopPills(s) {
  const sign = s.dishes.find(d => d.tag) || s.dishes[0];
  return `${s.off ? `<i class="pill off">${s.off[0]}减${s.off[1]}</i>` : ""}${s.fee ? "" : '<i class="pill off">免配送费</i>'}${sign ? `<i class="pill soft">${esc(sign.tag || "招牌")} · ${esc(sign.name)}</i>` : ""}`;
}
function shopCard(s) {
  const st = shopStats(s);
  return `<button type="button" class="shop" data-act="open-shop" data-id="${esc(s.id)}">
    ${shopCover(s, 64)}
    <span class="shop-main">
      <span class="shop-name">${esc(s.name)}${s.source === "ai" ? '<i class="tag ai">AI</i>' : ""}${isLiked(s.id) ? '<i class="tag like">收藏</i>' : ""}${boughtCount(s.id) ? `<i class="tag bought">买过 ${boughtCount(s.id)} 次</i>` : ""}</span>
      <span class="shop-meta"><b>★${s.rating.toFixed(1)}</b><span>月售 ${st.salesText}</span><span class="eta-hint">${etaHint(s)} · ${st.km}km</span></span>
      <span class="shop-meta"><span>起送 ${yuan(s.minOrder)}</span><span>配送 ${s.fee ? yuan(s.fee) : "免费"}</span></span>
      ${s.tagline ? `<span class="quote">“${esc(s.tagline)}”</span>` : ""}
      <span class="pills">${shopPills(s)}</span>
    </span></button>`;
}
/** 首页那一排「招牌推荐」：每家店带角标的那道菜 */
function pickCards(shops) {
  return shops.map(s => { const d = s.dishes.find(x => x.tag) || s.dishes[0]; return d ? { s, d } : null; }).filter(Boolean).slice(0, 8)
    .map(({ s, d }) => `<button type="button" class="pick" data-act="open-shop" data-id="${esc(s.id)}">
      ${dishCover(d.emoji, s.color, 70, d.tag, true)}
      <b>${esc(d.name)}</b><small>${esc(s.name)}</small><span class="pick-foot">${dishPriceHtml(d, s)}<i class="plus-dot">+</i></span></button>`).join("");
}
const SORTS = [["all", "综合排序"], ["rating", "评分最高"], ["min", "起送最低"], ["fast", "配送最快"]];
function sortShops(list) {
  const by = { rating: (a, b) => b.rating - a.rating, min: (a, b) => a.minOrder - b.minOrder, fast: (a, b) => a.factor - b.factor }[state.sort];
  return by ? list.slice().sort(by) : list;
}

views.home = {
  title: "外卖",
  tone: "brand",
  render() {
    const q = state.query.trim(), now = Date.now();
    const filtering = state.onlyLiked || state.onlyOff || state.onlyBought;
    const browsing = !q && state.category === "全部" && !filtering;
    let shops = q ? searchLocal(q) : allShops();
    if (state.category !== "全部") shops = shops.filter(s => s.category === state.category);
    if (state.onlyLiked) shops = shops.filter(s => isLiked(s.id));
    if (state.onlyOff) shops = shops.filter(s => s.off);
    if (state.onlyBought) shops = shops.filter(s => boughtCount(s.id) > 0);
    shops = sortShops(shops);
    const live = state.orders.filter(o => isOnTheWay(o, now));
    const toChar = !!state.recipient && !isGroupRecipient();
    const group = recipientGroup();
    const crave = state.craving && state.craving.charId === state.recipient ? state.craving : null;
    const speed = SPEEDS[state.settings.speed] || SPEEDS.fast;
    const claimed = state.settings.claimDay === today();
    let liveHtml = "";
    if (live.length) {
      const st = stageAt(live[0], now);
      liveHtml = `<button type="button" class="live-card" data-act="open-order" data-id="${esc(live[0].id)}"><i class="live-ico">${icon("scooter", 16)}</i>
        <span class="live-main"><span><em>${esc(live[0].shopName)} · ${esc(st.label)}</em><small>${esc(remainText(st.remainMs))}</small></span><span class="bar"><i style="width:${Math.round(st.progress * 100)}%"></i></span></span>${icon("right", 14)}</button>`;
    }
    const groupHtml = group ? `<div class="crave">${recipientAvatar()}<div class="crave-main"><b>请${esc(recipientName())}吃外卖</b><small>群里共 ${groupSize(group)} 人，结算时可以每样按人数点</small></div><button type="button" class="crave-x" data-act="set-recipient" data-id="" aria-label="不请了">×</button></div>` : "";
    const craveHtml = toChar ? `<div class="crave">${recipientAvatar()}<div class="crave-main">${crave
      ? `<small>${esc(recipientName())} 说</small><p class="crave-line">${esc(crave.line || "随便，你挑。")}</p>`
      : `<b>给 ${esc(recipientName())} 点一份</b><small>不知道点什么？问问 TA 现在想吃什么</small>`}</div>${crave
      ? (crave.word ? `<button type="button" class="mini hot" data-act="search-word" data-word="${esc(crave.word)}">搜「${esc(crave.word)}」</button>` : "")
      : `<button type="button" class="mini hot" data-act="ask-crave">问问 TA</button>`}<button type="button" class="crave-x" data-act="set-recipient" data-id="" aria-label="不给 TA 点了">×</button></div>` : "";
    const promos = `<div class="promos">
        <button type="button" class="promo red" data-act="claim-daily"><span><b>天天红包</b><small>${claimed ? "今天领过了，明天再来" : "每天一张，下单直接抵"}</small></span><em>${claimed ? "已领" : "领"}</em></button>
        ${!toChar && state.characters.length ? `<button type="button" class="promo" data-act="pick-recipient"><span><b>给 TA 点一份</b><small>先问问 TA 想吃什么</small></span><i class="big">🎁</i></button>` : `<button type="button" class="promo" data-act="set-category" data-c="超市便利"><span><b>闪购到家</b><small>日用、药品、鲜花都送</small></span><i class="big">⚡</i></button>`}
      </div>`;
    const emptyHtml = `<div class="empty"><span class="big">🔍</span><p>${filtering && !q ? "没有符合筛选条件的店" : `附近没有找到「${esc(q || state.category)}」`}</p>${q && state.settings.aiShops
      ? `<button type="button" class="btn" data-act="ai-shops">让 AI 找几家卖这个的店</button><small>会调用一次模型，生成的店会留在首页</small>`
      : q ? "<small>「我的 → AI 找店」开着时，可以让模型现编几家店</small>" : ""}</div>`;
    const cats = CATEGORIES.slice(1);
    return `
      <div class="hero">
        <div class="hero-top">
          <button type="button" class="to" data-act="edit-address">${toChar ? recipientAvatar("sm") : icon("pin", 15)}<b>${esc(addressLabel())}</b>${icon("down", 13)}</button>
        </div>
        <form class="search" data-form="search">${icon("search", 15)}<input id="q" type="search" enterkeyhint="search" placeholder="想吃什么？麻辣烫、奶茶、退热贴…" value="${esc(state.query)}"><button type="submit">搜索</button></form>
        <div class="hotwords">${state.settings.aiShops ? `<button type="button" class="ai" data-act="ai-focus">${icon("spark", 11)}AI 找店</button>` : ""}${HOT_WORDS.map(w => `<button type="button" data-act="search-word" data-word="${esc(w)}">${esc(w)}</button>`).join("")}</div>
      </div>
      <div class="cats">${cats.map(c => `<button type="button" class="cat${c === state.category ? " on" : ""}" data-act="set-category" data-c="${esc(c)}"><i>${CATEGORY_EMOJI[c]}</i>${esc(c)}</button>`).join("")}</div>
      <div class="entries">${[
        ["open-coupons", "🎟️", "领券中心", claimableCount() ? `${claimableCount()} 张可领` : ""],
        ["open-lottery", "🎡", "天天抽奖", state.settings.lotteryDay === today() ? "" : "今日可抽"],
        ["open-member", "👑", isMember() ? "会员中心" : "开会员", isMember() ? "" : "免配送费"],
        ["open-errand", "🛵", "跑腿帮买", ""],
        ["toggle-filter", "🧾", "买过的店", "", "onlyBought"],
      ].map(([act, emo, label, badge, key]) => `<button type="button" class="entry${key && state[key] ? " on" : ""}" data-act="${act}"${key ? ` data-key="${key}"` : ""}><i>${emo}</i>${label}${badge ? `<em>${esc(badge)}</em>` : ""}</button>`).join("")}</div>
      ${liveHtml}${craveHtml}${groupHtml}
      ${browsing ? promos : ""}
      ${browsing && shops.length ? `<div class="sec-h"><h2>招牌推荐</h2><small>每家店最拿手的那一道</small></div><div class="picks">${pickCards(shops)}</div>` : ""}
      <div class="sec-h"><h2>${q ? `「${esc(q)}」的搜索结果` : state.category === "全部" ? "附近商家" : esc(state.category)}</h2><small>${shops.length} 家</small><span class="hero-eta">${icon("bolt", 12)}${speed.label}配送 · ${speed.hint}</span></div>
      <div class="sorts">${SORTS.map(([key, label]) => `<button type="button" class="${state.sort === key ? "on" : ""}" data-act="set-sort" data-sort="${key}">${label}</button>`).join("")}
        <button type="button" class="chip${state.onlyOff ? " on" : ""}" data-act="toggle-filter" data-key="onlyOff">满减</button><button type="button" class="chip${state.onlyLiked ? " on" : ""}" data-act="toggle-filter" data-key="onlyLiked">收藏</button>${state.onlyBought ? '<button type="button" class="chip on" data-act="toggle-filter" data-key="onlyBought">买过</button>' : ""}</div>
      <div class="shops">${shops.map(shopCard).join("") || emptyHtml}</div>
      ${shops.length && state.settings.aiShops && !filtering ? `<button type="button" class="more-shops" data-act="ai-shops">${icon("spark", 13)}${q ? "没有想要的？让 AI 再找几家" : `看完了？让 AI 再找几家${state.category === "全部" ? "" : esc(state.category)}`}</button>` : ""}`;
  },
  after() {
    const form = document.querySelector('[data-form="search"]');
    if (form) form.addEventListener("submit", ev => { ev.preventDefault(); state.query = $("q").value; state.category = "全部"; render(true); });
  },
};

actions["set-category"] = d => { state.category = state.category === d.c ? "全部" : d.c; state.query = ""; render(); };
actions["set-sort"] = d => { state.sort = d.sort; render(); };
actions["toggle-filter"] = d => { state[d.key] = !state[d.key]; render(); };
actions["open-shop"] = d => go("shop", { id: d.id });
actions["search-word"] = d => { state.query = d.word; state.category = "全部"; render(true); };
actions["ai-focus"] = () => { const q = $("q"); if (q) q.focus(); toast("写下想吃的，本地搜不到就让 AI 现编几家"); };
actions["ai-shops"] = async () => {
  const typed = ($("q") ? $("q").value : state.query).trim();
  // 没写搜索词时按当前分类找；分类也是「全部」就随便找几家附近口碑好的
  const q = typed || (state.category !== "全部" ? state.category : "附近口碑好的店");
  if (typed) state.query = typed;
  const added = await busy(`正在找卖「${q}」的店…`, () => generateShops(q));
  if (added) { toast(`找到 ${added.length} 家`); render(true); }
};
actions["ask-crave"] = async () => {
  const charId = state.recipient;
  const res = await busy(`正在问 ${recipientName()}…`, () => askCraving(charId));
  if (!res) return;
  state.craving = { charId, ...res };
  render();
};
actions["claim-daily"] = async () => {
  const day = today();
  if (state.settings.claimDay === day) { toast("今天的红包已经领过了"); return; }
  const amount = 2 + hashSeed(day) % 5;
  await addCoupon(amount, "天天红包");
  await saveSettings({ claimDay: day });
  toast(`领到 ${yuan(amount)} 红包，下单自动抵扣`);
  render();
};
actions["pick-recipient"] = () => {
  const row = (id, ava, name, hint) => `<button type="button" class="row${state.recipient === id ? " on" : ""}" data-act="set-recipient" data-id="${esc(id)}">${ava}<span>${esc(name)}${hint ? `<small> · ${hint}</small>` : ""}</span><em>${icon("check", 12)}</em></button>`;
  const rows = [row("", '<span class="ava ph">我</span>', "我自己", "")].concat(state.characters.map(c => row(c.id, avatarHtml(c), c.name, "送到 TA 那边")))
    .concat(state.settings.groups.map(g => row("g:" + g.sessionId, '<span class="ava ph grp">群</span>', g.name || "群聊", `请大家吃 · ${groupSize(g)} 人`)));
  openSheet("这一单送给谁", `<div class="rows">${rows.join("")}</div>${state.characters.length ? "" : '<p class="hint">还没有角色。先在小手机里创建角色，就能给 TA 点外卖了。</p>'}`);
};
actions["set-recipient"] = d => {
  state.recipient = d.id; draft.address = null;
  if (d.id && state.mode === "pickup") state.mode = "delivery";   // 给别人点就得送过去
  closeSheet(); render();
};
// ── 收货地址：给自己点用地址簿（家 / 公司 / 学校…），给角色点每人记一条 ──
const ADDR_TAGS = ["家", "公司", "学校", "其他"];
let addrTag = "家";
function addressBookHtml() {
  const list = state.settings.addresses, cur = state.settings.userAddress;
  return `${list.length ? `<div class="rows">${list.map(a => `<div class="row addr-row${a.text === cur ? " on" : ""}"><button type="button" class="addr-use" data-act="addr-use" data-id="${esc(a.id)}"><i class="tag addr">${esc(a.tag || "其他")}</i><span>${esc(a.text)}</span><em>${icon("check", 12)}</em></button><button type="button" class="addr-del" data-act="addr-del" data-id="${esc(a.id)}" aria-label="删除">×</button></div>`).join("")}</div>` : ""}
    <div class="addr-new"><div class="seg wrap">${ADDR_TAGS.map(t => `<button type="button" class="${addrTag === t ? "on" : ""}" data-act="addr-tag" data-tag="${t}">${t}</button>`).join("")}</div>
      <input id="addr-input" maxlength="80" placeholder="新地址：小区、楼栋、门牌…" value="">
      <button type="button" class="btn" data-act="save-address">添加并设为默认</button></div>
    <p class="hint">只是写给外卖小票和角色看的，不会真的定位。点一条就设为默认；送给谁在结算时选。</p>`;
}
let addrForSelf = false;   // 从「我的」点进地址簿时，就算首页选着角色也改自己的
actions["my-address"] = () => { addrForSelf = true; openSheet("我的收货地址", addressBookHtml(), () => { addrForSelf = false; }); };
actions["edit-address"] = () => {
  addrForSelf = false;
  if (isGroupRecipient()) { actions["pick-recipient"](); return; }
  if (state.recipient) {
    openSheet(`${recipientName()} 那边的地址`, `<input id="addr-input" maxlength="80" placeholder="小区、楼栋、门牌…（可不填）" value="${esc(currentAddress())}"><p class="hint">只是写给外卖小票和角色看的，不会真的定位。</p><button type="button" class="btn" data-act="save-address">保存</button>`);
    return;
  }
  openSheet("我的收货地址", addressBookHtml());
};
actions["addr-tag"] = d => { addrTag = d.tag; const v = $("addr-input").value; $("sheet-body").innerHTML = addressBookHtml(); $("addr-input").value = v; };
actions["save-address"] = async () => {
  const address = ($("addr-input").value || "").trim().slice(0, 80);
  if (state.recipient && !addrForSelf) await saveSettings({ charAddress: { ...state.settings.charAddress, [state.recipient]: address } });
  else if (address) {
    const rest = state.settings.addresses.filter(a => a.text !== address);
    await saveSettings({ addresses: [{ id: uid("addr"), tag: addrTag, text: address }, ...rest].slice(0, 12), userAddress: address });
  }
  draft.address = null;
  closeSheet(); render();
};
actions["addr-use"] = async d => {
  const a = state.settings.addresses.find(x => x.id === d.id);
  if (!a) return;
  await saveSettings({ userAddress: a.text });
  draft.address = null;
  closeSheet(); render();
};
actions["addr-del"] = async d => {
  const a = state.settings.addresses.find(x => x.id === d.id);
  if (!a) return;
  const rest = state.settings.addresses.filter(x => x.id !== d.id);
  await saveSettings({ addresses: rest, userAddress: state.settings.userAddress === a.text ? (rest[0] ? rest[0].text : "") : state.settings.userAddress });
  $("sheet-body").innerHTML = addressBookHtml();
  render();
};

// ── 购物车：items[行名] = 份数；带规格的行名是「菜名·规格·规格」，base[行名] 记着它是哪道菜 ──
const emptyCart = () => ({ shopId: "", items: {}, base: {} });
function cartCount() { return Object.values(state.cart.items).reduce((s, n) => s + n, 0); }
function cartItems() {
  const shop = shopById(state.cart.shopId);
  if (!shop) return [];
  return Object.entries(state.cart.items).filter(([, qty]) => qty > 0).map(([key, qty]) => {
    const dish = dishOf((state.cart.base || {})[key] || key, shop);
    return dish ? { name: key, price: dishPrice(dish, shop), qty } : null;
  }).filter(Boolean);
}
/** 这道菜（所有规格加起来）在购物车里有几份 */
function dishQty(shop, dish) {
  if (state.cart.shopId !== shop.id) return 0;
  return Object.entries(state.cart.items).reduce((sum, [key, qty]) => sum + (((state.cart.base || {})[key] || key) === dish.name ? qty : 0), 0);
}
async function addToCart(shopId, dish, key) {
  if (state.cart.shopId && state.cart.shopId !== shopId && cartCount() > 0) {
    if (!await confirmBox("换一家店？", "购物车里还有另一家店的东西，继续会清空它。")) return false;
  }
  if (state.cart.shopId !== shopId) state.cart = { shopId, items: {}, base: {} };
  if (!state.cart.base) state.cart.base = {};
  state.cart.items[key] = clamp((state.cart.items[key] || 0) + 1, 0, 20);
  state.cart.base[key] = dish.name;
  return true;
}
function dropFromCart(key) {
  const n = (state.cart.items[key] || 0) - 1;
  if (n > 0) state.cart.items[key] = n;
  else { delete state.cart.items[key]; if (state.cart.base) delete state.cart.base[key]; }
}
/** 底部停靠条：店铺页是购物车，结算页是合计和提交按钮（见 checkout.js 的 payDock） */
function renderCartBar() {
  const bar = $("cartbar");
  const flat = state.view === "checkout" || state.view === "errand";
  bar.className = flat ? "dock flat" : "dock";
  if (flat) { const html = state.view === "checkout" ? payDock() : errandDock(); bar.hidden = !html; bar.innerHTML = html; return; }
  const shop = shopById(state.params.id);
  const show = state.view === "shop" && shop && (state.params.tab || "menu") === "menu";
  bar.hidden = !show;
  if (!show) return;
  const mine = state.cart.shopId === shop.id, count = mine ? cartCount() : 0;
  const pickup = state.mode === "pickup";
  const p = priceOrder(mine ? cartItems() : [], shop, { pickup, freeFee: isMember() });
  bar.innerHTML = `<button type="button" class="dock-bag${count ? " on" : ""}" data-act="open-cart" aria-label="购物车">${icon("bag", 20)}${count ? `<em>${count}</em>` : ""}</button>
    <span class="dock-sum">${count ? priceHtml(p.subtotal) : '<b class="dock-empty">还没有选商品</b>'}<small>${count && p.off ? `已减 ${yuan(p.off)} · ` : ""}${pickup ? "到店自取 · 立减一成" : !shop.fee ? "免配送费" : isMember() ? "会员免配送费" : `另需配送费 ${yuan(shop.fee)}`}${p.pack ? ` · 包装费 ${yuan(p.pack)}` : ""}</small></span>
    <button type="button" class="btn" data-act="to-checkout"${!count || p.short > 0 ? " disabled" : ""}>${!count ? `${yuan(shop.minOrder)} 起送` : p.short > 0 ? `差 ${yuan(p.short)} 起送` : "去结算"}</button>`;
}
function cartSheetHtml() {
  const shop = shopById(state.cart.shopId);
  return `<div class="cart-rows">${cartItems().map(it => `<div class="line">${dishCover(itemEmoji(it.name, shop), shop.color, 34)}<span>${esc(it.name)}</span>${priceHtml(it.price * it.qty, "sm")}
      <div class="stepper"><button type="button" data-act="cart-line" data-key="${esc(it.name)}" data-d="-1" aria-label="减一份">−</button><span>${it.qty}</span><button type="button" class="plus" data-act="cart-line" data-key="${esc(it.name)}" data-d="1" aria-label="加一份">+</button></div></div>`).join("")}</div>
    <div class="cart-foot">${state.characters.length ? `<button type="button" class="link" data-act="share-open" data-kind="cart">${icon("share", 12)}让 TA 帮我看看</button>` : ""}<button type="button" class="link danger" data-act="cart-clear">清空购物车</button></div>`;
}
actions["open-cart"] = () => { if (cartCount()) openSheet("购物车", cartSheetHtml()); else toast("购物车还是空的"); };
actions["cart-line"] = d => {
  if (d.d === "1") state.cart.items[d.key] = clamp((state.cart.items[d.key] || 0) + 1, 0, 20);
  else dropFromCart(d.key);
  if (cartCount()) $("sheet-body").innerHTML = cartSheetHtml(); else closeSheet();
  render();
};
actions["cart-clear"] = () => { state.cart = emptyCart(); closeSheet(); render(); };

// ── 店铺页 ──
const SHOP_TABS = [["menu", "点菜"], ["reviews", "评价"], ["info", "商家"]];
function dishRow(shop, d) {
  const qty = dishQty(shop, d), specs = dishSpecs(d, shop), stat = dishStats(d, shop), name = esc(d.name);
  const buy = specs.length
    ? `<button type="button" class="spec-btn" data-act="cart-inc" data-name="${name}">选规格${qty ? `<em>${qty}</em>` : ""}</button>`
    : `<div class="stepper">${qty ? `<button type="button" data-act="cart-dec" data-name="${name}" aria-label="减一份">−</button><span>${qty}</span>` : ""}<button type="button" class="plus" data-act="cart-inc" data-name="${name}" aria-label="加一份">+</button></div>`;
  return `<div class="dish">${dishCover(d.emoji, shop.color, 70, d.tag)}
    <div class="dish-main"><b>${name}</b>${d.desc ? `<small>${esc(d.desc)}</small>` : ""}<span class="dish-stat">月售 ${stat.sales} · 好评度 ${stat.good}%</span>
      <div class="dish-buy">${dishPriceHtml(d, shop)}${buy}</div></div></div>`;
}

views.shop = {
  title: "",
  tone: p => { const s = shopById(p.id); return s ? { name: "hue", hue: s.color } : "plain"; },
  render(p) {
    const s = shopById(p.id);
    if (!s) return '<div class="empty"><span class="big">🏚️</span><p>这家店已经不在了</p></div>';
    const tab = p.tab || "menu", st = shopStats(s), liked = isLiked(s.id);
    const reviews = state.orders.filter(o => o.shopId === s.id && o.review);
    const groups = dishGroups(s), active = Number(p.g) || 0;
    let body = "";
    if (tab === "menu") {
      body = `<section class="menu"><nav class="menu-nav">${groups.map((g, i) => `<button type="button" class="${i === active ? "on" : ""}" data-act="menu-jump" data-g="${i}">${esc(g.title)}</button>`).join("")}</nav>
        <div class="menu-list">${groups.map((g, i) => `<h4 id="g-${i}">${esc(g.title)}<small>${g.dishes.length}</small></h4>${g.dishes.map(d => dishRow(s, d)).join("")}`).join("")}</div></section>`;
    } else if (tab === "reviews") {
      body = reviews.length
        ? `<section class="card">${reviews.map(o => `<div class="review"><p class="stars">${"★".repeat(o.review.stars)}${"☆".repeat(5 - o.review.stars)}</p>${o.review.text ? `<p>${esc(o.review.text)}</p>` : ""}<small>${esc(when(o.review.at || o.createdAt))} · ${esc(itemsText(o))}</small></div>`).join("")}</section>`
        : '<div class="empty"><span class="big">📝</span><p>还没有评价</p><small>在这家店点过单、送到之后，可以回来打分</small></div>';
    } else {
      body = `<section class="card kv">
          <div><span>商家公告</span><b>${esc(s.tagline || "欢迎光临")}</b></div>
          <div><span>品类</span><b>${esc(s.category)}</b></div>
          <div><span>配送</span><b>起送 ${yuan(s.minOrder)} · 配送费 ${s.fee ? yuan(s.fee) : "免费"} · ${etaHint(s)}</b></div>
          ${s.off ? `<div><span>优惠</span><b>满 ${s.off[0]} 减 ${s.off[1]}</b></div>` : ""}
          <div><span>来源</span><b>${s.source === "ai" ? `AI 生成${s.query ? `（搜「${esc(s.query)}」时）` : ""}` : "内置店铺"}</b></div>
        </section>
        <button type="button" class="link danger" data-act="remove-shop" data-id="${esc(s.id)}">${s.source === "ai" ? "删除这家 AI 店铺" : "不想看到这家店"}</button>`;
    }
    return `
      <div class="hero shop-hero"></div>
      <section class="card shop-head">
        <div class="shop-head-top"><div><h2>${esc(s.name)}${s.source === "ai" ? '<i class="tag ai">AI</i>' : ""}</h2>
            <p class="shop-meta"><b>★${s.rating.toFixed(1)}</b><span>月售 ${st.salesText}</span><span>${etaHint(s)} · ${st.km}km</span></p>
            <p class="shop-meta"><span>起送 ${yuan(s.minOrder)}</span><span>配送 ${s.fee ? yuan(s.fee) : "免费"}</span></p></div>${shopCover(s, 56)}</div>
        <div class="pills">${s.off ? `<i class="pill off">${s.off[0]}减${s.off[1]}</i>` : ""}${s.fee ? "" : '<i class="pill off">免配送费</i>'}<i class="pill grey">${esc(s.category)}</i>
          <span class="head-btns"><button type="button" class="like-btn" data-act="share-open" data-kind="shop" data-id="${esc(s.id)}">${icon("share", 12)}分享</button><button type="button" class="like-btn${liked ? " on" : ""}" data-act="toggle-like" data-id="${esc(s.id)}">${icon("heart", 12)}${liked ? "已收藏" : "收藏"}</button></span></div>
        ${shopCouponHtml(s)}
        ${s.tagline ? `<p class="notice"><b>公告</b>${esc(s.tagline)}</p>` : ""}
        ${state.recipient ? `<p class="notice"><b>代点</b>这一单送给 ${esc(recipientName())}</p>` : ""}
        <div class="modes"><button type="button" class="${state.mode !== "pickup" ? "on" : ""}" data-act="set-mode" data-mode="delivery"><b>外卖配送</b><small>${etaHint(s)} · ${st.km}km</small></button><button type="button" class="${state.mode === "pickup" ? "on" : ""}" data-act="set-mode" data-mode="pickup"><b>到店自取</b><small>${pickupHint(s)} · 立减一成</small></button></div>
      </section>
      <div class="stabs">${SHOP_TABS.map(([key, label]) => `<button type="button" class="${tab === key ? "on" : ""}" data-act="shop-tab" data-tab="${key}">${label}${key === "reviews" && reviews.length ? `<small>${reviews.length}</small>` : ""}</button>`).join("")}</div>
      ${body}`;
  },
};

/** 自取大概多久能取：只算备餐，约是配送时间的一半 */
function pickupHint(shop) {
  const speed = SPEEDS[state.settings.speed] || SPEEDS.fast;
  const minutes = (speed.minutes[0] + speed.minutes[1]) / 2 * (shop.factor || 1) * 0.55;
  return minutes < 1.5 ? "1 分钟内可取" : `约 ${Math.round(minutes)} 分钟可取`;
}
actions["set-mode"] = d => {
  if (d.mode === "pickup" && isGroupRecipient()) { toast("请群聊只能送过去，不能自取"); return; }
  state.mode = d.mode === "pickup" ? "pickup" : "delivery";
  if (state.mode === "pickup" && state.recipient) { state.recipient = ""; toast("自取只能自己去拿，这一单改成给自己点"); }
  render();
};
actions["shop-tab"] = d => { state.params = { ...state.params, tab: d.tab }; render(); };
actions["menu-jump"] = d => {
  state.params = { ...state.params, g: Number(d.g) }; render();
  const node = $("g-" + d.g); if (node) node.scrollIntoView({ block: "start" });
};
actions["toggle-like"] = async d => {
  const list = state.settings.likedShops, on = list.includes(d.id);
  await saveSettings({ likedShops: on ? list.filter(id => id !== d.id) : [...list, d.id] });
  toast(on ? "已取消收藏" : "已收藏，首页可以只看收藏的店");
  render();
};

/** 选规格：specDraft 记着正在选哪道菜、每组选了第几个 */
let specDraft = null;
function specSheetHtml() {
  const shop = shopById(specDraft.shopId), dish = dishOf(specDraft.name, shop);
  return `${dishSpecs(dish, shop).map((g, gi) => `<div class="spec-g"><small>${g.title}</small><div class="seg wrap">${g.options.map((o, oi) => `<button type="button" class="${specDraft.picks[gi] === oi ? "on" : ""}" data-act="spec-pick" data-g="${gi}" data-i="${oi}">${o}</button>`).join("")}</div></div>`).join("")}
    <div class="spec-foot">${dishPriceHtml(dish, shop)}<button type="button" class="btn" data-act="spec-add">加入购物车</button></div>`;
}
actions["cart-inc"] = async d => {
  const shop = shopById(state.params.id), dish = shop && dishOf(d.name, shop);
  if (!dish) return;
  const specs = dishSpecs(dish, shop);
  if (specs.length) {
    specDraft = { shopId: shop.id, name: dish.name, picks: specs.map(() => 0) };
    openSheet(dish.name, specSheetHtml());
    return;
  }
  if (await addToCart(shop.id, dish, dish.name)) render();
};
actions["spec-pick"] = d => { if (!specDraft) return; specDraft.picks[Number(d.g)] = Number(d.i); $("sheet-body").innerHTML = specSheetHtml(); };
actions["spec-add"] = async () => {
  if (!specDraft) return;
  const shop = shopById(specDraft.shopId), dish = dishOf(specDraft.name, shop);
  const key = [dish.name, ...dishSpecs(dish, shop).map((g, gi) => g.options[specDraft.picks[gi]])].join("·");
  closeSheet();
  if (await addToCart(shop.id, dish, key)) { toast("已加入购物车"); render(); }
};
actions["cart-dec"] = d => { dropFromCart(d.name); render(); };
actions["remove-shop"] = async d => {
  if (!await confirmBox("移除这家店？", d.id.startsWith("seed_") ? "内置店铺会被隐藏，可以在「我的」里恢复。" : "AI 生成的店会被删除，已有订单不受影响。")) return;
  await removeShop(d.id);
  if (state.cart.shopId === d.id) state.cart = emptyCart();
  back();
};
