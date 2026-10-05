# CUA managed runtime

Her 内置适配扩展，官方 CUA Driver 独立运行和更新。适配输入协议基线为 0.33.3；已在 Windows x64 对 0.33.3、0.33.4 完成实机验证。Windows arm64 有安装分支，尚无实机验收。

## 更新与权限

- 使用官方 stable 通道；不依据这个多产品仓库的 GitHub Latest / Pre-release 标签选版。
- 从官方 GitHub release 下载独立 binary ZIP，比对资产 API 的 SHA-256；只提取单个 exe 到新的版本目录。没有执行远程安装脚本，没有修改 PATH、系统自启动或用户上游通道设置。
- 逐项比较 Her 使用的 21 个工具的完整输入 schema，忽略描述文字。任何约束变化都会要求人工适配；不会自动开放新增工具。
- `verify` 启动独立 Chrome，访问临时 loopback fixture，检查窗口、截图、稳定存在、浏览器输入/点击后的保存结果、悬停、上传、下载内容和 JS dialog 检查。页面异步更新只允许重复读取，不重复输入。验收不涉及个人登录态或模型费用。
- 未通过实测、接口基线变化、二进制摘要不符的版本不能启用。再次验收前撤销旧的成功状态；失败不会保留“绿色”标记。
- 切换/回退只更新原子版本指针，下次启动 Her host 才生效。已运行实例固定原二进制；旧文件保留。
- 托管模式使用独立 `mcp --direct` runtime，不连接共享 daemon。不能同时配置 `driver_socket`；已有白名单、tier 和 UI 确认继续生效。
- 更新命令是人工 `/cua` 命令，不注册为模型工具。实机验收需要空闲的交互会话并确认电脑操作。
- 使用托管模式后，Her 会话启动时异步检查更新，按二进制路径缓存 24 小时；失败提示且保留现用版本。没有创建系统计划任务，也不会后台安装或自动切换。

## 首次安装（从 Samantha 仓库根目录执行）

以下 `<runtime-root>` 是用户选择的绝对目录，`<bootstrap-exe>` 是已安装的官方 CUA 可执行文件；不是需逐字复制的路径。每步读取返回的 candidate ID，不猜测 ID。

```powershell
node --import tsx packages/her/src/hands/runtime-cli.ts check <runtime-root> <bootstrap-exe>
node --import tsx packages/her/src/hands/runtime-cli.ts stage <runtime-root> 0.33.4
node --import tsx packages/her/src/hands/runtime-cli.ts verify <runtime-root> <candidate-id> --allow-fixture
node --import tsx packages/her/src/hands/runtime-cli.ts activate <runtime-root> <candidate-id>
```

`stage` 可省略版本，使用上次成功检查的 stable 版本。精确版本用于可复现安装或准备旧版回退。`--allow-fixture` 明确允许仅对独立测试浏览器进行电脑操作；未提供时拒绝实测。

完成后，在已有 `.her/config.yaml` 的 hands 段选择：

```yaml
hands:
  desktop_driver_binary: managed:<runtime-root>
  driver_socket:
```

保留其余 hands 权限字段。此配置本身不会启用桌面或浏览器权限。重启 Her host 后加载；没有有效 active 版本时明确失败，不悄悄退回 PATH 中的另一版驱动。

## 日常管理

```text
/cua status
/cua check
/cua stage 0.33.4
/cua verify <candidate-id>
/cua activate <candidate-id>
/cua rollback
```

`status` 分开显示正在使用的 binary 与下一次启动的选择。`rollback` 也要重启 Her host，且目标必须仍通过接口和完整性检查。CLI 同样支持这些子命令。网络请求沿用进程代理配置。

更新过程中 `update.lock` 防止多进程互相覆盖。若进程被强行终止导致锁残留，先核对锁内 PID/时间并确认管理进程已退出，再人工归档锁文件；不按时间自动抢锁。损坏的状态文件不会被空状态覆盖。

## 本地验证证据（2026-10-05）

证据目录：`D:/@Her/work/cua-0333-20261005`。

- `update-tests.log`：相关单元回归；`update-check.log`：全仓检查。
- `update-live.log`、`update-rollback-live.log`：0.33.4 和 0.33.3 的真实 Driver fixture 验收。
- `update-switch.log`：0.33.3 → 0.33.4 → 0.33.3，以及现有实例保持原版本；最终测试目录选中 0.33.4。
- `update-her-live.log`：实际 Her tools 使用 managed 0.33.4，完成上传/下载、原生窗口验证及 prompt 超时后的检查/处理，没有重放输入。
- 本候选按用户授权采用独立分支提交推送；尚未合并/部署，用户当前 Her 配置未切换。真实 Studio 人工确认、个人 profile 和模型自主规划仍是独立验收项。

上游：[更新文档](https://cua.ai/docs/cua-driver/guides/operate)、[0.33.4 发布](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.4)。摘要核验基于 GitHub 发布资产，不声称完成 Sigstore 验签。