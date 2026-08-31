---
name: next1-quirks
description: NEXT1 这台机器的坑速查（血泪实录）：端口排除段、杀进程规矩、Node 代理开关、子进程输出被吞的读法。触发：起任何监听服务/dev server、杀任何进程、Node 网络请求莫名超时、无头跑子进程拿不到输出时。先查这里再排障。
---

# next1-quirks — 本机坑速查

## 端口：先查排除段再监听

Windows 端口排除段（bind 必失败或被系统占）：**1367-1466**（含 Codex OAuth 回调的 1455）、**2903-3962**、**8538-9337**。起服务前先 `netstat -ano | findstr :<port>` 查占用——**已有进程在听就复用，禁止再起一个把它顶掉**（历史上顶掉过 Fei 在跑的服务）。

已知常驻端口：samantha-ui dev = **4321**（旧惯例 4200/4300）· her-gateway = **18130** · voice 网关 = 8123 · voice WS = 8400 · Roughdraft = 7300。

## 杀进程：按 PID，不按镜像名

机器上常有多个 Claude/Codex/node 会话并行。禁止 `taskkill /IM <名>` / `pkill <名>` 批量杀——会误杀别的会话。杀之前 `tasklist` / `Get-Process` 按 **PID + 启动时间 + 命令行** 确认归属，只杀确认是自己这条线的那个 PID。拿不准归属就上报 Fei，不瞎杀。

## Node 网络：必带 NODE_USE_ENV_PROXY=1

本机上网走代理 `127.0.0.1:10808`，但 Node 的 fetch（undici）**默认无视** HTTP_PROXY 环境变量——不带 `NODE_USE_ENV_PROXY=1` 的 Node 进程做外网请求必超时。起任何要联网的 Node 进程（generate:models、OAuth 流、网关）都把它写进 env。

## 拆带 junction 的目录：先摘链接,再删树(G-357)

任务 worktree 常挂着指向主仓 `node_modules` 的 junction。**任何递归删除都会穿过 junction 删掉主仓真身**——`rm -rf`、`Remove-Item -Recurse`、连 `git worktree remove` 都实测穿透过,两次打瘫全机门禁。唯一安全序:
1. 先摘链接:`cmd /c rmdir "<树>\node_modules"`(对 junction 用**不带 `/s`** 的 rmdir,只摘重解析点不碰目标);
2. 立刻验主仓 `node_modules\.bin` 计数没变;
3. `Get-ChildItem <树> -Recurse -Force | Where LinkType` 扫残余链接,必须为空;
4. 这时才允许删树,删完再验一次 `.bin`,最后 `git worktree prune`。
破坏性操作被中断后,校验受影响面的**整体**(遍历/计数),不是只验你第一个想到的那一项。

## 子进程输出被吞：落盘再读

- **PowerShell 管道**会静默吞子进程 stdout/stderr：无头验证命令一律 `*> 文件` 落盘后再读文件，别信管道里的空输出。
- **git-bash 会吞 pi 的 stdout**：驱动 pi 用 PowerShell 落盘或 Node spawn 捕获流。
- 后台任务没跑完就读输出 = 读到半截，"还没写完"长得像"结果为空"——判断前先确认进程已退出。
