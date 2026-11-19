// ── 画面素材：图标、店铺和菜品的封面、配送地图。全部用 CSS、SVG 和表情符号画，不带图片文件 ──
const svgIcon = (body, size) => `<svg viewBox="0 0 24 24" width="${size || 16}" height="${size || 16}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3"/><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M15.5 13.5h.01"/>',
  heart: '<path d="M12 20s-7-4.3-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5C19 15.7 12 20 12 20z"/>',
  bag: '<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  chat: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15A2.5 2.5 0 0 1 5 12.5z"/>',
  bolt: '<path d="M13 3 5.5 13.5H11L10 21l8-11h-5.5z"/>',
  gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M3 7h18v3H3zM12 7v13M12 7c-1-3-5-3.5-5-1s3 1 5 1zm0 0c1-3 5-3.5 5-1s-3 1-5 1z"/>',
  spark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="2 2.5"/>',
  store: '<path d="M4 10 5.5 5h13L20 10M5 10v9h14v-9M4 10a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M10 19v-4.5h4V19"/>',
  box: '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5l8 4.5 8-4.5M12 13v7"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M18 6l-1.8 1.8M7.8 16.2 6 18"/>',
  share: '<circle cx="17.5" cy="6" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="m8.7 10.8 6.6-3.6M8.7 13.2l6.6 3.6"/>',
  crown: '<path d="M4 17.5 3 8l5 4 4-6 4 6 5-4-1 9.5z"/><path d="M5 20.5h14"/>',
  phone: '<path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  scooter: '<circle cx="6" cy="17" r="2.6"/><circle cx="18.5" cy="17" r="2.6"/><path d="M8.6 17h7.3l2.3-7.5h2.3M4 12.5h6l1.6 4.5"/><rect x="3" y="7" width="6" height="4.5" rx="1" fill="currentColor" stroke="none"/>',
};
const icon = (name, size) => svgIcon(ICON[name] || "", size);

/** 金额：¥ 小一号，数字用窄体 */
function priceHtml(n, cls) {
  return `<span class="price${cls ? " " + cls : ""}"><i>¥</i>${(Math.round((Number(n) || 0) * 10) / 10).toString()}</span>`;
}

/** 店铺封面：一间小铺面，上面是条纹雨棚，圆招牌里放这家店的图标 */
function shopCover(shop, size) {
  return `<span class="cv shopcv" style="--hue:${esc(shop.color || "#f0703a")};--s:${size}px"><i class="sign"><b>${esc(shop.emoji || "🍽️")}</b></i></span>`;
}
/** 菜品封面：铺了格子桌布的小桌面 */
function dishCover(emoji, hue, size, badge, wide) {
  return `<span class="cv dishcv${wide ? " wide" : ""}" style="--hue:${esc(hue || "#f0703a")};--s:${size}px"><b>${esc(emoji || "🍽️")}</b>${badge ? `<em>${esc(badge)}</em>` : ""}</span>`;
}
/** 订单和购物车里的名字可能带规格（茉莉奶绿·少冰·三分糖），找回它是店里的哪道菜 */
function dishOf(name, shop) {
  return (shop && shop.dishes.find(d => d.name === name || String(name).startsWith(d.name + "·"))) || null;
}
function itemEmoji(name, shop) {
  const dish = dishOf(name, shop);
  return dish ? dish.emoji : emojiFor(name, shop ? shop.category : "");
}

// 月售、距离、好评度：没有真实销量，按名字算一个固定的数，同一家店每次看到的都一样
function shopStats(shop) {
  const h = hashSeed(shop.name);
  const sales = 300 + h % 3200;
  return { sales, salesText: sales >= 1000 ? `${Math.floor(sales / 1000)}000+` : `${Math.floor(sales / 100)}00+`, km: (0.4 + (h >>> 8) % 27 / 10).toFixed(1) };
}
function dishStats(dish, shop) {
  const h = hashSeed(shop.name + dish.name);
  return { sales: (dish.tag ? 260 : 30) + h % 400, good: 92 + (h >>> 9) % 8 };
}

