# Local Self-Evolution integration evidence

Status: local engineering verification passed; commit/push pending normal hooks. No merge or deployment. This report supersedes only the local-execution debts in HANDOFF.md, not its historical evidence.

- Task: `her-self-evolution-integration-20261002`.
- Executor: main Codex, with Luna collecting legacy-test migration results.
- Runtime thread/session: `01a0f910-9d84-7d31-9ccb-074570b833b5`.
- pi base: `3f918b0dddf373582f1629a7da22a66ade7f0498`; fetched handoff: `0145706727cf52e77b01114efed0e437ed6bf7dc`.
- pi branch/worktree: `codex/her-self-evolution-integration-20261002`, `D:/@Her/wt-self-evolution-20261002`.
- Her ledger base: `882611ced4640a3ebd47cc4f4691e48f936c31e0`, confirmed with live `git ls-remote origin refs/heads/main`.
- Her ledger branch/worktree: `codex/her-self-evolution-ledger-20261002`, `D:/@Her/wt-self-evolution-ledger-20261002`.

## Boundaries and call sites

`runSelfMod` is called by CLI/pickup and offline tests; it loads the host-owned plan before applying a proposal, runs mechanical gates, then evaluates exact Git blobs through the frozen evaluator. Default test runner reads actual TAP totals. Boundary normalization remains shared by selfmod and anchor/governed-tool checks. The skill ownership whitelist is unchanged. V0.1 independent evaluation only supports tracked Markdown targets; it does not silently expand to TypeScript or new skills.

`checkRollback` is called by CLI and pickup sweep (also re-exported by her-core). No other caller uses `revertSelfmodMerge`. Generic production organ/host events currently carry runId and outcome, but NOT a reliable skill adoption identity. Their error text is insufficient for automatic rollback and will remain pending evidence; this change does not fabricate that missing runtime wiring.

Automatic rollback requires an explicit non-derived failed observation, timestamp strictly after adoption and no later than check time, and `refs.selfmod` containing exact `proposalId`, `mergeCommit`, and complete `targetPaths`. Failed host exits also require a nonzero integer exit code. Unmatched starts are not confirmed crashes; planned restarts do not establish rollback evidence. Clock/identity ambiguity is appended as `rollbackCheck` in the existing ledger. The adoption timestamp is preserved so polling cannot renew the 24-hour watch window.

Rollback uses the existing adoption lock, verifies clean Git state/tag/ancestry/unchanged targets, persists intent before Git, performs real revert, verifies target bytes against baseline, then appends the rolled-back record. Conflict/interruption stays pending manual reconciliation and is never blindly retried. Multi-commit adoptions require manual rollback in this version. No second ledger or runtime service is introduced.

## Environment and baseline

Windows, Node v24.17.0, npm 11.13.0, installed tsx 4.22.1. The task's node_modules junction reuses `D:/@Her/wt-samantha-closure-20260926/node_modules`; TypeScript aliases resolve the task worktree's real source graph. Required ignored provider JSON was copied from the release worktree at the same pi SHA. No substitute module loader, build, root npm test, provider request, or credential activation was used.

Raw logs are retained in `work/self-evolution-evidence/`. Initial sandbox spawn EPERM and missing-provider-data failures are retained separately; they are not passing test evidence. After local hydration: baseline focused suite 66/66, zero skipped, exit 0; root `npm run check` exit 0 with five pre-existing informational useTemplate diagnostics. The original rollback implementation failed 16/17 new regression checks (one existing happy path passed).

## Windows integration correction

The candidate runner disabled system/global Git configuration while apply and checkout used the host configuration. On this Windows installation `core.autocrlf=true` is supplied by system Git config; the candidate reader therefore reported clean tracked files as dirty. A regression using an inherited Git CRLF configuration failed with the original runner and is retained. Local read-only Git commands now inherit the host configuration, while evaluator child processes still receive an empty environment. No global Git configuration changed.

## Live acceptance debt

All deterministic evaluator results are synthetic engineering fixtures. Real skill failures, paid experiment budget, repeated model measurements, token/dollar accounting, live adoption, production observation, production rollback and Samantha review remain unverified. No task here updates live permissions, runtime branches, memory stores, schedules, or deployments.
## Final engineering verification (2026-10-01 America/Phoenix)

- Full repository `npm run check`: exit 0. Same five pre-existing informational useTemplate diagnostics; no new errors or warnings. They are outside this change and retained as baseline debt.
- Affected 25-file offline suite: **228 tests passed, 0 failed/cancelled/skipped/todo**, exit 0. Includes selfmod, anchor/governed tools, improvement runner/assessment, event history and op brackets. This is the affected regression suite, not the root e2e/full npm test suite.
- Legacy same-environment baseline: 66/66, all legacy test names retained in the candidate run (TAP escapes the literal # in one name).
- Source: 23 changed/new TypeScript files, all valid UTF-8 without BOM/replacement characters and below 1000 lines. `git diff --check` passes. No upstream coding-agent changes, new dependencies, live memory writes, or schedules.
- Full logs, explicit argv/cwd/version/count/exit metadata and SHA-256 receipts: [evidence/manifest.json](evidence/manifest.json). Candidate source digests: [evidence/source-sha256.json](evidence/source-sha256.json). Local test subprocess session IDs included 82092 (baseline), 63893 (rollback RED), 32234 (73-test focused GREEN) and 97923 (228-test final GREEN); these are execution receipts, not provider sessions.
- Acceptance result: engineering checks PASS; live JUDGE NOT RUN. Commit and push status is recorded separately below after hooks/remote verification.
Published evidence normalizes line endings/trailing whitespace only; the manifest records both original local and published SHA-256 values. All diagnostic and test records remain present. Secret scan covered the 40 scoped delivery files (275 KB), with no findings; source hashes rechecked before staging.

Normal commit attempt exited 1: anchor-path-gate blocked packages/her/src/rsi/anchors.ts. No commit was created and no hook was bypassed. The user explicitly authorized the one-time FEI_ANCHOR_OVERRIDE=1 on resumption; all remaining hooks and signing still run normally. Actual Her BACKLOG G-280 and progress snapshot have been updated in the separate ledger worktree; both branches remain unpushed. Source manifest distinguishes tested worktree byte digests from staged LF-normalized Git blob digests.

Continuation input fetched: 027e298331fd74090688f062c7ff4c6b58008434. GROWTH-LOOP.md expands the objective to discover/learn/transfer/correct; its archive digest was verified. Growth integration is a subsequent increment. User authorized existing configured model experiments with total USD <= 2, tokens <= 30000, wall clock <= 20 minutes; no spend has occurred yet.
