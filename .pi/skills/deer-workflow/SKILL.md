---
name: deer-workflow
description: 用 deer-workflow 引擎跑可编程 Dynamic Workflow（phase/parallel 在 TypeScript 里，不在自然语言清单里）。触发：Fei 说「用 workflow」、多角度调研/对抗验证/fan-out 合成、或任务需要可复跑的编排脚本。不适用于单文件小改——那种直接做。纪律层仍用 orchestrate skill；本 skill 只教怎么开引擎。
---

# deer-workflow — 怎么开引擎（不是控制流本身）

**纪律在 `orchestrate`；引擎在 deer。** 本 skill **禁止**把 lint→test→fix 整条控制流写成自然语言步骤清单——那些步骤属于 `.ts` workflow 模块。

## 何时用

- 需要 **fan-out →（可选核对）→ synthesize** 的研究/验证活
- Fei 明确说「用 workflow / dynamic workflow / deer」
- 要一份 **可再跑** 的编排（落在 `packages/her/workflows/*.ts`）

**别用**：单文件小改、一次 ReAct 能做完的事、纯聊天。

## 怎么开（唯一启动面）

调用工具 `her_task_spawn`：

| 字段 | 值 |
|---|---|
| `worker` | `"deer"` |
| `objective` | 人话目标（Tasks 面板标题用） |
| `brief` | **一整段 JSON 字符串**（见下） |

`brief` 形状（stdin 契约，G-145）：

```json
{
  "workflow": "D:/@Her/Her-repo/samantha/packages/her/workflows/<name>.ts",
  "input": {},
  "title": "可选显示名",
  "parentRunId": "若当前有 orchestrator run 则填"
}
```

环境（通常已有）：`HER_MEMORY_DIR`；可选 `HER_DEER_ROOT`、`HER_DEER_AGENT=samantha|fake`。

## 招牌菜路径表（本机）

| name | 绝对路径 | input 要点 |
|---|---|---|
| noop | `D:/@Her/Her-repo/samantha/packages/her/workflows/noop.ts` | `{ "note": "…" }` — 冒烟，无模型 |
| deep-research | `D:/@Her/Her-repo/samantha/packages/her/workflows/deep-research.ts` | `{ "question": "…", "angles"?: ["…"], "maxAngles"?: 2 }` |

新 recipe：落盘到同一目录并 `export meta`（name / phases / exampleArgs），再把路径写进 brief。

## 可见性

- Background / Her tasks：`worker=deer` 的 bg-task 记录
- runs：`kind:"workflow"`，title 随 phase 变（bridge 已写）

## 与 orchestrate 的分工

| | orchestrate | deer-workflow |
|---|---|---|
| 是什么 | 七步纪律 + 子代理 brief | TS 引擎 + `workers.deer` |
| 控制流 | 你口头/子代理执行 | `.ts` 里的 `phase`/`parallel` |
| 何时叠用 | 大团队纪律 | 需要可复跑 DAG / 对抗研究环 |

## 红线

- 不改 pi core；不往 Python her-core 塞编排
- 读 untrusted 的子步骤：workflow 内 `sandbox: "read-only"`；**禁止**子代理直接写 her-memory——回写由你（父会话）经 Her 工具做
- 默认 **显式触发**；不要每句复杂话都自动开 workflow（费钱）