/** 店铺页左边那一栏：把菜单分成几组 */
const DRINK_EMOJI = ["🧋", "☕", "🍵", "🥛", "🧃", "🥤", "🥥", "🍹", "🧊"];
const MAIN_GROUP = { "奶茶咖啡": "饮品", "甜品面包": "甜点面包", "烧烤小吃": "烧烤", "超市便利": "吃的喝的", "水果鲜花": "水果", "买药": "药品器械" };
function dishGroups(shop) {
  const groups = new Map();
  const push = (title, dish) => { if (!groups.has(title)) groups.set(title, []); groups.get(title).push(dish); };
  for (const d of shop.dishes) {
    if (d.tag) push("招牌热销", d);
    else if (shop.category === "超市便利") push(/纸|线|贴|宝|伞|电池|充电/.test(d.name) ? "日用百货" : "吃的喝的", d);
    else if (shop.category === "水果鲜花") push(/花/.test(d.name) ? "鲜花" : "水果", d);
    else if (shop.category !== "奶茶咖啡" && DRINK_EMOJI.includes(d.emoji)) push("饮品", d);
    else if (!MAIN_GROUP[shop.category] && d.price <= 12) push("小食加料", d);
    else push(MAIN_GROUP[shop.category] || "主食", d);
  }
  const order = ["招牌热销"];
  const list = [...groups.entries()].sort((a, b) => (order.includes(b[0]) ? 1 : 0) - (order.includes(a[0]) ? 1 : 0)).map(([title, dishes]) => ({ title, dishes }));
  const sp = specialDish(shop);
  if (sp) list.unshift({ title: "今日特价", dishes: [sp] });
  return list;
}
/** 要选规格的菜：饮品选温度和甜度，带辣的主食选辣度 */
function dishSpecs(dish, shop) {
  if (shop.category === "奶茶咖啡") {
    const ice = /热/.test(dish.name) ? ["热", "温"] : ["正常冰", "少冰", "去冰", "热"];
    return /美式|拿铁|咖啡|摩卡/.test(dish.name) ? [{ title: "温度", options: ice }] : [{ title: "温度", options: ice }, { title: "甜度", options: ["三分糖", "五分糖", "七分糖", "不另加糖"] }];
  }
  if (["快餐简餐", "面食粉面", "烧烤小吃", "夜宵"].includes(shop.category) && dish.price >= 10 && !DRINK_EMOJI.includes(dish.emoji)
    && /面|粉|米线|麻辣|串|烤|炒|鱼香|黄牛肉|火锅|冒菜/.test(dish.name) && !/番茄|骨汤|葱油|馒头/.test(dish.name)) {
    return [{ title: "辣度", options: ["不辣", "微辣", "中辣", "特辣"] }];
  }
  return [];
}
function orderShop(order) {
  if (order.mode === "errand") return { color: "#2f8f5a", emoji: "🛵", dishes: [], category: "", name: order.shopName };
  return shopById(order.shopId) || { color: "#f0703a", emoji: emojiFor((order.items && order.items[0] && order.items[0].name) || "", ""), dishes: [], category: "" };
}

/** 今日特价：每家店每天挑一道（不挑几块钱的小料），七折。按日期和店算，同一天看到的都一样 */
function specialDish(shop) {
  if (!shop || !shop.dishes) return null;
  const list = shop.dishes.filter(d => d.price >= 8);
  return list.length ? list[hashSeed(`${shop.id}|${today()}`) % list.length] : null;
}
/** 这道菜现在卖多少：特价菜按七折（凑到 5 角） */
function dishPrice(dish, shop) {
  const sp = specialDish(shop);
  return sp && sp.name === dish.name ? Math.max(1, Math.round(dish.price * 0.7 * 2) / 2) : dish.price;
}
/** 价格：特价时现价旁边带划掉的原价 */
function dishPriceHtml(dish, shop) {
  const now = dishPrice(dish, shop);
  return now < dish.price ? `<span class="pricebox">${priceHtml(now)}<s>${yuan(dish.price)}</s></span>` : priceHtml(now);
}

/** 预计多久送到，按当前速度档和这家店的出餐快慢估 */
function etaParts(shop) {
  const speed = SPEEDS[state.settings.speed] || SPEEDS.fast;
  const minutes = (speed.minutes[0] + speed.minutes[1]) / 2 * (shop.factor || 1);
  return minutes < 1.5 ? ["1", "分钟内送达"] : [String(Math.round(minutes)), "分钟送达"];
}
function etaHint(shop) {
  const [n, unit] = etaParts(shop);
  return unit.includes("内") ? `${n} 分钟内` : `约 ${n} 分钟`;
}
/** 还剩多久，拆成大数字和单位 */
function remainParts(ms) {
  if (ms >= 3600000) return [`${Math.floor(ms / 3600000)}:${pad2(Math.floor(ms % 3600000 / 60000))}`, "小时后送达"];
  if (ms >= 60000) return [String(Math.ceil(ms / 60000)), "分钟后送达"];
  return [String(Math.max(1, Math.ceil(ms / 1000))), "秒后送达"];
}

