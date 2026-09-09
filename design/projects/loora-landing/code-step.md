# loora landing — `code` 格 · step 8 收据

2026-09-09。这一格**不在** `loora-landing.project.json` 的 `steps` 里。不是漏写，是账本写不进去。

## 机制

`design_project_set_stage` 只在**离开**某阶段时写 `steps[当前阶段]`。进入 `code` 的那一次，写下的是 `steps.final`（现挂 `to-code.md`，工具钟 `2026-09-03T12:33:15.451Z`）。`code` 是终站，没有下一格可离开，所以没有 `steps.code`。

2026-09-09 再调一次，参数：`slug=loora-landing`，`stage=code`，`artifact=design/projects/loora-landing/to-code.md`。工具原话：

> Project "loora-landing" is already at stage "code"

账本字节未改。`process/steps` 禁止手改 `*.project.json`；手写 `steps.code` 再填一个 `at`，是假账。所以这一格写在旁边。

没做的：不把 stage 退回 `final` 再进一次。那只会覆写 `steps.final` 的钟，仍然没有 `steps.code`。

## 产物

| | |
|---|---|
| 规格 | `design/projects/loora-landing/to-code.md` |
| 五节 | 目标系统摘要 / 逐值映射表（53）/ 偏离清单 / 交接清单 / 诚实缺口 |
| 落地 | 本轮不写产品仓 |
| 渲染 | **未验证**（没落地，没有可对的产品页） |

## 账本事实（2026-09-09 读过，未改）

- `stage`: `code`
- 硬门 `wireframe`、`final`：`approved`，evidence 是 Fei 原话（9/2、9/3）
- `steps` 仍止于 `final`
