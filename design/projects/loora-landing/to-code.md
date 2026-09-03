# loora landing — to-code · step 8

2026-09-03。权威已翻转：**项目是规格，设计是参考。** 目标仓 `D:\@APPProject\brilliant-local` 只读，本轮不落地。活 token 在 `src/styles.css`（`App.tsx:27` 唯一导入），不是 `src/index.css`。

---

## 1. 目标系统摘要

先读了 `src/index.css` 与 `index.html`，再读 `src/styles.css` 的 `:root` 与相邻组件。

### `src/index.css`（读了 · 不是活 token）

Vite 模板残留：`--bg #fff` / dark `#16171d`、`--accent #aa3bff`、`--sans system-ui`（`src/index.css:1–47`）。`index.html:1–13` 只挂 `/src/main.tsx`，不链这份 CSS。`main.tsx` 不导入它。**落地时忽略。** 活系统如下。

### 颜色（studio 默认 · `src/styles.css` `:root`）

| token | 值 | 出处 |
|---|---|---|
| `--bg` | `#393d3c` | `styles.css:3` |
| `--panel` | `#414544` | `styles.css:4` |
| `--panel-2` | `#4a4e4d` | `styles.css:5` |
| `--elevated` | `#545857` | `styles.css:6` |
| `--line` | `#575c5a` | `styles.css:7` |
| `--line-soft` | `#494e4c` | `styles.css:8` |
| `--text` | `#e5e6e6` | `styles.css:11` |
| `--text-dim` | `#b4b7b6` | `styles.css:12` |
| `--text-faint` | `#8b8f8d` | `styles.css:13` |
| `--accent` | `#dfe2e1` | `styles.css:16` |
| `--accent-hover` | `#eaecec` | `styles.css:17` |
| `--accent-press` | `#cfd2d1` | `styles.css:18` |
| `--accent-fg` | `#2b2f2e` | `styles.css:19` |
| `--accent-tint` / `-soft` / `-glow` / `-line` | rgba 族 | `styles.css:20–23` |
| `--accent-2` / `--accent-2-ink` | `#c9cccb` / `#2b2f2e` | `styles.css:26–27` |
| `--success` / `--danger*` | 语义色 | `styles.css:28–32` |

noir / paper 是 `[data-theme]` 覆盖（`styles.css:82–160`），不是默认外衣。`theme.ts:1–5`：studio 为缺省。落地锁定 studio，不切主题。

JS 字面量、**不是 CSS token**：画板底 `THEME_CANVAS_BG.studio = '#2f3231'`（`App.tsx:30`）；选中描边 `'#0d99ff'`（`Overlay.tsx:52`）；点阵 `rgba(0,0,0,0.14)`（`Canvas.tsx:698`）。

### 字体

| token | 值 | 出处 |
|---|---|---|
| `--font` | `'Inter var', 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif` | `styles.css:42` |
| `--mono` | `ui-monospace, 'Cascadia Mono', 'SF Mono', 'JetBrains Mono', Menlo, monospace` | `styles.css:43–44` |
| `--fs-11` / `--fs-12` / `--fs-13` | `11/12/13px` | `styles.css:45–47` |
| 字阶 14 / 16 | **无** | — |
| 页面品牌脸（Merrion / Fraunces / Geist） | **无** | 产品品牌脸就是 Inter |
| `body` | `font-size: var(--fs-12); line-height: 1.4` | `styles.css:181–183` |

`index.html:6` 标题仍是 `her-design — vector canvas with an agent`。`package.json` name = `her-design`。

### 圆角

| token | 值 | 出处 |
|---|---|---|
| `--r-sm` | `5px` | `styles.css:35` |
| `--r-md` | `7px` | `styles.css:36` |
| `--r-lg` | `10px` | `styles.css:37` |
| `--r-pill` | `999px` | `styles.css:38` |
| `--radius` | `var(--r-md)` | `styles.css:39` |

### 间距 / 几何（没有 4/8/16 通用阶）

| token | 值 | 出处 |
|---|---|---|
| `--rail-w` | `232px`（窄屏 `180` / `0`） | `styles.css:58`；`2714`；`2722` |
| `--dock-inset` | `20px` | `styles.css:59` |
| `--dock-gap` | `12px` | `styles.css:60` |
| `--capsule-h` | `42px` | `styles.css:61` |
| 窄屏断点 | `max-width: 899px` / `900–1199` | `styles.css:2712–2722` |
| 页面 720px 断点 | **无** | — |

