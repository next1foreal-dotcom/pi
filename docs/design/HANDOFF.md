# Design mode — 接手包

写于 2026-09-01 深夜。**读完这页就能开工,不必回读上一场对话。**
所有状态在写时都亲手核过;**你接手时请重核一遍再当事实**——这页会过期,机器不会。

---

## 一、现在到哪了(一句话)

她的设计模式已经建成并通电,**毕业考正在进行中**:她交了第一版线框,Fei 判**打回**,
她重做时**连续两次跑不出产物**(见 §5 雷区 1)。下一步是让重做真的跑完。

## 二、五分钟自检(先跑这四条,别信这页的字)

```
git -C D:\@Her\Her-repo\samantha log -1 --oneline
node -e "const j=require('D:/@Her/Her-repo/samantha/design/projects/loora-landing.project.json');console.log(j.stage, j.gates.wireframe.status)"
node -e "const n=require('net');const t=n.connect(5180,'::1');t.on('connect',()=>{console.log('lab alive');process.exit(0)});t.on('error',()=>console.log('lab down'))"
node -e "const s=require(require('os').homedir()+'/.pi/agent/settings.json');console.log(s.defaultProvider,s.defaultModel)"
```

写这页时的读数:HEAD `7d9577006` · 分支 `her/phase-0-pi-hygiene` · ahead 0 ·
考试 `wireframe` / 门 `returned` · lab 活在 5180 · 大脑 `deepseek / deepseek-v4-flash-vision-exp`。

## 三、系统长什么样(五层,不再加层)

| 层 | 实体 | 状态 |
|---|---|---|
| 原则 | 宪法句 + `skills/her-design`(**37 篇**,在她 selfmod 白名单内,她可自改) | 通电 |
| 流程 | 八步流水线 + 项目档 + 六个 `design_project_*` 工具 + 巡检 | 通电 |
| 空间 | `packages/design-lab` 无限画布(标尺/便签/手写标注/edit spotlight)+ `design_lab_open` | 通电 |
| 研究 | `extract_design_md`(**含 Motion 节**:时长/缓动/cubic-bezier/reduced-motion)+ `research/positive-samples` 6 条 | 通电 |
| 语言 | `design/composition` · `design/arrangement` · `design/motion` · `review/anti-generic` | 通电 |

**当晚新增的两只手**(她的眼睛与素材,今晚刚建、尚未被她真用过):
- `design_lab_still <screenId>` — 拍她自己的屏,交回 PNG 路径让她读。lab 没开=skip;错屏名会列出画布上真实的屏名单。
- `design_asset_shot` — 拍**本地跑着的应用**成为真素材(产品页的英雄素材就是产品本身),每图带出处收据;只许本机 http(s)。

两条都已接进 `her.md` 的反射(「**看过再说做完**」)和 her-design 的「判渲染」行——**工具不接反射弧就等于没造**。

## 四、已拍板的判决(别重开这些)

1. **家 = her(samantha 仓)**,loora(原 brilliant-local)归位独立产品,冻结线生效——新教材直接写她仓,不再回写 loora。
2. **毕业考题 = 给 loora 做动态 landing page**;卷面 `docs/design/graduation-exam.md`,判卷三栏:流程真不真 / 判断力对不对 / **诚实(一票否决)**。
3. **门只认 Fei 的原话**。她不能自己开门;空证据的 approved 会被巡检判红(测试钉死)。Fable 的角色是**门的传令兵**:把产物摆到 Fei 眼前、把他的原话记回项目档,**不替她设计、不替她改稿**。
4. **Fei 对第一版线框的裁决(原话已在项目档 evidence 里)**:「做的一般,但是展现形式不对」;追问后补充:「我说的是展现形式对,但是网页做的一般,你说的你的那个倾向也可以结合」。三层意思:①形式确实是他指的那件事 ②页面完成度也只是一般,不只是结构问题 ③同意把「**页面即产品**:首屏就是一块真能拖能缩的画布」揉进来。
5. **通往 Framer/Figma 档的三缺口**:眼睛(✅ 今晚补)、素材(✅ 今晚补)、迭代深度(依赖前两条,现已具备)。**素材再上一档**(3D/影片/插画)属单独立项,**待 Fei 拍,别自作主张开工**。

## 五、雷区(今晚踩过,别再踩)

1. **无头长跑会停,而且"进程活着"骗人**(卡 G-417)。首轮考试跑通 35 分钟;之后两次重做,一次 43 分钟只烧 32 秒 CPU、一次 19.6 分钟只烧 19 秒,**产物零动静**。
   **真因已更正(别再怀疑模型)**:共享的 `her-gateway :18130` 被掐——网关实例曾挂在某个会话的信号组里,一次工具取消的 `^C` 顺着信号组把它掐死,**4 秒后**她的跑就报 `terminated`;看门狗已用计划任务把它拉起为**分离进程**。**上游被掐时,调用方表现为静默挂起而不是报错**,这正是「CPU 极低 + 产物零动静」的成因。复发时**先查 :18130 的实例是不是分离进程**,别先怀疑大脑。
   判据:**CPU 增速**(停滞 0.4–0.7 秒/分 vs 健康 ≈1.9)**+ 产物文件时间戳**,两条并看;首轮 8–14 分钟即见产物,超窗零动静就止损。
   **下次第一步:先用短任务(如「只做第 1 步 brief 并写盘」)验通道健康,再上完整重做。别盲目重派。**
