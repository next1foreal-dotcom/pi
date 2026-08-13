# vendor/genoffice — 对账表

来源: https://github.com/genspark-ai/genoffice
锚定提交: `dc4d7e5` (Sync snapshot 2026-08-12) · 许可: **Apache-2.0**(商标条款只限 GenOffice/Genspark 名号,不影响引擎代码使用)
采纳拍板: Fei 2026-08-13「a」(路线 A,见 `scratchpad/genoffice-for-her-eval.md`)

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

```
cd D:\@Her\genoffice   # clone 于 dc4d7e5,升级前先 git log 对账
npm install
# 三个入口文件内容见本目录首次引入 commit 中的 .tmp-*-entry.ts 记录,或按下列等价单行:
# docx-engine: export * from index + export { patchParagraphTexts } from text-patch
# extract:     export { docxToText, pptxToText, xlsxToText } (docx-engine 设 --external 后改指 ./docx-engine.mjs)
# fixtures:    export { buildDocxFixture, buildPptxFixture, buildXlsxFixture }
npx esbuild <entry> --bundle --format=esm --platform=node --target=node20 --banner:js="..." --outfile=...
```

注意: 写出后用 node 校验无 BOM(PowerShell `Set-Content -Encoding utf8` 会加 BOM,本仓血案惯犯)。

## 消费方

- `packages/her/src/tools/doc.ts` — `her_doc_read` / `her_doc_edit`
- `packages/her/test/doc-tools.test.ts`
