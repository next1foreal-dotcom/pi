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
考试 `wireframe` / 门 `returned` · lab 活在 5180 · 大脑 **写这页时**是 `deepseek / deepseek-v4-flash-vision-exp`,
**9/1 深夜已被改成 `her-gateway / xai/grok-4.6`** —— 所以第四条自检命令务必自己跑,别抄这行。

## 三、系统长什么样(五层,不再加层)

| 层 | 实体 | 状态 |
|---|---|---|
| 原则 | 宪法句 + `skills/her-design`(**37 篇**,在她 selfmod 白名单内,她可自改) | 通电 |
| 流程 | 八步流水线 + 项目档 + 六个 `design_project_*` 工具 + 巡检 | 通电 |
| 空间 | `packages/design-lab` 无限画布(标尺/便签/手写标注/edit spotlight)+ `design_lab_open` | 通电 |
| 研究 | `extract_design_md`(**含 Motion 节**:时长/缓动/cubic-bezier/reduced-motion)+ `research/positive-samples` 6 条 | 通电 |
| 语言 | `design/composition` · `design/arrangement` · `design/motion` · `review/anti-generic` | 通电 |

**当晚新增的两只手**(她的眼睛与素材;**眼睛已在新大脑上验通** —— 接手会话交叉核过:她描述实拍图里有「Esc to exit / Reset layout」,这两个词 grep 她的 `screen.tsx` 命中 0、只存在于 design-lab 外壳,**只有真读了 PNG 才知道**,不是从源码倒推):
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
   **归因经两轮更正,最终版**:不是模型的问题。**根机制 = git-bash 的 `timeout` 到点时会往控制台组喷 `^C`,把同组里的东西连坐掐死。** 实证:另一会话用 `Start-Process cmd /c start-gateway.bat` 手起的网关(没脱离工具会话控制台组),被一个 `timeout 180` 探针到点掐死,4 秒后走网关的跑即报 `terminated`。
   ⚠️ **我那两次是 deepseek 直连、不经网关,不是同一个受害者。** 我一度高度怀疑是自己的 git-bash `timeout` 探针连坐了自己的派工——**做了对照实验,证否**:起一个每 400ms 写心跳的后台 node,先证明心跳在跳(7→12,正向证据),再在另一次 Bash 调用里跑 `timeout 2 sleep 30`(退出码 124 = 真到点开火),心跳继续(77→89);换 `timeout 2 node -e ...` 再试一次,仍然继续(177→190)。**结论:本 harness 的后台任务与后续 Bash 调用不共享控制台组,git-bash `timeout` 喷不到它。我那两次的凶手另有其人,至今未知。**
   (⚠️ 第一版实验我自己写坏了:两次读数**都是空的**,脚本拿"空等于空"判成"被掐死"——差点得出相反结论。**量具必须先证明自己在动**,否定式结论必须有正向证据。)
   **纪律(照做,别复现)**:①派工一律**分离进程**起(`.bat` + 嵌套 `cmd /c start "" /min`),别让它和工具会话同组;②**派工在飞期间不要用 git-bash 的 `timeout`** 做探针,改用 PowerShell 或 `sleep`+轮询;③复发时先查上游实例是不是分离进程,别先怀疑大脑。
   判据:**CPU 增速**(停滞 0.4–0.7 秒/分 vs 健康 ≈1.9)**+ 产物文件时间戳**,两条并看;首轮 8–14 分钟即见产物,超窗零动静就止损。
   **下次第一步:先用短任务(如「只做第 1 步 brief 并写盘」)验通道健康,再上完整重做。别盲目重派。**
2. **她的默认大脑被换过两次,自检里必须自己读**。`openai-codex` 的刷新令牌作废(`refresh_token_reused`)→ 我临时切 `deepseek-v4-flash-vision-exp`(锚点 `~/.pi/agent/settings.json.pre-deepseek-20260901`)→ **9/1 深夜又被切成 `her-gateway / xai/grok-4.6`**。
   ⚠️ 切到 her-gateway 当时是**断的**:`models.json` 里该 provider 的 apiKey 写作 `$HER_GATEWAY_LOCAL_KEY`,而该环境变量哪儿都没定义 → 不带旗启动会**悄悄回落 anthropic**、撞过期 token、30 秒锁死运行时(**G-406/G-410 那条"一把坏钥匙锁死整机"的复发**)。占位值已经 Fei 拍板落进 `.env`。**换大脑后务必先跑一次 ALIVE 探针再派活。**
   **重登卡在端口**:codex 回调端口 1455 写死在 OpenAI 侧,而本机 Windows 排除段 1357–1456 盖住它 → 授权页转完但回调无人接。放行要改系统网络设置,**必须 Fei 自己在管理员终端做**,凭据一律不经我们的手。