### 动效

| token | 值 | 出处 |
|---|---|---|
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` | `styles.css:64` |
| `--dur` | `120ms` | `styles.css:65` |
| `--dur-2` | `190ms` | `styles.css:66` |
| `--motion-fast-duration: 160ms` | **无**（只出现在 agent 知识库 `knowledge/tools/motion.md:19`，未进 `:root`） | — |
| reduced-motion（已装） | 相关动画 `animation-duration: 1ms` | `styles.css:498–502`；`1739–1746`；`2611–2615` |
| 全局 `transition-duration: 0.01ms` | **无**（`motion.md:38–45` 的写法未装进 CSS） | — |

### 已有组件（用它，不重造）

| 组件 | 路径 | 用途 |
|---|---|---|
| `Canvas` | `src/canvas/Canvas.tsx` | 无限画布、点阵、平移/缩放；host 底 `background: 'var(--bg)'`（`:681`）；点阵步长 `20 * zoom`（`:675`） |
| `Overlay` | `src/canvas/Overlay.tsx` | 选中框 + 八角手柄（角 7 / 边 6，白填 + `#0d99ff` 描，`:108–125`） |
| `NodeView` / `SceneTree` | `src/canvas/NodeView.tsx` | 真节点绘制 |
| `button.primary` / `.ghost` / `.mini` / `.tool` | `styles.css:276–386`；`:275–314` | 主按钮、幽灵、拷贝、工具格 |
| `.top-actions-bar` / `.bottom-toolbar-bar` | `styles.css:531–541` | 胶囊铬：`--elevated` + `--line` + `--r-pill` + `--shadow-pop` + `--capsule-h` |
| `.toast` | `styles.css:1875–1887` | 反馈条 |
| 拷贝态 | `src/ui/settings/McpPage.tsx:31–81` | `Copied ✓`，2000ms 收回；按钮 class `mini` |
| `AboutPage` | `src/ui/settings/AboutPage.tsx:27` | 「No account, no cloud, no telemetry」事实源 |

产品**没有** landing 路由、没有 `wf-*` 类。`App.tsx` 是工具壳（rails + Composer + 双胶囊），不是这页。

---

## 2. 逐值映射表

首稿视觉值来自 `packages/design-lab/src/screens/loora-landing/styles/wireframe.css`（下称 draft）与 `canvas.tsx` / `screen.tsx`。四种归宿只选一。