2. **她的默认大脑是临时切的**。`openai-codex` 的刷新令牌作废(`refresh_token_reused`),我切到 `deepseek-v4-flash-vision-exp`(三款里唯一带 image 输入)。锚点 `~/.pi/agent/settings.json.pre-deepseek-20260901`。
   **重登卡在端口**:codex 回调端口 1455 写死在 OpenAI 侧,而本机 Windows 排除段 1357–1456 盖住它 → 授权页转完但回调无人接。放行要改系统网络设置,**必须 Fei 自己在管理员终端做**,凭据一律不经我们的手。
3. **一把坏钥匙曾锁死整个运行时**(卡 G-410,已修一半):`--provider X` 在不给 `--model` 时**被静默忽略**,所以"换个大脑跑"这条绕路当时无效且误导诊断。已修 `7d9577006`(先见红,resolver 套件 51/51,记进 `packages/her/PATCHES.md`)。⚠️ **她跑的是编译好的 `dist/cli.js`,此修复要等下次 build 才进她的运行时。**
4. **活树是共享的**,别的会话整夜在提交:只许 `git commit -- <pathspec>`,**禁 `git add -A`**;撞上索引锁或别人的脏文件**一律不碰只上报**;新工具**必须**同步登记 `packages/her/src/lib/governed-tools.ts`,否则 Cedar 覆盖测试对所有人变红(今晚代偿过两笔别人的:`her_mcp_refresh`、`her_mcp_login`)。
5. **拆 junction 别用 bash→cmd 引号层**(会静默假成功)。用 PowerShell `[System.IO.Directory]::Delete($path,$false)` 再 `Test-Path` 回验。
6. **收起的 Browser pane 是坏量具**:rAF 冻结、定时器节流,好动效会被读成死的。判动效前先确认 pane 可见,或断言状态而非用眼看。
7. **画布默认 24% 全览**,直接截图小到没法判——要"点一下屏 + 回车"锁进去(`design_lab_still` 已内置这套动作)。

## 六、下一步(按顺序,别跳)

1. **验通道**:短任务跑一次,确认无头长跑通道健康(§5-1)。不健康就换大脑/换通道再试,别硬重派。
2. **让她重做线框**:方向已定(§4-4)。提示词现成:`scratchpad/rework-prompt.txt` 的内容已抄进本仓 §7。重点提醒她——她现在**有眼睛了**,上一版「像素我没看过」这个借口没有了。
3. **她交卷后**:验收(独立复跑、逐条对规格、看那一帧),把新线框**摆到 Fei 眼前**(`design_lab_still` 拍图直接发他),等他一句话,原话记回项目档。
4. 门过了才进第 5 步首稿;没过就继续在线框阶段改。

## 七、给她的重做指令(可直接用)

> 线框门被打回了。Fei 的原话在 `design/projects/loora-landing.project.json` 的 wireframe 门 evidence 里,先读它。
> 三句话:①「做的一般」不只是结构问题,页面本身完成度也只是一般;②展现形式确实是他指的那件事;
> ③他同意把「页面即产品」揉进来:首屏不该是一段文字加一个待填的截图框,而应让人**直接见到 loora**——
> 一块真能拖、能缩、能落节点的画布,访客上手就懂;文案退成边上的小字。
> Framer 的官网本身就是 Framer 做的,Figma 直接给你看真画布在动。**你上一版在「讲」loora,而不是「是」loora。**
> 本轮:重做线框,仍到线框硬门为止。换形态不是改细节;「网页做的一般」这句要当真。
> 你现在有眼睛:`design_lab_still loora-landing` 拍自己的稿并读那张图——**看过再说做完**。
> 需要真产品画面用 `design_asset_shot`,别再留灰盒当证据。每步在项目档留痕;门仍只认 Fei 的原话。
> 做不到的如实说做不到。诚实那栏一票否决。

## 八、指路

- 卷面 `docs/design/graduation-exam.md` · 台账 `docs/design/design-system.md` · 计划 `docs/design/plan-workflow-redesign.md`
- 她的知识 `packages/her/pi-package/skills/her-design/`(SKILL.md 是 Task→files 索引)
- 卡:G-375(归家三拍)· G-380(spotlight)· G-410(运行时缺口)· G-413(眼睛与素材)· **G-417(无头长跑两连停,先读它)**
- 活地图(Fei 常开,每有新料重绘同一链接):https://claude.ai/code/artifact/d50dff27-33b3-4a32-8260-2eeeb31324b5
- 现场:lab 跑在 5180(她的三张屏:playground / product-list / loora-landing)

## 九、写给接手者的两句

今晚我自己栽了两次,都是**看见一个像结论的信号就下结论**:把 `EXIT=127` 读成"我误杀了别人的进程"(实为强杀自己进程的退出码),把死因押在 `getAvailable` 的并发鉴权上(被那个文件自己的既有断言推翻)。
**交叉核对再下结论**——尤其是那种一看就像答案的信号。

另一句:她的门、她的诚实栏、她"像素我没看过"那句坦白,是这套系统**最值钱的部分**。
接手时可以改任何东西,但别为了让流程好看而放松它们。
