# CUA Driver 0.30.1 adaptation evidence

Validation date: 2026-09-30. Candidate base: Samantha `a36a35c5defcf09dc2c59232ab87f195064818b1`.

## Version and behavior changes

- Exact upstream release: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.30.1
- Windows x86_64 binary ZIP SHA256: `96ebb5996c0e25adf40ed648a46959723d31df5d90f24ffe2fb2d3cc2ee780be`, matched upstream checksums.txt.
- Keep native snapshot IDs and opaque element tokens; remove the 0.7.0 index-to-pixel workaround.
- Require an observed target window. Failed observation/action and unverified effects invalidate the cache. No blind retry or pixel fallback.
- Only `effect: confirmed` reports success. Partial, unverifiable, suspected-noop and missing evidence stop the batch as unverified.
- Expose drag start/end coordinates without changing the app whitelist, tier or write-confirmation policy.
- CLI calls require a running standard-mode daemon. No scheduled autostart or approval bypass is introduced.

## Checks

- Baseline hands tests: 28/28 passed.
- New regression cases first reproduced four failures on the old implementation.
- Final `node --import tsx --test packages/her/test/hands.test.ts`: 33/33 passed.
- TypeScript, pinned/runtime dependencies, import paths, entry graphs, shrinkwrap and install-lock checks passed.
- Browser smoke initially hit sandbox `spawn EPERM`; rerun outside the sandbox passed.
- Biome on changed code passed. Repository-wide check reported five pre-existing informational `useTemplate` suggestions outside the changed files.

## Windows live tool-chain acceptance

A standard-mode daemon on the task-private `her-cua-0301-validation` pipe drove a newly created, uniquely named Notepad test file. Her's registered tools performed snapshot -> indexed type_text -> new snapshot. Driver result: `delivery.mode=background`, `effect=confirmed`, `route=accessibility`, evidence `value_readback`. The fresh UIA snapshot contained `CUA 0.30.1 verified readback`.

The target was matched by the task-owned filename and exact resolved pid/window_id. No pre-existing document was targeted. Raw outputs are in `D:/@Her/work/cua-0301/live-{snapshot,action,after}.json`.

This is scripted tool-chain acceptance with a test confirmation callback. It does not claim an LLM-planned interactive task or human confirmation UI acceptance. No model/provider request was made. The original 0.7.0 evidence file remains historical.
## Installed result

- Installed canonical `cua-driver --version`: `cua-driver 0.30.1`.
- Source patch applied to the development checkout and running `D:/@Her/samantha-release-20260927` checkout; unrelated edits retained. The running release checkout now contains a local patch, not a new published release.
- Runtime checkout hands tests passed 33/33 after patch application.
- Installed canonical binary/default daemon readback passed using the runtime checkout's registered snapshot tool: `D:/@Her/work/cua-0301/installed-acceptance.json`.
- Standard-mode daemon is running for this login. Autostart remains `not-registered`; after reboot, start `cua-driver serve` before using desktop hands.
- The 0.7.0 release and `current-before-cua-0301` rollback junction are retained. Before-patch copies and the exact source patch are under `D:/@Her/work/cua-0301/`.
- At installation time, no commit, push, tag, remote merge, Her process restart or model request had been performed.
- A later one-shot `pnpm run check` exited with Windows code 3221225477 before reporting checks. Direct repository-wide Biome and TypeScript reruns exited 0; all constituent checks had passed, browser smoke via an unsandboxed rerun. Do not describe the one-shot command as green.
- Upstream's update checker announced 0.30.4 during installation. This task deliberately retained the inspected and live-tested 0.30.1 target; 0.30.4 was not assessed or installed.