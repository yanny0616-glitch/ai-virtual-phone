# 外卖 APP 架构

独立 APP，不改宿主。数据全在 APP 自己的 db；和聊天、钱包、通知的联动都走通用 SDK（`chat.sendCard` / `chat.updateCard` / `chat.setContext`、聊天指令和 `chat.message.created` 后台事件、`tasks.schedule`、`wallet.pay`、`ai.chat` / `ai.generate`）。

## 目录

`src/**/*.js` 共享一个闭包（`core/runtime.js` 开头、`bootstrap.js` 结尾），顺序见 `src/bundle.json`。`scripts/build-wai-mai.mjs` 把脚本和 `styles.css` 注入 `src/page.html`，合成单文件 `index.html` 并更新 `public/custom-apps/wai-mai.zip`。

| 文件 | 职责 |
|---|---|
| `core/runtime` | `state`、`$` / `esc` / `yuan`、toast、底部抽屉、确认框、视图切换（`views[name] = { title, tone, render, after }`）、`data-act` / `data-change` 事件委托 |
| `domain/delivery` | 配送时间线（下单时一次算好，带种子随机的延误和小插曲）、`stageAt(order, now)`、催单和改速度（按比例缩放剩余路程）、计价 `priceOrder` |
| `data/seed` | 分类、热词、39 家内置店和菜单、哪些品类不收包装费、按菜名猜 emoji 的规则、`normalizeShop` |
| `data/storage` | 四个集合：`settings` 一行（含地址簿、记住的群、会员、领券和抽奖记录、骑手角色）、`shops`（只存 AI 店）、`orders`、`coupons`（现金券 / 运费券，带门槛、限店、到期）；全量读进内存，写时同步回库 |
| `gen/ai` | 本地搜店、AI 现编店铺（`ai.chat` 返回 JSON）、问角色想吃什么（`ai.generate` + `waimai-crave` 预设） |
| `chat/link` | 和聊天的联动：礼物卡片、代付卡片和回应、角色主动点单、送达任务、上下文文本（含骑手角色和群单） |
| `chat/share` | 拼单卡片和回应、请群聊（全局上下文 + 群聊生成每人一句）、分享店 / 购物车 / 订单给 TA |
| `ui/art` | 内联 SVG 图标、CSS 画的店铺 / 菜品封面、示意地图和骑手位置、装饰数字、菜单分组、规格规则 |
| `ui/home` | 首页、店铺页、送给谁、地址簿、配送 / 自取切换、购物车和选规格 |
| `ui/promo` | 领券中心、天天抽奖、会员 |
| `ui/checkout` | 结算页和下单（自取、群单按人数、运费券 / 会员、顺手带一件、钱包 / 代付 / 拼单） |
| `ui/errand` | 跑腿帮买 |
| `ui/orders` | 订单列表和批量删除、订单详情（自取码、捎话、骑手评价打赏、群里怎么说）、评价、售后、每 2 秒一次的 `tick()` |
| `ui/me` | 我的 |
| `bootstrap` | 启动、从聊天卡片或「+」面板进来时跳到对应页面、注册聊天钩子 |

## 关键决定

