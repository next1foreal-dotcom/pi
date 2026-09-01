# Design mode 工作流重规划 — 提案

状态:**提案**(2026-08-31),待 Owner 拍末节三个决策后立卡开工。
纲:"Make every detail perfect, and limit the number of details."(已落 knowledge/INDEX + taste/canon,`9249a79`)

## 病根

她没有阶段:brief 直接进高保真,结构没对齐就开始磨细节,Owner 只能在成品上打回——最贵的打回。知识库 36 篇只教"怎么做对",流程只有散的纪律(direction-first / variants),没有一条流水线。8/2 判决"还很 AI"的三件解法只落了一件半(视觉外包通,核心句补,正面样本与构图教材未动)。

## 目标态:八步流水线

| # | 步 | 产物(落档) | 机制 | 门 |
|---|---|---|---|---|
| 01 | 想法 idea | brief:解什么题 + 成功判据 | createProject 写入 manifest | — |
| 02 | 场景研究 research | research 笔记(artifact,可预览批注) | 复用 artifacts 目录,零新工具 | — |
| 03 | 情绪板 moodboard | 画布方向板:2–3 方向 × 参考/材质/排版 + 各一句方向句 | 依赖 W-10 参考库 | 轻门:方向选择发 Owner,异步不阻塞 |
| 04 | 线框 wireframe | 灰盒结构稿:真层级、真文案骨架、假视觉 | 阶段 lint:非灰阶/效果 = 越阶 | **硬门:结构对齐** |
| 05 | 首稿 first draft | 首版视觉稿 | 进入前置:线框门 approved | — |
| 06 | 迭代 iterations | 迭代日志:每轮改了什么 | 已有批注笔/视觉外包/lint;纪律=先减后加 | — |
| 07 | 定稿 final | 定稿 + 自查报告 | 自查全套先跑,报告附上再请审 | **硬门:终审** |
| 08 | 出码 to code | exportCode HTML + 交接清单(token/间距/状态) | 已有 exportCode,薄档 | — |

知识载入随阶段走:01–04 只载 process/*+taste(细节类知识此时不进上下文),05 起才载 design/* 全套——"limit"施于 harness 自身,替掉现在"每次 8–14 键全载"。

## 机制设计(W1 的实体)

1. **project manifest** — `documents/<project>.project.json`:brief、当前 stage、每步产物引用(doc slug / artifact / 笔记)、门记录、迭代日志。sidecar 惯例,设计文档字节零污染(同批注笔)。
2. **5 个新工具**(对比现有 23,克制):`createProject` / `getProject` / `listProjects` / `setStage` / `recordGateVerdict`。setStage 走到门位自动挂 pending;进 draft 前置检查线框门 approved。
3. **门的裁决不建审批 UI** — Owner 裁决走现有批注笔或对话;`recordGateVerdict` 必须附 evidence(批注 id 或原话引用);`auditConsistency` 巡检门记录,无证据的 approved = 红。防"她自己给自己开门"。
4. **阶段 lint** — lintGeometry 读 manifest stage;wireframe 阶段出现非灰阶填充/阴影/渐变/图片 → 新增"越阶细节"类。**不硬拦工具**(机械护栏往误杀偏,2026-08-12 血证),lint 报告 + 门前必查。
5. **INDEX 重排** — Task→keys 表改为阶段行,每阶段 4–6 键。

## 显式砍掉的(limit 自证)

- **React/组件 codegen** — 设计产物是基准不是生产代码;出码只做忠实导出 + 交接清单。
- **审批工作流 UI** — 门的裁决复用批注/对话。
- **research 专用工具** — 现有 artifacts + 她的浏览器/文件能力够用,只补一篇知识。
- **阶段硬拦(工具层拒绝)** — 只 lint 可见,不锁工具。

## 分波(竖切,各自可验收)

| 波 | 内容 | 谁干 | 验收 |
|---|---|---|---|
| **W1 流程骨架** | manifest + 5 工具 + 门机制 + 阶段 lint + INDEX 重排 | 实现包,外派 | 小题走 8 步:越阶被 lint 逮、两门真停、无证据 approve 巡检红 |
| **W2 前半段器官** | process/brief·research·wireframe 三篇新知识 + direction-first 改版 + **W-10 参考库首批 6 条正面样本 ✅ 2026-09-01 落 `research/positive-samples`(323fa8ebe)**:rico×2/vercel/Timestate/YORK/Lightspark,每条标实测或目测+绑定既有规则。handoff/会话状态教材以 references/figma-to-webflow-workflow/templates/PROJECT-HANDOFF-template.md 为基准件(重写不追加/事实活验不抄前/显式改错/开局五分钟) | 知识与榨取,Fable 亲手 | 同题重跑,方向板与线框质量过 Owner 眼 |
| **W3 构图教材 + 骨架偏差** | 构图知识 ✅ 2026-09-01 落 `design/arrangement`(b2ecc1b4d,焦点/重量预算/脊柱/密度反差/视线路径,锚正样本 1/3/5);wireframe→draft 布局偏差检查——**Fable 垫的调整(随时可翻):并入 G-375·3 门迁移包一起做**,不在冻结的 loora 单独加新机器 | 教材亲手 ✅;偏差检查随 ·3 外派 | 教材过 Owner 读;偏差检查双侧用例 |
| **W4 出码薄档** | handoff 交接清单 + 导出规范。**教义(2026-08-31 进料 #7,Matt Vidal 定稿)**:①设计文件是参考,项目系统才是规格——两者冲突时**系统赢、设计弯**(为后面九页买单;"一个类用十二处是系统,用一处只是一页");②未做的决策禁止被静默做掉——模型替你"合理地"补的每个决定都要显影进 handoff,页面看着没事时规则正悄悄积累成没人选过的架构;③工具调用成功≠写入落地——"请求不是收据",发布出来的页面才是唯一证据 | 外派,薄 | 一次真导出 + 清单核对(含决策显影核对) |
| **毕业重考** | 真题 8 步全程 | 她跑,Owner 终审 | Owner 的眼 |

依赖:W1 独立先行;W2 依赖 W1 的阶段载入;W3/W4 与 W2 写集无交集可并行。

## 决策记录

1. **门位**:硬门 = 线框 + 定稿;moodboard 方向选择为轻门(异步不阻塞)。——**Owner 已拍(2026-08-31)**。
2. **出码走薄档**(不建 codegen)。——**Owner 已拍(2026-08-31)**。
3. **毕业考真题**=**动态 landing page**(Owner 2026-09-01 拍)。卷面落 `docs/design/graduation-exam.md`;题目主体 Fable 垫为 **loora 的落地页**(真需求/干净信号/动效承担信息),换题只需换卷面第一节。这道题同时点燃 G-375 的 ②③ 门票(研究步要提取器、考试必须在她家考),两包 9/1 已派。
4. **家 = her(2026-08-31 夜拍)**:通用知识迁她仓 skill 形态,W2–W4 落点改为她仓;W1a 门逻辑毕业考前随迁;提取器她首用时迁;本仓归位 loora,冻结线生效。

## 派工路由预案(SOP)

W1 / W3 偏差检查 / W4 为实现包:派工前跑 probe-channels.mjs,绿走外部通道(主力 Cursor grok 4.6 xhigh),每包按 BACKLOG 执行侧五步 + 交工格式。知识、教材、参考榨取、终审:Fable 亲手。批准后各波立卡进 BACKLOG,本文档转为规划依据不再更新进度。
