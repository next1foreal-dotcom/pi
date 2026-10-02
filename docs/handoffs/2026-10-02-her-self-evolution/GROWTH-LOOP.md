# Her 成长闭环：本机 Codex 接续任务

## 范围修正

用户确认继续完整主线：发现 → 学习 → 迁移 → 修正。此前的 HER-FIRST-LEARNED-TOOL.md 只作为子用例，不再代表完整验收。

本文件补充同目录 HANDOFF.md，不取消正在执行的旧测试迁移、回滚关联修复或完整工程回归。不要覆盖本机 Codex 已完成和未提交的工作。本机实际进度未被本次远端读取验证。

## 已交付

同目录 growth-loop-source.tar.xz 是隔离源码候选，包含四个源码文件、一份测试、MANIFEST.json 和 reproduce.py。未应用到 packages/ 运行路径，没有注册生产工具或后台任务。

归档 SHA-256：1025891bf0e009c274f571da51b050928c3999594b2beb72e12f38a966b1ee86
归档 Git blob：e6a19128e7e310f8de9df319a9bdaa15a18c019b

解压到新建临时目录，先核对摘要，再读取 her-growth-loop/source/ 下的五个文件。它们拟落到：

- packages/her/src/growth-experiment/types.ts
- packages/her/src/growth-experiment/parse.ts
- packages/her/src/growth-experiment/model.ts
- packages/her/src/growth-experiment/loop.ts
- packages/her/test/growth-experiment.test.ts

源码档不包含累计 selfmod 补丁，也不替代原 HANDOFF。源码档的 MANIFEST 还记录了聊天完整交付包中新增文件补丁的摘要，但该补丁不在这个精简源码档内；直接逐文件审查新增源码即可。

`python reproduce.py --out <新的证据目录>` 可运行离线工程测试；类型检查需要本地 tsc 与 Node types，可用 --type-roots 指定。不会联网或安装依赖。

## 已实现的候选接口

startInquiry / advance：比较经历，允许不学习，或者提出竞争解释、设计实验、根据观察形成有边界的方法。
createReasoner：使用宿主提供的现有 ModelLike.complete 和明确 token 上限，不选择新供应商、不读取凭据。
tryMethod：新任务把已有方法作为可选背景；宿主另查前提与授权，再实际执行。
reconcile / reconcileReview：中断后由宿主核对真实结果；pending 动作不会自动重跑。
reopen：新经历恢复研究，保留旧版本和记录，不重置预算。

方法带前提、步骤、停止条件、反例与来源，不要求必须生成代码。独立评测通过只成为 trial-ready，限定隔离试验；不等于生产采用。实际使用失败或未知时暂停正确版本，等待调查，不认定因果。普通 out-of-scope 不全局废弃方法。

## 必须完成的真实宿主接线

在完整独立工作树读取最新规则、BACKLOG、现有实现和新文件是否已经存在。当前集成分支是 her/phase-0-pi-hygiene，不是 pi/main。重新比较本机状态，不能盲套读取时的 3f918b0 基线。

实现 GrowthHost，复用当前宿主：

1. reason 使用批准的现有模型，记录真实 usage，固定实验模型与主要设置。
2. save 接现有 Markdown 实验/提案存储的单一写入方和锁；先创建 revision 0，此后原子比较 expectedRevision，持久追加快照。不能直接写第二套任务台账。
3. authorizeProbe / authorizeUse 接现有 STOP、授权、隔离及金额/token/耗时预算，绑定具体 runId 与动作。不要返回常量 true。
4. runProbe 通过现有任务执行器在隔离环境运行模型提出的实验，返回实际观察及核实过的产物/日志引用。模型 action 只是提案，不能无条件作为 shell 执行。
5. review 复用独立证据评测；宿主在候选产生前冻结计划与最终样例，记录真实 methodId/planDigest 收据。最终测试不可回流调参。不能 mock 成通过。
6. checkApplicability 独立读取当前环境，检查方法前提；runUse 实际使用方法并核验结果，回执绑定 taskId、methodId、runId。

源码只限制次数，不承担真实账单或墙钟预算；后者必须由宿主约束。端口和保存的数据都是受信宿主合同，不是候选能自行改变的权限。还需接任务结果事件、跨任务检索与唤醒。本包没有多方法组合实现。

## 四步真实验收

发现：给正常任务和结果标准，不提示“生成脚本”或预写具体学习答案；允许无须学习。没有失败，不强造失败。
学习：Samantha 提出解释和实验，宿主核对可行性及区分力后执行，从真实观察形成方法。未解决问题保留醒来条件。
迁移：真实新会话只给任务，不提醒用旧方法。分别测试同类新样例、表面不同但结构相关的任务、需要适配的任务。换路径再调用只能记复用。与获得相同原始经历的版本比较，固定模型与执行预算，另列学习成本。
修正：加入看似相近但不适用的反例；主动拒绝和被宿主拦下分开统计。检查条件改变后正确版本被暂停、下次不继续误用，新证据触发重新研究和评测，旧记录保留。方法暂停不是生产 Git 回滚。

先接线并跑真实源码依赖下的新测试、受影响回归和根 npm run check，再在批准模型与总预算内做真实四步实验。没有额外预算，先完成不联网工程部分，不能借现有凭据暗中付费。

## 证据与提交边界

本包27项工程测试通过，局部严格类型检查和新增补丁检查通过。测试使用预设模型回复和宿主夹具，方法内容由测试预写；不证明自主问题发现、真实迁移或能力增长。

没有完整 checkout、Windows、真实模型实验、生产采用/回滚或独立代码审查。摘要与字段只做一致性校验，不认证来源、不证明语义去重或考试隔离；本模块不是 OS 沙箱。

沿用本任务既有 commit/push 授权：对应验证完成后提交自己的独立任务分支，准确更新实际台账，不强推、不绕过签名/钩子、不自动合并或部署。工程结果与真实学习效果分栏交付。

这次发布仅更新隔离交接材料，通过 GitHub 接口完成，不代表在本机运行了 hooks、npm run check 或 Codex，也不代表这份追加任务已进入正在运行的 Codex 会话。