3. **一把坏钥匙曾锁死整个运行时**(卡 G-410,已修一半):`--provider X` 在不给 `--model` 时**被静默忽略**,所以"换个大脑跑"这条绕路当时无效且误导诊断。已修 `7d9577006`(先见红,resolver 套件 51/51,记进 `packages/her/PATCHES.md`)。⚠️ **她跑的是编译好的 `dist/cli.js`,此修复要等下次 build 才进她的运行时。**
4. **活树是共享的**,别的会话整夜在提交:只许 `git commit -- <pathspec>`,**禁 `git add -A`**;撞上索引锁或别人的脏文件**一律不碰只上报**;新工具**必须**同步登记 `packages/her/src/lib/governed-tools.ts`,否则 Cedar 覆盖测试对所有人变红(今晚代偿过两笔别人的:`her_mcp_refresh`、`her_mcp_login`)。
5. **改共享文件前先 `git status -- <文件>`**。`git commit -- <pathspec>` 提交的是**工作树内容**,会把别人**尚未提交**的改动一起带走。9/1 我就这么把接手会话正在写的 5 行 BACKLOG 扫进了自己的提交(内容没丢,但那笔提交里有别人的字)。看见 `M` 就别提交那个文件,改用消息告诉对方让他自己收。
6. **拆 junction 别用 bash→cmd 引号层**(会静默假成功)。用 PowerShell `[System.IO.Directory]::Delete($path,$false)` 再 `Test-Path` 回验。
7. **收起的 Browser pane 是坏量具**:rAF 冻结、定时器节流,好动效会被读成死的。判动效前先确认 pane 可见,或断言状态而非用眼看。
8. **画布默认 24% 全览**,直接截图小到没法判——要"点一下屏 + 回车"锁进去(`design_lab_still` 已内置这套动作)。

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

## 十、9/2 接手记录(01:30 本地,Fable 会话 9ab7753b)——G-417 真相 + 第六轮结果

**先说结论:三次「重做跑不完」是三个不同的死因,只有第三个被证死。**

| 轮 | 时间(本地) | 死法 | 死因 | 证据 |
|---|---|---|---|---|
| 第四轮 | 13:08→13:21 | `terminated` | 网关被别的会话的 ^C 掐死(§5-1 已记) | 看门狗日志 ^C 行 |
| 第五轮 | 13:32→13:58 | `Stream ended without finish_reason` | **未查明**(网关当时健康且已分离) | 会话 JSONL 末条 |
| 第六轮 | 15:28→16:12 | `unauthenticated:bad-credentials / The OAuth2 access token could not be validated` | **网关的 xAI OAuth 令牌到点过期,且没人续** | 见下 |

**第六轮的证据链(每条都亲手读的)**:
- `~/.her-gateway/auth.json` 里 `xai.accounts[0].credential.expires = 2026-09-01T20:08:33Z`。
- 我的跑(会话 01a05e71)死于 20:12:04Z;**另一个会话 15:34 起的同一份重做**(会话 01a05e77,他们的提示词更长)死于 20:11:59Z——**同一秒、同一错**。过期后三分半。
- 9 小时后(9/2 05:24Z)令牌**仍是过期状态**:没有任何东西刷它。
- 代码原因:`services/her-gateway/src/account-rotation.ts` 的 `resolveRoutableAsync` 只在活跃账号 **cooling** 时才走 `pickAlternate`,而 `pickAlternate` 明确 `excludeId = 活跃账号`——**刷新只给「兄弟账号」,单账号 provider 的活跃令牌永远没人续**。没有后台刷新器(全仓 grep 无 setInterval 刷新)。
- 修好它的现成路径:`GET http://127.0.0.1:18130/api/oauth/status?provider=xai` 走 `getOAuthProviderStatus`,它对过期凭据**自愈**(拿 refresh token 续)。我 05:26Z 调了一次:`state=connected`,新到期 **2026-09-02T11:24:32Z(07:24 本地)**。令牌寿命约 6 小时。
- **推论(与三轮都对得上)**:不是「长跑会死」,是「**跨过失效时刻的跑会死**」。首轮 35 分钟成、体检 2 分钟成、第六轮 43 分钟死,差别只是有没有撞上那一秒。长效修法=请求路径上活跃账号过期就刷(一处分支)或起一个定时自愈调用;**待 Fei 拍,我没改网关代码**。

**第六轮不是白跑——她交出了「页面即产品」**:`screen.tsx` 17KB→1.8KB,新 `canvas.tsx` 345 行 = 真能平移/滚轮缩放/拖节点/四角柄改尺寸/点空白落矩形的活画布;HUD 退成边缘小字;砍了底栏英雄句。`npx tsc --noEmit` exit 0。她用 `design_lab_still` 自看了 4 次。她最后一句:「虚线文字框太宽、空着一大截——这是现在最像没做完的地方」,死在修它的路上。**门未动**(wireframe 仍 returned,那是对的,她不能自己开)。
- ⚠️ 两个写手:她在 16:02 自己发现另一会话在写同批文件,用 `her_session_send` 发了两封协调信(G-367 名册机制在野外真响了)。磁盘上是两个写手交替写出来的,但读起来是一份连贯的稿。
- ⚠️ 她两张 still(top/bottom)**字节相同**(sha256 632221940b12…),`design_lab_still` 的分片可能有 bug,待查。