- **做成自定义 APP 而不是宿主内置**。现有 SDK 已经够用：卡片、指令、后台事件、定时任务、钱包都有。宿主一行没改。
- **时间线在付款那一刻算好，存在订单上**。之后任何时候只用 `stageAt(order, now)` 读状态，APP 关掉再开、换设备都一致，不需要后台计时。催单和改速度是把还没走完的那段按比例压缩或拉长，再重挂送达任务。
- **送达的副作用交给宿主定时任务**。任务 id 固定为 `wm_arrive_<订单 id>`，同 id 重挂即覆盖；任务里依次是通知、改卡片、写一条聊天历史、更新上下文、请角色回复（按订单类型取其中几项）。礼物卡片要先发出去拿到消息 id，再挂一次任务，任务里才带得上改卡片。
- **角色点单靠后台事件**。`chat.message.created` 里看到 `wm-order` / `wm-pay` 指令卡片就处理，APP 没打开也行；同一条消息只建一张单（按 `directiveMessageId` 去重）。
- **上下文两条路**：`chat.setContext` 写一份常驻的（给不会调用 provider 的场景），`registerContextProvider` 在每次请求时现算一份更准的。只写和这位角色有关的订单；送到之前明说「还没拿到，别问味道」。
- **钱包没有退款接口**，取消已付款订单、少送和洒漏都发成 `coupons` 里的红包，下次下单自动抵扣。天天红包也是往这张表里加一行，`settings.claimDay` 记当天领过。
- **订单的几种形态都落在同一张表上**：`mode` 是空（配送）/ `pickup`（自取，时间线只有备餐，没有骑手）/ `errand`（跑腿，骑手先去 `storeName` 买东西）；`payer` 是 `user` / `char` / `split`，`userPaid` 记你实际掏了多少，售后和取消累计的 `refunded` 不超过它；群单带 `groupId` / `groupMembers`，`recipient` 和 `charId` 留空，所以不会往任何私聊发卡片。
- **请群聊绕开了宿主的限制**。宿主的发卡片、写历史、请求回复都只认角色私聊，群聊引擎只读不分角色的那份上下文，而私聊有当轮 provider 时不会退回全局那份。所以群单写一份全局上下文（注明只在那个群里有效），群里的反应用 `ai.generate` 带群 `sessionId` 生成后存在订单上。
- **骑手可以是角色**。`settings.riderChar` 设了就把角色名当骑手名传给 `buildTimeline`，上下文里告诉 TA 正在给谁送；送达和打赏写进 TA 的聊天历史。
- **今日特价和领券都是按日期哈希**，同一天看到的一样，不用存；领过哪些券记在 `settings.claimed`。
- **购物车的行名带规格**。`cart.items` 的键是「菜名·规格·规格」，`cart.base[行名]` 记原菜名；订单的 `items[].name` 直接存行名，所以聊天卡片、历史和上下文里都带着规格。`dishOf(name, shop)` 用「等于菜名或以菜名加 `·` 开头」把行名找回菜。规格本身不存在菜单数据里，由 `dishSpecs` 按品类和菜名规则推出来，AI 现编的店也能用。
- **不带图片**。封面全是 CSS：店铺是带条纹雨棚的小铺面，菜品是铺格子桌布的小桌，上面放一个 emoji。安装包因此只有 85KB 左右。月售、距离、好评度用店名和菜名的哈希算，固定不变，但不是统计。
- **版式**：黄色主色配黑字，首页地址顶在标题那一行，店铺页左分类右菜单加黑色购物车条，订单详情地图在上。只参考了常见外卖 APP 的布局习惯，没有用任何一家的名字、标志和素材。字号整体偏小（正文 13px，辅助 10–11px）。

## 样式里踩过的坑

单词式的修饰类很容易撞名，撞了就是整块版式错位：`.live`（首页在途卡片）撞 `.st.live`，`.hot` 撞 `.mini.hot`，`.dock.pay` 撞 `.pay i`（付款方式图标）。现在这几处分别叫 `.live-card`、`.hotwords`、`.dock.flat`。0.2.0 里订单管理的勾选框本想叫 `.pick`，撞首页推荐卡，改成 `.chk`；跑腿的加一行按钮避开了地址簿的 `.addr-new`。新加修饰类先搜一遍。封面和头像是 `span`，`> span` 选择器要写成 `:not(.cv)` / `:not(.ava)`。

宿主的运行器只给 `html` / `body` 关了 `overscroll-behavior`，APP 里自己的滚动容器（`.main`、`.sheet`）在 iOS 上照样回弹：页面明明在顶部还能往下拽，标题栏和头图之间露出一截底色。`.main` 设 `overscroll-behavior: none`，`.hero::before` 再垫一块同色兜底。

## 验证

- `npm run waimai:check`：源码、`index.html`、zip 一致，脚本语法。
- `node scripts/check-wai-mai-domain.mjs`：时间线、阶段、催单、改速度、计价。
- `node scripts/check-wai-mai-browser.mjs [--shots <目录>] [--emoji-font <ttf>]`：无头 Chromium 加内存里的假 SDK，走完逛店、选规格、购物车、结算、配送、评价、给角色点、角色点单、代付同意和拒绝、取消退红包、AI 找店、天天红包、排序筛选、设置开关，以及 0.2.0 的领券和抽奖、开会员、到店自取、拼单、请群聊、分享、跑腿加角色骑手、捎话、打赏、售后、批量删除。今日特价每天换一道，测试里的金额都用页面自己的计价算，不写死。Debian 11 的 Chromium 120 画不出 COLRv1 彩色 emoji，截图要用 `--emoji-font` 指一份 CBDT 的 `NotoColorEmoji.ttf`。

没验证的：没有在真机和真实宿主里跑过；聊天界面里 `chat.history` 写入的那条记录长什么样没看过；没调过真实模型。

未做：经营模式（自己开店）。
