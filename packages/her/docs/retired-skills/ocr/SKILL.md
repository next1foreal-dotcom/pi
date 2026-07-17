<!-- 已器官化为 her_ocr 工具（G-53）。本文仅作行为规格存档，不再作为 skill 加载。 -->

---
name: ocr
description: 从图片或扫描版 PDF 中提取文字(中英文 OCR)。触发:"这图里的字弄出来"、"OCR 一下"、"扫描件要文字"、"识别图片里的字"。
---

# ocr — 图片/扫描件取字

## 定位工具

1. `where.exe tesseract` 试 PATH
2. 找不到试已知路径:`C:\Program Files\Tesseract-OCR\tesseract.exe`
3. 都找不到 → 回报"tesseract 未安装",给出 `winget install --id UB-Mannheim.TesseractOCR`,不要跳过

扫描版 PDF 需要先转图,额外用 magick 或 gswin64c(路径与 winget 命令见 convert skill),同样先 `where.exe` 确认。

## tessdata 目录(重要,2026-07-17 定)

本机语言包在 **`%LOCALAPPDATA%\tessdata`**(含 chi_sim+eng+osd),不在默认的 Program Files(写不进,权限拦)。**所有 tesseract 命令一律带** `--tessdata-dir "%LOCALAPPDATA%\tessdata"`。

## 语言包检查(每次先做)

跑 `tesseract --list-langs --tessdata-dir "%LOCALAPPDATA%\tessdata"`,确认输出里有 `chi_sim`(简体中文)。
- 没有 → 从 https://github.com/tesseract-ocr/tessdata_fast 下载 `chi_sim.traineddata`,放进 `%LOCALAPPDATA%\tessdata\`,再重新 `--list-langs` 确认装上了
- 竖排中文用 `chi_sim_vert`(同一仓库有该文件),没有也按上面方式补

## 图片直接 OCR

```
tesseract <img> <out前缀,不带扩展名> -l chi_sim+eng --tessdata-dir "%LOCALAPPDATA%\tessdata"
```
输出 `<out前缀>.txt`。中英混排用 `chi_sim+eng`,确定纯英文用 `eng` 更快更准。

## 扫描版 PDF(先转图再逐页 OCR)

1. 转图,300dpi 保证清晰度:
   ```
   magick -density 300 in.pdf page-%03d.png
   ```
   magick 不可用时退回 `gswin64c -sDEVICE=png16m -r300 -o page-%03d.png in.pdf`
2. 逐页跑 tesseract:`tesseract page-001.png page-001 -l chi_sim+eng --tessdata-dir "%LOCALAPPDATA%\tessdata"`(每页一个 txt)
3. 按页码顺序拼接所有 `.txt` 到一个输出文件,清理中间生成的 png/txt

## 结果核验

- 打开生成的 txt,确认不是空文件、没有大段乱码(乱码通常是语言包选错,或图片分辨率太低)
- 分辨率不够(扫描件模糊)时用更高 density(400+)重新转图再试一次,不要直接对糊图跑 OCR

## 如实告知的局限

Tesseract 中文识别质量及格但不惊艳,版面复杂(表格、多栏、艺术字)或手写体效果差。重要文档(合同、证件)OCR 完必须提醒用户人工校对,不要替用户下"识别准确"的结论。
