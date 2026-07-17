<!-- 已器官化为 her_pdf 工具（G-53）。本文仅作行为规格存档，不再作为 skill 加载。 -->

---
name: pdfkit
description: PDF 合并、拆分抽页、瘦身压缩、加密解密。触发:"合并 PDF"、"拆 PDF"、"抽第几页"、"PDF 太大压一下"、"PDF 加密/解密"。
---

# pdfkit — PDF 工具箱

## 定位工具

1. `where.exe qpdf` 试 PATH(合并/拆分/加解密都用它)
2. 找不到试已知路径:`C:\Program Files\qpdf*\bin\qpdf.exe`(本机 12.3.2,2026-07-17 验证过;目录名带版本号,通配找)
3. 都找不到 → 回报"qpdf 未安装",给出 `winget install --id QPDF.QPDF`
4. 瘦身额外需要 gswin64c(Ghostscript):**本机当前未安装**(winget 源已下架 Ghostscript,装法待 Fei 拍板)。用户要瘦身时如实说明"瘦身依赖 Ghostscript,尚未安装",指引从 https://github.com/ArtifexSoftware/ghostpdl-downloads/releases 装官方包;合并/拆页/加解密不受影响照常做

## 合并

```
qpdf --empty --pages a.pdf b.pdf c.pdf -- out.pdf
```
按命令里给的顺序合并,顺序错了结果就错,合并前跟用户确认好文件顺序。

## 抽页 / 拆分

- 抽指定页(如抽 2-5 页):`qpdf in.pdf --pages . 2-5 -- out.pdf`
- 逐页拆成单文件:`qpdf in.pdf --split-pages -- out-%d.pdf`
- 页码从 1 开始,抽页前先用 `qpdf --show-npages in.pdf` 确认总页数,别让用户给的页码越界

## 瘦身压缩

```
gswin64c -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -sOutputFile=out.pdf in.pdf
```
`/PDFSETTINGS` 三档,按需求换,主动跟用户说清取舍:
- `/screen`:压得最狠,图片会明显模糊,只适合纯预览/邮件发送
- `/ebook`:默认档,体积和清晰度均衡,多数场景够用
- `/prepress`:几乎不压,保真度最高,体积省得少

压完用 `Get-Item` 对比前后体积,回报"原大小 → 新大小(省 xx%)",不要只报命令跑完了。

## 加密 / 解密

- 加密:`qpdf --encrypt <用户密码> <所有者密码> 256 -- in.pdf out.pdf`(256 位加密强度,用户密码打开用,所有者密码控制权限)
- 解密(需要知道密码):`qpdf --password=<密码> --decrypt in.pdf out.pdf`
- 不知道密码时 qpdf 无法解密,如实告知用户"需要密码才能解密",不要尝试爆破

## 校验

每次操作后跑 `qpdf --check out.pdf` 确认输出文件结构完整,再用 `--show-npages` 核对页数是否符合预期(合并后页数 = 各文件页数之和,拆分/抽页后页数 = 预期范围)。
