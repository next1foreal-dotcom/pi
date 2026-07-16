---
name: archive
description: 文件打包压缩与解压(zip/7z/rar/tar.gz)。触发:"打包"、"压缩成 zip"、"解压"、拿到 zip/7z/rar/tar.gz 文件需要处理。
---

# archive — 打包/解压

## 定位工具

1. `where.exe 7z` 试 PATH
2. 找不到试已知路径:**`D:\常用软件\7 zip\7-Zip\7z.exe`**(本机 26.02,Fei 手动装的自定义位置,2026-07-17 验证过;路径带空格,调用时整体加引号)。标准位置 `C:\Program Files\7-Zip\7z.exe` 本机没有
3. 都找不到 → 回报"7z 未安装",给出 `winget install --id 7zip.7zip`,不要用 PowerShell 自带 `Compress-Archive` 静默替代(它不支持 7z/rar,中文文件名兼容性也差)

## 打包

- 通用(要给别人 / 跨平台):`7z a out.zip <files...>`
- 自用体积优先:`7z a out.7z <files...>`(压缩率比 zip 高,但对方要能解开 7z)
- 带密码,同时加密文件名(仅 7z 格式支持):`7z a -p"密码" -mhe=on out.7z <files...>`
- zip 打包避免中文文件名乱码:`7z a -mcu=on out.zip <files...>`

## 解压

- 通用:`7z x archive.ext -o<目录>`(`-o` 和路径之间不能有空格)
- rar 只能用 7z 解,不能用 7z 造 rar 包
- 有密码:`7z x archive.7z -p"密码" -o<目录>`

## 只看内容不解压

```
7z l archive.ext
```
用于确认包里有什么、有没有密码保护,再决定怎么处理,不要盲目直接解压未知来源的包。

## 校验

- 打包后跑 `7z l out.zip` 确认文件数与预期一致
- 解压后用 `ls` / `Get-ChildItem` 核对文件数量、抽查一个文件能正常打开,不要只看 7z 退出码为 0 就报成功
- 密码错误时 7z 会报 "Wrong password",如实转告用户,不要反复猜密码重试
