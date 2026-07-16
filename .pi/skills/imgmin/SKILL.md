---
name: imgmin
description: 图片压缩瘦身,默认真无损。触发:"压缩图片"、"图太大了"、"无损压缩一下"、"这几张图能不能小一点"。
---

# imgmin — 图片压缩

## 定位工具

按格式分别定位,每个都先 `where.exe` 试 PATH,找不到按已知路径找(2026-07-17 逐个验证过),再找不到给 winget 命令,不要跳过某张图静默不处理:
- oxipng 10.1.1(PNG):已在 PATH(`%LOCALAPPDATA%\Microsoft\WinGet\Links\oxipng.exe`);缺失时 `winget install --id Shssoichiro.Oxipng`
- jpegtran(JPG):`C:\libjpeg-turbo64\bin\jpegtran.exe`;缺失时 `winget install --id libjpeg-turbo.libjpeg-turbo.VC`
- cwebp 1.6.0(WebP):`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Google.Libwebp_Microsoft.Winget.Source_8wekyb3d8bbwe\libwebp-*\bin\cwebp.exe`(版本目录通配);缺失时 `winget install --id Google.Libwebp`
- magick 7.1.2 兜底(格式转换/有损压缩):`C:\Program Files\ImageMagick-*\magick.exe`;缺失时 `winget install --id ImageMagick.ImageMagick`

## 两档策略

**默认档:真无损**(像素完全不变,只去冗余数据):
- PNG:`oxipng -o 4 --strip safe in.png`
- JPG:`jpegtran -copy none -optimize -progressive -outfile out.jpg in.jpg`
- WebP:`cwebp -lossless in.png -o out.webp`

**肉眼无损档**(实际是有损压缩,画质几乎无感但像素会变——必须用户明确说"可以有损"才用这档):
- `magick in.png -quality 85 out.jpg`
- `cwebp -q 82 in.png -o out.webp`

不确定用户接受哪档时默认走真无损,不要擅自选肉眼无损档。

## 汇报格式

每张图必须报:
```
文件名: 原大小 → 新大小 (省 xx%)
```
体积用 `ls -la` 或 `Get-Item .name .Length` 读实际字节数,不要估算或只报"压缩完成"。

## 校验(真无损档必须做)

```
magick compare -metric AE original.png compressed.png diff.png
```
AE(绝对误差像素数)应为 0,不为 0 说明混进了有损处理,要回头查命令参数,不能直接报"无损"了事。

## 输出约定

永不覆盖原图。输出文件名加 `.min` 后缀(如 `photo.min.png`),或统一放进同目录下的 `minified/` 子目录——项目里已有约定就跟随约定,没有就用 `.min` 后缀。
