# Worker Brief 格式(executor sidekick)

首次派发 = 一份自包含 brief。worker 只看得见这份文本(+ 你点名的冻 spec 路径)。
输入必须**全量 inline**,绝不引用 worker 看不见的材料(代码任务要给入口文件、目录结构、
确切运行命令,否则它会自己瞎编)。

**每个 brief 必须以 ROLE 行开头**(防嵌套转派):

```
ROLE: EXECUTOR — do the work yourself; do not spawn subagents.

你是完成一个大项目中单个子任务的 executor。这份 brief 是你能拿到的全部。

子任务: <一句话目标>
冻 spec(若有): <路径;先读再做>
输入: <所需一切,inline 且完整>
验收标准(任一不满足即产出作废):
1. <标准>
2. <标准>
3. <标准>
输出格式: <精确的结构 / 长度 / 风格>
交工: 短 summary(改了什么 + 怎么验)落盘或写在最终消息里

规则: 只做这个子任务,不许扩范围,不许发表评论,不许再 spawn 子代理。
若输入缺失或矛盾,在顶部写 INPUT GAP + 一行指名缺什么,然后用现有材料继续。
只返回交付物,不要开场白。
```

## FIX / 复审:默认热续聊(persistent sidekick)

结果被判 **FIX** 后,**优先**在**同一个** worker 会话里跟一条消息——不要新 spawn:

```
ROLE: EXECUTOR — do the work yourself; do not spawn subagents.

热续聊修复。上一轮没过的验收标准: <编号 + 原文>
具体失败: <命令/输出/file:line>
继续改到过线;不要重读无关上下文;交工仍要短 summary。
```

热续聊吃缓存上下文,远便宜于冷启动。

## 何时才冷 spawn 新 brief

仅当:子代理会话已死 / harness 不可续 / 上下文已毒 / 换模型档位。
那时发一份**全新** brief(仍带 ROLE 行),引用没过的验收标准 + 点名具体失败。

orchestrator **绝不亲手修补** worker 的实质性失败——热续聊或冷重派,二选一。
