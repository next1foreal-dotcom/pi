# 消息队列（queued messages）行为规格

来源：**逆向 Codex IDE 扩展的出厂 bundle**
`~/.vscode/extensions/openai.chatgpt-26.820.71523-win32-x64/webview/assets/queued-message-list-fC4ldL_N.js`
（版本 26.820.71523，无 source map，React Compiler 产物）
交叉参照开源仓 `github.com/openai/codex`（Apache-2.0，浅克隆在 `D:\@Her\_ref-codex`）的 `codex-rs/tui/` 与 `codex-rs/protocol/src/turn_input.rs`。

> ⚠️ 出厂 bundle 是闭源产物。本规格只记录**可观察的行为与尺寸**，用于独立重写；
> 不得把 bundle 里的代码片段搬进 Her。开源仓那半（Rust）是 Apache-2.0，可参照。

---

## 1. 模型：三种状态，不是两种

| 状态 | 含义 | 视觉 |
|---|---|---|
| queued | 排队，等当前回合结束后依次发送 | 正常行 |
| pending steer | 已送进当前回合，等下一个工具/结果边界生效 | 正常行 + 「调整方向」按钮已按过 |
| paused / rejected | 送不进去（对方在压缩上下文、跑不可打断的回合） | warning 图标 + tooltip，按钮变「重试」 |

第三种是这套东西唯一有工程含量的部分。Codex 的队列存储 `transfer()` 语义是
**remove → await 发送 → 失败则 restore**，保证任何一条消息都不会静默消失。

## 2. 默认行为是一个可切设置

设置项 `followUpQueueMode`，落在「设置 → Follow-up behavior」：

- `queue`（默认）— 回合进行中打字，Enter = **排队**
- `steer` — Enter = **立即插嘴**
- `interrupt` — 旧值，启动时自动迁移为 `steer`

行内 ⋯ 菜单里有同一个开关的快捷入口：「关闭排队 / 启用队列模式」。

## 3. 键位（从 bundle 的 Enter 分支实测）

```
mod = Cmd | Ctrl
send shortcut = 'enter'          → 触发键 = mod+Enter（不带 shift/alt）
send shortcut = 'cmdIfMultiline' → 触发键 = mod+Shift+Enter
                'cmdAlways'

条件：会话是本地会话 且 当前有回合在跑，否则不拦截
动作：action = isQueueingEnabled ? 'steer' : 'queue'
```

**修饰键 = 反转默认**。默认排队时，`mod+Enter` 把这条直接插嘴进去；
默认插嘴时，同一个键改成排队。裸 Enter 永远走默认。

## 4. 面板（输入框正上方）

容器：
```
max-height: 30dvh
overflow-y: auto；隐藏滚动条
gap: 1px（行间几乎贴着）
padding: 0 12px / 上下 var(--padding-row-y)=6px
上下边缘渐隐遮罩，且是 scroll-driven（animation-timeline: scroll(self y)）
—— 只有能往那个方向滚时，那一侧才出现渐隐
```

被用户 Esc 打断过时，列表顶部插一条横幅：

> 由于你中断了当前响应，队列已暂停 　[继续]

横幅下面一条 `border-top` 分隔线。

## 5. 单行

左 → 右：

1. **拖拽手柄**：只有队列 >1 条时可拖。抓手图标平时 `opacity: 0`，
   **hover 整行才淡入**；旁边常驻一个列表图标。`cursor: grab` / 拖动时 `grabbing`。
2. **警告图标**（仅 paused）：tooltip 两行 —
   「这条排队中的消息未能发送」/「重试、编辑或删除该消息以继续发送排队的消息」
3. **图片附件缩略图**：24×24，圆角，`object-fit: cover`
4. **正文**：`line-clamp: 1`，单行截断，行高 20px，次级文字色。
   纯附件无正文时显示摘要（「3 张图像」「粘贴的文本」「2 处选区」）
5. **「调整方向」按钮**（英文 Steer）：ghost 样式，箭头图标 + 文字。
   tooltip：**「提交，但不中断模型运行」** ← 这句话是这个功能的定义
   paused 时整个按钮变成「重试」，tooltip 换成「尝试重新发送这条排队中的消息」
6. **删除**：图标按钮，aria「删除排队的消息」
7. **⋯ 菜单**：编辑消息 / 在侧边聊天中打开 / 关闭排队

编辑中或拖动中：整行 `opacity: 0.6`。

## 6. 动效

| 位置 | 参数 |
|---|---|
| 行进出 | `height: 0 → auto`、`opacity: 0 → 1`，**180ms** |
| 拖拽激活 | 需先拖 **6px** 才启动（防误拖） |
| 拖拽约束 | 只能纵向（x 锁死）；不能拖出滚动容器 |
| 边缘渐隐 | 由滚动位置驱动，不是常驻遮罩 |

## 7. 官方中文用词（照抄，别自己翻）

| key | 中文 |
|---|---|
| sendNow | 调整方向 |
| sendNowTooltip | 提交，但不中断模型运行 |
| retry | 重试 |
| delete | 删除排队的消息 |
| edit | 编辑消息 |
| more | 排队消息操作 |
| openInSideChat | 在侧边聊天中打开 |
| turnOff / turnOn | 关闭排队 / 启用队列模式 |
| interruptedQueue | 由于你中断了当前响应，队列已暂停 |
| resumeInterruptedQueue | 继续 |
| pausedTooltip | 这条排队中的消息未能发送 |
| pausedTooltipRemedy | 重试、编辑或删除该消息以继续发送排队的消息 |

---

## 8. Her 这边的差距

已有（`packages/agent/src/agent.ts:125` `PendingMessageQueue`）：

- `agent.steer(msg)` / `agent.followUp(msg)`，双队列，drain 模式 `one-at-a-time` | `all`
- 协议已经在传：`packages/protocol/src/schemas.ts:254`
  `SessionSnapshot.queuedSteer: UserTranscriptItem[]` + `queuedSteerCount`

缺：

| # | 缺口 | 落点 |
|---|---|---|
| 1 | 只能整清空，没有 `list()` / `remove(id)` / `update(id)` / `move(from,to)` | `packages/agent/src/agent.ts` |
| 2 | `queuedFollowUp` 没上协议（只有 `queuedSteer` 上了） | `packages/protocol/src/schemas.ts` |
| 3 | 送不进去时直接丢，没有 paused 态与重试 | `packages/coding-agent/src/core/agent-session.ts` 的 steer 路径 |
| 4 | 没有 `followUpQueueMode` 设置与修饰键反转 | 客户端 + 设置存储 |
| 5 | 没人画这个面板 | 见下 |

**改协议要留意**：`SessionSnapshotSchema` 是 `StrictObject`，加字段等于改 wire
契约。参考 [[tool-schema-kills-every-turn]] 的教训——schema 出问题是全封不是局部坏，
改完必须真跑一个回合验证，不能只看测试绿。

## 9. 未定

面板先落在哪一面：Studio（`samantha-ui`，跟截图同形态）还是 TUI（`packages/tui`）。
拖拽重排在 TUI 里做不出来，只能退化成 Alt+↑/↓ 移动。
