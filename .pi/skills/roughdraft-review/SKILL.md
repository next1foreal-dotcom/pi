---
name: roughdraft-review
description: 用 Roughdraft（本地 Markdown 审阅器，http://localhost:7300）把需要 Fei 逐段批注的 markdown 文档开给他审。批注以 CriticMarkup 语法写进 md 文件本身，审完直接重读文件就能拿到全部反馈。Use when 交付 PRD/方案/长文档需要 Fei 批注，或 Fei 说"开到 roughdraft"、"我要批注"。
---

# roughdraft-review — 把 md 文档开给 Fei 批注

Roughdraft 已装在本机（NEXT1），服务端口 **7300**（默认 7373 被 Windows 排除端口段挡住，别用）。它把评论和建议修改直接写进 md 文件——你不需要任何 API，重读文件就是读反馈。

## 流程

1. **确保服务在跑**：`roughdraft status --json`；没跑则 `roughdraft start --port 7300`。
2. **打开文档**（绝对路径）：

   ```
   roughdraft open "D:\path\to\doc.md" --no-watch
   ```

   会弹 Fei 的默认浏览器。把 URL 也发给他：`http://localhost:7300/?path=D:/path/to/doc.md`（正斜杠）。
3. **等 Fei 审**：告诉他"批注完点 Done Reviewing 然后叫我"。如果你的 harness 支持后台命令，可以跑 `roughdraft watch "<abs>.md" --json` 等事件——注意它活不过 5 分钟会崩（上游 bug），崩了重跑即可；不支持就等 Fei 说"审完了"。
4. **读批注**：重读 md 文件，解析 CriticMarkup：
   - `{>>评论<<}{id="c1" by="user" ...}` = 评论；`re="c1"` 是对 c1 的回复
   - `{~~旧文~>新文~~}` = 建议修改（接受 = 用新文替换整段标记）
   - `{==原文==}` = 被批注的锚点文本
   - 文档级总评在文件末尾 YAML `comments:` 块
5. **逐条回应**：按建议改正文；要回复评论就用同语法追加 `by="AI"` 的回复写回文件，Fei 刷新页面即见。

## 注意

- 升级 roughdraft 用 npm 不用 pnpm（包内有 file: 依赖 pnpm 装不了）；升级后若崩报缺 yaml，进它的全局安装目录 `npm i yaml --no-save`。
- 服务是全局单例（`~/.roughdraft/server.json`），别 stop——其他会话可能也在用。
- 批注在文件里 = 文件被改了。改前该有基线的（git）先确认有基线。