| # | 首稿值 | 出处（稿） | 归宿 | 项目落点 |
|---|---|---|---|---|
| 1 | `--ll-bg: #393d3c` | draft:48 | **命中 token** | `--bg`（`styles.css:3`） |
| 2 | `--ll-panel: #414544` | draft:49 | **命中 token** | `--panel`（`:4`） |
| 3 | `--ll-inset: #4a4e4d` | draft:50 | **命中 token** | `--panel-2`（`:5`） |
| 4 | `--ll-float: #545857` | draft:51 | **命中 token** | `--elevated`（`:6`） |
| 5 | `--ll-line: #575c5a` | draft:52 | **命中 token** | `--line`（`:7`） |
| 6 | `--ll-text: #e5e6e6` | draft:53 | **命中 token** | `--text`（`:11`） |
| 7 | `--ll-text-2: #b4b7b6` | draft:54 | **命中 token** | `--text-dim`（`:12`） |
| 8 | `--ll-text-3: #8b8f8d` | draft:55 | **命中 token** | `--text-faint`（`:13`） |
| 9 | `--ll-accent: #dfe2e1` | draft:56 | **命中 token** | `--accent`（`:16`） |
| 10 | `--ll-accent-fg: #2b2f2e` | draft:57 | **命中 token** | `--accent-fg`（`:19`） |
| 11 | `--ll-radius-sm: 5px` | draft:58 | **命中 token** | `--r-sm`（`:35`） |
| 12 | `--ll-radius: 7px` | draft:59 | **命中 token** | `--r-md`（`:36`） |
| 13 | `--ll-radius-lg: 10px` | draft:60 | **命中 token** | `--r-lg`（`:37`） |
| 14 | `--ll-ease: cubic-bezier(0.2, 0, 0, 1)` | draft:61 | **命中 token** | `--ease`（`:64`） |
| 15 | `--ll-dur: 120ms` | draft:62 | **命中 token** | `--dur`（`:65`） |
| 16 | `--ll-dur-2: 190ms`（稿内声明、过渡未用） | draft:63 | **命中 token** | `--dur-2`（`:66`）；落地保留给入场/第二档，本页交互继续只用 `--dur` |
| 17 | `--ll-font: "Merrion Sans", system-ui, sans-serif` | draft:64；`@font-face` draft:5–34 | **token 债** | 产品 `--font` 是 Inter（`:42`）。宪法禁 Inter 当品牌脸；brief 垫过 Fraunces/Geist，稿改垫 Merrion。**禁止静默吸附到 Inter。** owner 在：加页面字体 token / 用 Geist / 改产品 `--font` |
| 18 | `--ll-mono`（无 JetBrains） | draft:65 | **差一档吸附** | 吸附到 `--mono`（`:43–44`，多 `'JetBrains Mono'`） |
| 19 | 词标 `font-size: 16px` / `font-weight: 700` | draft:212–214 | **token 债** | 无 `--fs-16`、无 weight token。research 禁把 `--fs-11/12/13` 当页面正文，故**不吸附到 13** |
| 20 | 主张/信任/源码/提示/命令 `14px` | draft:223, 233, 240, 262, 298, 309 | **token 债** | 无 `--fs-14`。同上，不吸附到 `--fs-13` |
| 21 | 节点文案 `16px` / `600` | draft:162–163 | **token 债** | 同 19；节点字是画布上唯一的句子，不是工具面 11px |
| 22 | 隐藏 caption `11px` / mono | draft:150–151 | **命中 token** | `--fs-11` + `--mono`。皮肤已把 rect/frame 标签砍掉（`.wf-caption { display:none }` draft:120–123），落地保持砍 |
| 23 | HUD 桌面 inset `24px` | draft:210–211, 238–239, 259, 268 | **差一档吸附** | `24 → 20`，`--dock-inset`（`:59`） |
| 24 | HUD 窄屏 inset `16px` | draft:325–348 | **token 债** | 夹在 `--dock-gap 12` 与 `--dock-inset 20` 之间，无 16。不擅自吸附 |
| 25 | 命令条 `height: 40px` | draft:274 | **差一档吸附** | `40 → 42`，`--capsule-h`（`:61`） |
| 26 | 命令条 `padding: 4px 4px 4px 14px` | draft:275 | **差一档吸附** | 吸附到胶囊 `padding: 5px 6px`（`styles.css:534`） |
| 27 | 命令条 `border-radius: var(--ll-radius-lg)`（10px） | draft:278 | **命中 token** | `--r-lg`。不改成 `--r-pill`：这是底栏命令条，不是工具胶囊（偏离见 §3） |
| 28 | 命令条 `gap: 16px` | draft:273 | **token 债** | 无 16 间距 token。`--dock-gap` 是 12，差 4px 但语义是条内字距不是 dock 间隙，交给 owner |
| 29 | 内胶囊 `height: 32px` / `padding: 0 12px` / `--r-sm` / `--accent` | draft:305–311 | **已有组件** | `button.primary`（`styles.css:305–314`：`padding: 5px 13px`、`--r-sm`、`--accent` / `--accent-fg`）。高度随内容，不另造 32px |
| 30 | `.wf-cmd.is-copied span` → `--ll-float` / `--ll-text` | draft:319–320 | **已有组件** | `button.primary.is-on`（`styles.css:380–384`：`--accent-2` / `--accent-2-ink`） |
| 31 | `.wf-cmd:hover` → `--ll-inset` | draft:288 | **命中 token** | 条背景 hover 用 `--panel-2`；内按钮 hover 走 `button.primary:hover` → `--accent-hover`（`:313`） |
| 32 | 链接 hover 色 `--ll-text`；过渡 `--ll-dur` / `--ll-ease` | draft:244–250 | **命中 token** | `color: var(--text)`；`transition: color var(--dur) var(--ease)` |
| 33 | `:focus-visible` `outline: 1px solid accent; offset 4px/2px` | draft:254–255, 292–293 | **差一档吸附** | 吸附到全局 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`（`styles.css:209–211`） |
| 34 | reduced-motion `transition-duration: 0.01ms` | draft:355 | **差一档吸附** | 吸附到产品已装的 `1ms`（`styles.css:498` 等）。不引入稿里的 0.01ms，也不把 `motion.md` 的全局 `*` 规则偷偷装上 |
| 35 | 点阵 `radial-gradient(inset 1px)` / `24px` | draft:103–104 | **已有组件** | 用 `Canvas`：步长 `20 * zoom`（`Canvas.tsx:675`），点 `rgba(0,0,0,0.14)`（`:698`），host `--bg`（`:681`）。`24 → 20` 随组件走 |
| 36 | 页面地色 = studio 石墨 | draft:71 | **命中 token** | 画布 host `--bg`。**不要**把 `THEME_CANVAS_BG #2f3231`（`App.tsx:30`）当页面地——那是文档板，且不是 CSS token |
| 37 | 选中砖背景 `--ll-float`、边 `--ll-accent` | draft:134–139 | **命中 token** | 节点面 `--elevated`、边 `--accent`。若改嵌真 `Overlay`，选中描边会变成 `#0d99ff`（见债 7 / 偏离） |
| 38 | 手柄 `8×8` 实心 `--ll-accent` | draft:170–172 | **已有组件**（若嵌真画布） / 否则 **差一档吸附** | 真画布：用 `Overlay`（角 7 / 边 6，`:111`）。微画布残留：`8 → 7` 对齐角手柄。颜色见债 |
| 39 | 簇间距 20px（砖底到文案） | `canvas.tsx:52–58`（584,360 砖 272×152；文案 y=532） | **命中 token** | `--dock-inset` 20px。几何本身（272×152）是构成不是 token，原样 |
| 40 | 种子节点 `kind: rect + text` | `canvas.tsx:56–58` | **已有组件** | `createNode` / `NodeView` 的 rect、text。不要再写一套 `wf-node-*` |
| 41 | 拷贝成功 1600ms | `screen.tsx:28` | **差一档吸附** | 吸附到 `McpPage.tsx:81` 的 2000ms。文案「已复制」可留中文；产品先例是 `Copied ✓`（owner 可翻） |
| 42 | 命令 `npm install && npm run dev` | `screen.tsx:16`；`README.md:8–11` | **命中（事实）** | README 真入口。样式走 `--mono` + `button.primary` |
| 43 | 信任句「无账号 · 无服务器 · 无遥测」 | `screen.tsx:47` | **命中（事实）** | `AboutPage.tsx:27`；`README.md:6` |
| 44 | 源码 `github.com/next1foreal/brilliant-local` | `screen.tsx:53` | **token 债 / 内容债** | 仓不是 git remote 在本机可证的活链接；**仍是垫的 URL** |
| 45 | 窄屏切点 `frameSize.width < 720` | `screen.tsx:21` | **差一档吸附** | 吸附到产品 `max-width: 899px`（`styles.css:2717`）。720 是 lab 框，不是产品断点 |
| 46 | `line-height: 1.5`（主张） | draft:225 | **差一档吸附** | `1.5 → 1.4`，跟 `body`（`styles.css:183`） |
| 47 | 词标 `letter-spacing: -0.04em`；节点 `-0.02em`；caption `0.02em` | draft:214, 164, 153 | **token 债** | 产品只有字面量 `-0.2px`（`.doc-title` `:271`），无 tracking token。不发明 `--tracking-*` |
| 48 | 词标 weight 700 | draft:213 | **token 债** | 产品标题档是 `font-weight: 600`（`.doc-title` `:270`）。700 无 token；吸附 600 会削词标，交给 owner |
| 49 | 主按钮 weight 600 | draft:310 | **差一档吸附** | `button.primary` 是 `font-weight: 550`（`styles.css:308`） |
| 50 | `--ll-*` 私有前缀 | draft:48–65 | **命中（命名）** | 删前缀，直接用产品名。零平行色板 |
| 51 | 微画布实现（`LiveCanvas`） | `canvas.tsx` 全文件 | **已有组件** | 优先嵌 `Canvas` + store。lab 微画布是产品拍不到时的替身，不是规格 |
| 52 | 四角 HUD（词标/主张/源码/提示/命令） | `screen.tsx:41–67` | **页面结构（无组件）** | 产品没有 landing HUD 组件。**不要**用 `.top-actions` / `.bottom-toolbar` / rails / Composer 冒充这页。新页面类跟邻居命名：BEM 短名即可，token 用产品的 |
| 53 | `.shadow-pop` / 胶囊阴影 | 稿未用 | — | 命令条稿是 1px 线、无投影。不擅自加 `--shadow-pop`（那是工具胶囊的） |

