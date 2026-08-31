# PROGRESS — Interaction Lab

| Milestone | Status |
|-----------|--------|
| 0. Spec ingest + scaffold survey | done |
| 1. Shell 通电 | done |
| 2. 相机 | done |
| 3. 模式 | done |
| 4. 屏移植 (playground + product-list) | done |
| 5. 标尺 (Shift+R, canvas-true) | done |
| 6. 便签 (Shift+N, page-space) | done |
| 7. 自验 + REPORT.md | pending |

## 1. Shell 通电
- Vite `port: 5180, strictPort: true` + `vite-plugin-lab-fs`
- App 根渲染 InteractionLab；Inter 自托管；canvas HUD / 色板 / toast
- 相机 store + persistence 模块就位（输入绑定在里程碑 2）

## 2. 相机
- 滚轮平移 / Ctrl+滚轮缩放（定点公式）、空格/中键/空白拖平移
- rAF 合并写入、idle 像素吸附、瞬态 will-change、像素网格
- `+/-`、Shift+0、Shift+1；相机 persist 300ms debounce + pagehide saveNow

## 3. 模式
- explore / focus / fill；Screen Contract；resize / snap / history / Alt 测距
- 键盘图（Shift 1/2/0/F、Tab、Enter、Esc 仲裁、⌘D/Delete/⌘Z、Ctrl+C cleanup、箭头 nudge）
- playground 注册为第一屏

## 4. 屏移植
- playground 琐碎验证屏；product-list 从 reference 移植
- 轮播门控 `visible && active`（探索惰性、锁入后活）；fill 随 frameSize 真视口 reflow
- `motion` 进 app dependencies；lab 核心仍只依赖 react

## 5. 标尺
- canvas-true：guides 页单位，屏幕空间 `(pos+camera)*z`；d3 形 1/2/5 tick，≥56px
- Shift+R / Ctrl+Shift+R；rulerKey 探索优先；getGuides 进吸附；`interaction-lab:guides:v1`

## 6. 便签
- page-space：便签挂在 transformed `.layer` 内，页单位 x/y，随 pan/zoom 与内容同动
- Shift+N 落在视口中心页坐标；Ctrl+Shift+N 显隐；锁入模式不路由便签键且 pointer-events 关闭
- Mynerve 自托管 `/fonts/mynerve/`；持久化 `interaction-lab:notes:v1`（150ms）