// ── 配送地图：一张示意图，骑手沿着固定的路线从店走到收货人那里 ──
const ROUTE = { p0: [15, 37], p1: [34, 47], p2: [50, 6], p3: [85, 15], from: [2, 47] };
const ROUTE_PATH = `M${ROUTE.p0} C${ROUTE.p1} ${ROUTE.p2} ${ROUTE.p3}`;
const ROUTE_TABLE = (() => {
  const at = t => [0, 1].map(i => (1 - t) ** 3 * ROUTE.p0[i] + 3 * (1 - t) ** 2 * t * ROUTE.p1[i] + 3 * (1 - t) * t * t * ROUTE.p2[i] + t ** 3 * ROUTE.p3[i]);
  const points = []; let length = 0, prev = at(0);
  for (let i = 0; i <= 80; i++) { const p = at(i / 80); length += Math.hypot(p[0] - prev[0], p[1] - prev[1]); points.push([p[0], p[1], length]); prev = p; }
  return { points, length };
})();
/** 路线上走了 f（0–1，按路程算）的那个点 */
function routePoint(f) {
  const target = clamp(f, 0, 1) * ROUTE_TABLE.length, pts = ROUTE_TABLE.points;
  let i = 1; while (i < pts.length - 1 && pts[i][2] < target) i++;
  const a = pts[i - 1], b = pts[i], span = b[2] - a[2] || 1, k = clamp((target - a[2]) / span, 0, 1);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
/** 骑手现在在哪：取餐前从图外赶到店里，取餐后沿路线送过去 */
function riderSpot(order, now) {
  const picked = (order.timeline.find(e => e.key === "picked") || {}).at || order.deliverAt;
  const start = order.timeline[0] ? order.timeline[0].at : now;
  if (now < picked) {
    const k = clamp((now - start) / Math.max(1, picked - start), 0, 1) * 0.86;
    return { x: ROUTE.from[0] + (ROUTE.p0[0] - ROUTE.from[0]) * k, y: ROUTE.from[1] + (ROUTE.p0[1] - ROUTE.from[1]) * k, done: 0 };
  }
  const f = clamp((now - picked) / Math.max(1, order.deliverAt - picked), 0, 1);
  const [x, y] = routePoint(f);
  return { x, y, done: f };
}
const mapAt = (x, y) => `left:${x.toFixed(1)}%;top:${(y * 2).toFixed(1)}%`;
function mapHtml(order, shop, now, bubble, homeHtml, opts) {
  const o = opts || {};
  const spot = riderSpot(order, now);
  return `<div class="map">
    <svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
      <rect class="m-bg" width="100" height="50"/>
      <g class="m-block"><rect x="3" y="4" width="19" height="13" rx="2"/><rect x="26" y="21" width="15" height="11" rx="2"/><rect x="58" y="27" width="14" height="9" rx="2"/><rect x="77" y="22" width="20" height="12" rx="2"/><rect x="45" y="38" width="20" height="9" rx="2"/><rect x="60" y="3" width="13" height="7" rx="2"/></g>
      <path class="m-river" d="M-2 23 C14 15 20 30 34 24 S52 34 62 43 S80 50 102 44"/>
      <g class="m-park"><ellipse cx="80" cy="42" rx="12" ry="5.5"/><ellipse cx="9" cy="27" rx="7" ry="4.5"/></g>
      <g class="m-tree"><circle cx="76" cy="41" r="1.5"/><circle cx="81" cy="43" r="1.8"/><circle cx="85" cy="40.5" r="1.4"/><circle cx="8" cy="26.5" r="1.6"/><circle cx="11.5" cy="28" r="1.2"/></g>
      <g class="m-road"><path d="M-2 19 L102 12"/><path d="M24 -2 L30 52"/><path d="M74 -2 L70 52"/><path d="M-2 36 L102 33"/></g>
      <path class="m-case" d="${ROUTE_PATH}"/>
      <path class="m-route" d="${ROUTE_PATH}"/>
      <path class="m-done" d="${ROUTE_PATH}" pathLength="100" stroke-dasharray="${(spot.done * 100).toFixed(1)} 100"/>
    </svg>
    <span class="m-pin from" style="${mapAt(ROUTE.p0[0], ROUTE.p0[1])};--hue:${esc(shop.color)}"><b>${esc(shop.emoji)}</b><i>${esc(o.fromLabel || "商家")}</i></span>
    <span class="m-pin home" style="${mapAt(ROUTE.p3[0], ROUTE.p3[1])}">${homeHtml}<i>收货</i></span>
    <span class="m-rider" style="${mapAt(spot.x, spot.y)}"><em>${esc(bubble)}</em>${o.riderHtml || `<b>${icon("scooter", 15)}</b>`}</span>
  </div>`;
}
