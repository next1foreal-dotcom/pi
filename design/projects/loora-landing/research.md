# loora landing — 研究(观察值,不是形容词)· step 2

2026-09-01 · 一源三行:数值(形)/一条法(法)/一条禁(禁)。全部 [measured] 自真站 CSS 或产品自身令牌。

## 0 · 产品自身材料(研究源 2,最高权重——项目即规格)

**loora 本体 [measured · `src/styles.css` + `knowledge/tools/motion.md` @ f0c62aa]**

- 形:studio(默认主题)石墨族 — `--bg #393d3c` 面板 `#414544` 内嵌 `#4a4e4d` 悬浮 `#545857` 线 `#575c5a`;文三段 `#e5e6e6/#b4b7b6/#8b8f8d`;**无彩 accent `#dfe2e1`**(fg `#2b2f2e`);radius `5/7/10/pill`;字体 Inter var + mono,工具面字阶 11/12/13px;`--ease cubic-bezier(0.2, 0, 0, 1)`、`--dur 120ms`、`--dur-2 190ms`;知识库 motion 档另有 160ms ease-out;reduced-motion 全局降级规则已存在。noir 主题石灰 `#aeb731`、paper 蓝 `#3567c6` 是切换皮肤,不是默认外衣。
- 法:产品自己就是被盯几小时的深色工具面——页面从这套令牌出,不另造一套色。
- 禁:把 noir 石灰 / paper 蓝当页面默认 accent(它们是可切换主题的口音);页面正文引用产品工具面的 11/12/13px 字阶(那是工具密度,不是页面密度)。

**loora 本体事实(README 原文,页面文案的事实边界)**

- local vector design tool + AI agent 同一画布;agent 产出 = 真节点,不是图。
- Runs entirely on your machine. No account, no server, no telemetry。
- 无限画布、点阵、平移(space+拖/中键)、缩放(ctrl+滚轮);工具 V/F/R/O/L/P/T;智能吸附(alt 绕开)。
- 图层树(改名/排序/嵌套/隐藏/锁定;frame 裁剪);属性 X/Y/W/H、旋转、圆角、透明度、模糊、纯色/渐变描边、阴影;文字 family/size/weight/行高/字距/对齐。
- 自动保存 localStorage;存/开 `.brilliant.json`;导出 SVG/PNG(2×)。
- AI:自带 Anthropic key(BYOK),密钥存浏览器 localStorage,页面直连 api.anthropic.com;流式文本+推理;**每次工具调用可见**。

## 1 · linear.app [measured · 10 CSS 文件,2026-09-01]

- 形:动效双档——交互档 **160/180/200/220ms**(`--duration: .18s`),装饰档 **1600/2800/3200ms `steps(1,end)` ×150**(全部服务于 grid-dot 动画);字距 12/13/14/16/40px;黑 = 单位数 alpha(#00000014/#0000000a…);radius 5/6/8/10/14;断点 640/768/856/1024/1280;**prefers-reduced-motion 存在**;`--anim-amount: 48px`。
- 法:装饰动效让路——长步动画全数堆在「网格点演示」这一处,正文与控件零装饰动画;深底上唯一的光是产品帧本身。
- 禁:它的品牌紫;它的 grid-dot 模式照搬 = 复制粘贴(我的网格点属于我的画布时刻,不是它的 pong)。

## 2 · tldraw.com [measured · 2026-09-01,同物种:画布+agent]

- 形:交互动效 **80–200ms**(`--tlui-cmt-marker-transition: 80ms ease`);`cubic-bezier(.785,.135,.15,.86)`;面 `#f9fafb` 文 `#1c1c1c/#2e2e2e/#6e7477` 选中 `#3182ed`(selection fill `#1f8fff3d`);字号 10/11/12/13/14/16/21/28;全令牌 `--tl-*`;**reduced-motion 存在**。
- 法:同桌画布产品把「协作/光标出现」这类状态变化钉在 **80ms 微过渡**——agent 状态的可见性用最轻的动效标记,不值一帧动画。
- 禁:它的蓝 `#3182ed`(品牌色);它的主题令牌体系(我产品有自己的三主题)。

## 3 · excalidraw.com [measured · 2026-09-01,同物种:无限画布]

- 动:交互 **100–200ms**,模态/浮层 **500/1000ms** scaleIn;`cubic-bezier(.2,.8,.3,1)`、`cubic-bezier(.3,1,.6,1)`;448 色值中 #fff/#121212 主导;**reduced-motion 存在**。
- 法:无限画布产品把动效几乎全留在 UI 状态上,**画布本体静默**——「画布是活的」用一次真实事件表达,不靠常动。
- 禁:手绘字体 Excalifont;品牌紫 `#4440bf`;它的浮岛阴影风格。

## 4 · 家库 positive-samples 引用(免重抓,与本主题相关的条目)

- 条目 3 vercel:六字号+单色 alpha 发丝线——印证限量(计数即设计)。
- 条目 1 rico:四字号/三灰/40px 行距——信任条与语法表用「行语法」,不用三卡。
- 条目 4 Timestate:一个承诺过的色板 6 枚——印证「承诺过的 palette 才算 stance」;本页 stance = 产品 studio 无彩族 + 单一确认档。
- 条目 5 YORK:一句大字形静默全场,其余小字同意耳语——首屏焦点句用这个结构。
- 条目 6 Lightspark:最大的论据是「东西本身在跑」——画布时刻必须是真产品行为(首稿用产品自身的录制/实帧语法,不是在页面里画一个假画布)。

## 够不够(完成度测试)

可以写出三条方向句而**不发明任何数值**:地面 #393d3c 族(产品 token);动效 120/190ms + cubic-bezier(0.2,0,0,1) 交互档(产品 token)、80ms 状态微动(tldraw 实测档,标注)、长步 1600–3200ms 参照值(linear 实测,标注为参照、首稿再用自家相机行为实测复核);文件位 5/7/10(产品)。够。停止研究,进方向。