---

## 3. 偏离清单（相对首稿 · 含自认改进）

未列 = 没发生。本轮不改 design-lab 画布。

| 偏离 | 理由 |
|---|---|
| 色/半径/运动从 `--ll-*` 改叫产品 token 名 | 项目是规格；平行色板落地即异物 |
| HUD 24px → `--dock-inset` 20px | 差一档吸附。四角会略贴画布，与产品胶囊 inset 对齐 |
| 命令条高 40 → 42 | 对齐 `--capsule-h` |
| 命令条内边距 4/14 → 胶囊 5/6 | 同上 |
| 内胶囊不再自建 32px 高 | 用 `button.primary`，高度随 5+13 padding |
| 已复制底从 `--elevated` 改为 `primary.is-on`（`--accent-2`） | 产品已有「按下还亮着」态；`--elevated` 是 hover 面，语义不对 |
| 主按钮字重 600 → 550 | `button.primary` 字面量 |
| 主张行高 1.5 → 1.4 | 跟 `body` |
| 窄屏 720 → 899 | 产品唯一布局断点 |
| 点阵 24px → Canvas 20×zoom | 组件赢 |
| 手柄 8px 实心石墨 → Overlay 7/6 白芯蓝边 **仅当**嵌真画布 | 组件赢。微画布残留则只把 8→7，**颜色仍走 `--accent`**，不偷偷改成 `#0d99ff` |
| reduced-motion 0.01ms → 1ms | 产品已装的是 1ms |
| focus 1px / offset 4 → 2px / offset 2 | 全局 `:focus-visible` |
| 拷贝停留 1600 → 2000 | `McpPage` 先例 |
| mono 栈补上 JetBrains | `--mono` 规格 |
| **不**把命令条改成 `--r-pill` 工具胶囊 | 看起来更像产品铬，但是把「一条命令」说成「工具条」。10px 条还是页，不是 app shell。**自认想改也先列在这里，落地默认不改** |
| **不**上 `--shadow-pop` | 同上 |
| **不**把页面地改成 `#2f3231` | 那是文档板字面量，不是 token；页地 = `--bg` |
| **不**挂 App rails / Composer | 结构锁在线框门：页面即画布，文案四角。工具壳是产品内部，不是这页 |
| Merrion **不**吸附到 Inter | 那会把宪法和产品规格撞在一起；记债，不私自发明第三套 |