**这轮顺手修的三件事**:
1. Studio 4800 重启后假死(Turbopack 缓存中毒第四例):按安全序清(摘 playwright junction→删 .next\dev→760 包 0 断)→冷 79s→热 87–114ms。**看门狗救不了这一类**:它第一道闸是「端口还在听就不重起」,连报 18 次 `probe dead but LISTENING`。
2. lab 5180 重启后没人拉,按 design_lab_open 同款 .bat 分离拉起。
3. `her-memory/.her/checkpoints/d---Her-Her-repo-samantha.git/index.lock` 从 07:56 起卡着(0 字节、早于重启、无进程持有),她全天的 checkpoint 捕获都在 skip——已删。**更深一层:那个 checkpoint 仓从来没有过一个 commit**(`git log` 报 branch 无提交),这条机制从没真跑通过,待立卡。

**两条新雷(别再踩)**:
- **分离派工的 PATH 坑**:`cmd start` 起的 `bash.exe` 是非登录 shell,`/usr/bin` 不在 PATH,`cat`/`date` 全失踪 → `-p "$(cat prompt)"` 展开成空串 → pi 秒退 **EXIT=0** 冒充成功。正向证据是 meta 里 `START=` 后面是空的。修法:脚本开头 `export PATH="/usr/bin:/mingw64/bin:$PATH"`。
- **CPU 增速是错的尺子**(推翻 §5-1 的判据):她大部分时间阻塞在模型上,健康跑也只烧 0.3–0.6 秒/分——我的监控对着一个正在真干活的 43 分钟跑连报 11 次 STALL?。**真的活性信号是会话 JSONL 的增长**(45 秒 +11.9KB)+ 产物时间戳。CPU 只当旁证。

**下一步**:①令牌活着(到 07:24)且没别的写手时,派短收尾包(只修她点名那一项 + 收口 notes,不重做);②她交卷后 `design_lab_still` 拍图摆到 Fei 眼前,原话记回项目档;③网关刷新缺口 + checkpoint 仓零提交 + still 分片同字节,三张卡待 Fei 拍。


## 十一、9/2 上午接手记录(Fable 会话 9ab7753b)——门开了,顺序是 tsc → commit → step 5

- **网关根因措辞(9/2 09:35 邻座核证后修正)**:不是「单账号 provider 永不刷新」,是**请求路径从不刷新活跃账号**(多账号同理),刷新只在 `getOAuthProviderStatus` 与 `pickAlternate` 的兄弟账号分支;修 `f12b832`(活跃账号同待遇 + 60s 余量 + 每 provider 单飞刷新),**进程重启后才生效**。
- **finish6(02:04–02:14)零改动**:第二种死法——pi-automode 快分类器 `deepseek/deepseek-v4-pro` 十分钟 503 `Server Overloaded`,fail-closed 拦了全部非只读工具(33 block / 34 allow)。她如实报「卡住了」。
- **finish7(08:44–08:55)跑通**:n-text `w 168→112`、`wireframe-notes.md` 收口节、project.json 一条 iteration。Fable 亲用 Playwright 重拍 5180 看图核过。
- **门:Fei 09:05 判「过,进 step 5 皮肤」**(选项原文),已经 `recordGateVerdict` 写进 `loora-landing.project.json`(wireframe → approved,evidence 带出处)。stage 仍 wireframe,进 step 5 时由她 `setStage`。
- **进 step 5 前的唯一欠账**:design-lab `npx tsc -b tsconfig.app.json --noEmit` 退出码 1(`canvas.tsx:197/:200`,`dataset.node` 未收窄,9/1 遗留;当时自检 `| head -5` 吞了退出码)。已派她五分钟微包 `tscfix`,Fable 验收后按 pathspec commit 整个线框写集(目前全部 untracked;外部 tar 快照在会话 scratchpad)。
- **派前四项预检(每次都做)**:xAI 令牌余量(`GET :18130/api/oauth/status?provider=xai` 顺手刷新)· deepseek 真实最小调用 200 · samantha 目录无任何 `-p` pi 进程(同目录启动锁,邻座只读探针也算)· 写集 mtime 未动。判活看会话 JSONL 增长,不看 CPU。
- **别把日志关键字数当重试数**:automode 日志的 `recentDenials` 会重复计入,finish6 实际拍照 12 次、调用 71 次,不是 grep 出来的两百多。
- **协调纸条**:`design/probe/DISPATCH-NOTICE.md`(两会话来回追记,先读它再派 loora-landing 的写任务)。
