# vendor/genoffice — 对账表

来源: https://github.com/genspark-ai/genoffice
锚定提交: 机器真相在 `upstream-pin.json`(首次引入 = `dc4d7e5`,Sync snapshot 2026-08-12)· 许可: **Apache-2.0**(商标条款只限 GenOffice/Genspark 名号,不影响引擎代码使用)
采纳拍板: Fei 2026-08-13「a」(路线 A,见 `scratchpad/genoffice-for-her-eval.md`);刷新脚本 Fei 同日「装」

## 偷了什么

| 文件 | 上游源 | 形态 |
|---|---|---|
| `docx-engine.mjs` | `packages/docx-engine/src/index.ts` + `text-patch.ts` 的 `patchParagraphTexts` | esbuild 单文件 ESM bundle |
| `extract.mjs` | `packages/file-parse/src/{docx,pptx,xlsx}.ts` | 同上;`@genoffice/docx-engine` 设 external 指向旁边的 `docx-engine.mjs`(不重复内联) |
| `fixtures.mjs` | `packages/file-parse/tests/helpers/fixtures.ts` 三个 builder | 同上;**只供 Her 自己的测试用** |
| `*.d.mts` | 手写 | 只声明 Her 消费的最小 API 面 |

## 为什么打 bundle 而不是抄源码

1. **零新增 npm 依赖**: jszip / fast-xml-parser / utif2 全部内联,samantha 的 package.json 与 lockfile 一字不动(pinned-deps / shrinkwrap / install-lock 门禁零接触)。
2. **门禁零碰撞**: biome 只查 `packages/*/src|test`,tsgo 只跟 import 链——`.mjs` + 手写 `.d.mts` 让 vendored 代码不进 lint/typecheck 面,上游风格差异不污染仓门禁。
3. bundle 是锚定提交的确定性产物,可随时重建对账。

## 故意不偷

- `file-parse` 的 pdf 路(拖 `pdfjs-dist` ~6MB;PDF 归 `her_pdf`/`her_ocr` 既有器官)
- `agent-core` / `ai-provider` / `ai-search`(她已有 pi;Genspark 账号体系不用)
- sheets Rust sidecar(xlsx 全功能编辑需 cargo 原生编译;读侧 `extract.mjs` 已覆盖)

## 重建方法(上游升级时)

一条命令(在 samantha 仓根跑):

```
node packages/her/vendor/genoffice/refresh.mjs
```

它做的事:上游克隆(默认 `D:\@Her\genoffice`,`GENOFFICE_UPSTREAM` 或 `--upstream` 覆盖)`git pull --ff-only` → 用上游自己的 esbuild 重打三个 bundle(入口内容固化在脚本里)→ extract 重指 `./docx-engine.mjs` → BOM/banner 校验 → 更新 `upstream-pin.json` → 跑 `doc-tools.test.ts` 回归闸。`--no-pull` 只重打当前克隆;`--no-test` 跳过测试(别在要 commit 的时候跳)。绿了之后照常 `git status` → commit(过全套 pre-commit 门禁)。

注意: 一切写文件走 node,禁 PowerShell 重定向(`Set-Content -Encoding utf8` 会加 BOM,本仓血案惯犯);同一上游提交重跑应产出字节相同的 bundle(banner 只含 commit 短哈希,无时间戳),`git status` 不动即为无操作验证。

## 消费方

- `packages/her/src/tools/doc.ts` — `her_doc_read` / `her_doc_edit`
- `packages/her/test/doc-tools.test.ts`
