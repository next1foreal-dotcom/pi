# G-241 执行报告：OAuth 401 后强刷并重试恰一次

## 结论

实现已提交到隔离分支 `g241-refresh-on-401`，实现 commit 为 `d23c6bb9`。未 rebase、未 merge、未 push；最终工作树在报告提交后保持干净。

## 最终 seam 与运行时结论

- `packages/coding-agent/src/core/agent-session.ts:301-304` 定义 `FORCE_REFRESH_VALIDITY_MS = 3_600_000` 与保守的 401/token-expired 分类器；`agent-session.ts:1087-1103` 在主回合结束后接入 OAuth 专用路径，并在同一回合屏蔽第二次通用重试。
- `packages/coding-agent/src/core/agent-session.ts:2651-2682` 使用 `isUsingOAuth(message.provider)`，调用 `getAuth(model, { minOAuthValidityMs: FORCE_REFRESH_VALIDITY_MS })`；成功后移除失败的 assistant 上下文并调用现有 `agent.continue()` 恰一次，失败则保留原错误。
- 主回合没有调用 `_getRequiredRequestAuth`（该方法在 `agent-session.ts:417-439`，当前只服务摘要/压缩路径）；`packages/agent/src/agent-loop.ts:281-308` 只把请求交给 `streamFunction`。
- 生产 SDK 在 `packages/coding-agent/src/core/sdk.ts:302-330` 把主回合流交给 `ModelRuntime.streamSimple`；`packages/coding-agent/src/core/model-runtime.ts:440-497` 每次 `streamSimple` 延迟执行都会重新 `prepareRequest -> getAuth`。因此 headers/API key 是每次请求重新解析，不是开局缓存；强刷后的 continuation 会拿到新 token。

## 根因与改动

本地 OAuth `expires` 可能仍显示有效，但上游已拒绝 token。原主回合把 401 当普通 assistant error 终止，既没有强刷，也没有重发。

改动只在 `AgentSession`：

- OAuth 且错误文本命中 `401`、`unauthorized`、`token ... expired`、`expired ... token` 或 `invalid_token` 时，强制走既有双检锁刷新，要求剩余有效期至少一小时。
- 刷新成功后重试同一回合一次；重试成功后清除本回合标记，后续工具回合可独立处理。
- 刷新失败、重发再次 401、API-key 401、网络错误、5xx 或普通 400 均不会进入这条强刷路径；既有通用 retry 规则保持不变。
- 成功强刷时输出一行 `[pi-auth] forced oauth refresh + single retry for <provider>`。`resolveStoredOAuth`、credential store、`kimi-coding` 自刷新流均未修改。

## 变更文件与 commits

| Commit | 文件 | 内容 |
| --- | --- | --- |
| `d23c6bb9` | `packages/coding-agent/src/core/agent-session.ts` | OAuth 401 分类、强刷和单次 continuation retry |
| `d23c6bb9` | `packages/coding-agent/test/agent-session-auth-retry.test.ts` | 假 credential store、假 OAuth refresh、假 stream 的回归测试 |
| `d23c6bb9` | `packages/her/PATCHES.md` | 上游改动记录 |
| 第二个 docs commit | `G241-REPORT.md` | 本报告 |

## 亲跑验证

新增测试使用内存 `AuthStorage`、假 OAuth provider、假 stream，无 `~/.pi` / `~/.her-gateway` 读写、无真实网络：

- `node ../../node_modules/vitest/dist/cli.js --run --reporter verbose --config ../../.tmp-g241-vitest.config.mjs --configLoader runner --pool threads --no-file-parallelism --maxWorkers 1 test/agent-session-auth-retry.test.ts`：**7 passed**。
  - 覆盖分类器、OAuth 401→refresh 一次→新 token 重发一次→成功、refresh 失败、重发仍 401、OAuth 网络错误、OAuth 5xx、API-key 401。
- 同配置分别运行既有回归：`agent-session-retry.test.ts` **5 passed**、`model-runtime-auth-options.test.ts` **9 passed**、`agent-session-concurrent.test.ts` **7 passed**。
- `npx tsgo --noEmit`：exit 0。
- `git diff --check`：通过；改动文件 BOM 检查均为 `False`，替换字符检查均为 `False`。
- commit hook 运行完整 `npm run check`：Biome、依赖锁、TS import、shrinkwrap/install-lock、`tsgo`、browser smoke 全部通过。
- 独立再次运行 `npm run check` 时，最后的 `check:browser-smoke` 偶发 `esbuild` `spawn EPERM`（日志：`C:\Users\Admin\AppData\Local\Temp\pi-browser-smoke-errors.log`）；同一检查已在 commit hook 中成功复跑，故代码门禁有成功证据但本机独立复跑不稳定。
- 仓库标准 `bash ./test.sh` 被 Git Bash 启动错误阻断：`CreateFileMapping ... Win32 error 5`。临时 threads 配置下运行完整 coding-agent suite 还出现既有 Windows command/extension discovery 失败；与本改动无关。`auth-storage.test.ts` 单独运行有 1 条既有 command-backed credential 失败（`key: undefined`），未修改该路径。
- 全仓替换字符扫描发现基线文件 `packages/agent/src/harness/utils/truncate.ts:102,104` 已有 `�`；本次文件无该字符，未扩大范围处理。

## 未做与偏差

未运行真实 provider、未读取真实凭据、未 push 或部署。完整仓库测试未能在当前 Windows 子进程限制下得到全绿；新增测试及与 retry/auth 直接相关的既有套件均已亲跑通过。