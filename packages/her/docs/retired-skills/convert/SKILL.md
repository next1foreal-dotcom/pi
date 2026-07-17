<!-- 已器官化为 her_convert 工具（G-53）。本文仅作行为规格存档，不再作为 skill 加载。 -->

---
name: convert
description: 万能文件格式转换路由:文档(md/html/epub/docx/rst/latex)互转、Office 转 PDF、音视频转码、图片格式转换。触发:"把 X 转成 Y"、"转个格式"、"导出成 pdf/mp4/png"等任何跨格式转换需求。
---

# convert — 文件格式转换路由

## 定位工具

本机 Windows 11,工具经 winget 装,可能不在 PATH。用任何工具前先确认:
1. `where.exe <cmd>` 试 PATH
2. 找不到按已知路径试(见下)
3. 都找不到 → 直接回报"<工具> 未安装",给出对应 winget 命令,不要跳过或假装转换成功

已知路径(2026-07-17 逐个验证过):
- ffmpeg 已在 PATH:`C:\ffmpeg-2025-10-09-git-469aad3897-full_build\bin\ffmpeg.exe`
- soffice:`C:\Program Files\LibreOffice\program\soffice.exe`
- pandoc 3.10:`%LOCALAPPDATA%\Microsoft\WinGet\Packages\JohnMacFarlane.Pandoc_Microsoft.Winget.Source_8wekyb3d8bbwe\pandoc-*\pandoc.exe`(版本升级目录名会变,按 pandoc-* 通配找)
- magick 7.1.2:`C:\Program Files\ImageMagick-*\magick.exe`(同理通配)
- magick 传字体等 Windows 路径时用正斜杠(`C:/Windows/Fonts/msyh.ttc`),反斜杠会被它吃掉

未安装时的 winget 命令:
- pandoc:`winget install --id JohnMacFarlane.Pandoc`
- magick(ImageMagick):`winget install --id ImageMagick.ImageMagick`
- soffice(LibreOffice):`winget install --id TheDocumentFoundation.LibreOffice`

## 路由表

按源→目标格式选工具,不要混用:

| 场景 | 工具 | 命令 |
|---|---|---|
| 文档互转(md/html/epub/docx/rst/latex) | pandoc | `pandoc in.md -o out.docx` |
| docx/xlsx/pptx → pdf | soffice | `soffice --headless --convert-to pdf --outdir <dir> <file>` |
| 旧 Office(doc/ppt/xls)→ 新格式 | soffice | 同上,`--convert-to docx` 等 |
| 音视频转码/剪切/抽取 | ffmpeg | 见下 |
| 图片格式互转 | magick | `magick in.png out.webp` |

### ffmpeg 常用配方
- 通用转 mp4:`ffmpeg -i in.mov -c:v libx264 -c:a aac out.mp4`
- 抽音频:`ffmpeg -i in.mp4 -vn -c:a copy out.m4a`(容器不兼容时改 `-c:a aac out.aac`)
- 转 gif(保画质,两步走,别直接一步转会糊):
  1. `ffmpeg -i in.mp4 -vf "fps=15,scale=480:-1:flags=lanczos,palettegen" palette.png`
  2. `ffmpeg -i in.mp4 -i palette.png -filter_complex "fps=15,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" out.gif`

## 已知局限(如实告知用户,不要沉默)

- pdf → docx 效果差,版面会错乱,转前提醒用户预期,复杂文档建议人工核对
- pandoc 直出 pdf 需要额外 LaTeX 引擎(本机大概率没装),docx/html → pdf 一律走 soffice,不要试 `pandoc -o out.pdf`
- soffice 首次调用可能冷启动较慢,等进程退出再读输出文件,不要提前判断失败

## 输出约定

- 默认输出到源文件同目录,同名换扩展名
- 不覆盖源文件;目标文件已存在时加 `-1`/`-2` 后缀,或先问用户
- 转换后用 `ls -la` / `Get-Item` 确认输出文件存在且体积非 0,再回报成功