---

## 4. 交接清单

- [x] token 命中处零字面量（§2 标「命中 token」的 1–16、22、27、31–32、36–37、39、42–43、50：落地写 `var(--bg)` 等，禁止再写 `#393d3c`）
- [x] token 债清单（不是「无」）：
  1. 页面字阶 14 / 16（无 `--fs-14` / `--fs-16`）——**不**吸附到 13
  2. 品牌/页面字体：Merrion（稿垫）vs Fraunces/Geist（brief 垫）vs Inter（产品 `--font`）。三选一是 owner 的
  3. 窄屏 HUD 16px inset
  4. 命令条内 `gap: 16px`
  5. letter-spacing `-0.04em` / `-0.02em` / `0.02em`
  6. 词标 weight 700
  7. 若嵌真 `Overlay`：选中色 `#0d99ff` 是组件字面量，不是 token；graphite 选中 vs Figma 蓝，owner 定
  8. 源码 URL 仍是垫的（内容债，顺手放这里）
- [x] 偏离已列（§3）
- [ ] 渲染验证：**未验证，因为本轮不落地**

落地时建议的文件（不在本轮写）：产品仓里一条 landing 路由 + 一层 HUD；画布嵌 `Canvas`，不要把 lab 的 `wf-*` 拷进去。类名跟邻居走，token 跟 `:root` 走。

---

## 5. 诚实缺口

1. **真产品帧仍无。** 本机没有跑着的 loora 本体；`localhost:5180` 是 design lab。微画布证明形态（拖/缩/落），几何不是本体，没有 agent 流式落点。等产品在这台机器上跑起来再换嵌。
2. **源码 URL 仍是垫的** `github.com/next1foreal/brilliant-local`（`screen.tsx:53`；brief 默认值 3）。
3. **Merrion 字体是我垫的**（相对 brief 的 Fraunces/Geist；相对产品是 Inter）。可翻。见债 2。

另：`src/index.css` 紫 accent 模板与产品无关；`knowledge/tools/motion.md` 的 160ms / 全局 0.01ms **不是**装进 CSS 的 token。
