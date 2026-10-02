# Her / Pi Durable read-only recovery probe

Experimental, operator-run validation against **Pi Durable 1.0.0**. This does not migrate Her, load into its extension runtime, or modify its goals, permissions, live sessions, memory store, or root dependency files. It is independent of runtime-review PR #8.

## Why this lives separately

The inspected `her/phase-0-pi-hygiene` base (`3f918b0`) still declares Durable 0.87.0. This probe installs the three SDK packages at 1.0.0 in a newly created temporary directory. The root workspace cannot silently substitute its older packages. Every installed version and the Node version are checked; missing dependencies and API drift fail the probe, rather than skip it.

The only added file outside this experimental directory is CI glue under `.github/workflows/`. It has read-only repository permissions, no credentials passed to the tests, no schedule, no deployment, and no merge action. It runs Linux and Windows with Node 24. It is not a substitute for the repository-wide `npm run check` or Her integration tests.

## Run

With Node >=22.19.0 and npm registry access, from the repository root:

```sh
node packages/her/experiments/durable-readonly/run-isolated.mjs
```

This explicit command installs dependencies with lifecycle scripts disabled, prints the resolved dependency inventory, runs the checks, and removes its temporary installation. Only the probe's dependencies are installed; root `package.json`, lockfiles and `node_modules` remain untouched. Direct SDK versions are pinned. The install resolves transitive dependencies and creates a temporary lockfile; this is not a fully transitive-locked production release.

Dependency-free policy tests can run without installing the SDK:

```sh
node --test packages/her/experiments/durable-readonly/policy.test.mjs
```

## What the live test actually does

1. Starts a child process using the real Durable Harness, SQLite storage, and Pi's in-process faux model provider. No real model provider, API key, shell tool, or network connector is installed.
2. Reads fixture A, stores a digest/byte-count receipt in a committed document, and lets Durable commit A's tool result.
3. Starts B and commits its in-flight tool details, then reports the persisted snapshot over IPC and blocks.
4. The parent waits for that checkpoint and sends **SIGKILL**, not `harness.close()`. A second child opens the same SQLite database and resubmits the same request ID.
5. Asserts A ran once, B was attempted twice only when declared safe to replay, the submission/user entry was not duplicated, and prior entry IDs/receipts survived. A third child reconnects and observes the same final receipts without model calls or reads.

Five other scenarios cover normal completion and duplicate submission; a tool without safe replay; revocation before restart; an authorization-hook exception; and explicit cancellation that must not restart after reopening. Tests have bounded subprocess lifetimes and dispose every temporary worker/directory, including on failure.

`observerStatus: verified` requires two valid committed receipts **and** successful matching tool-result messages. A faux model saying it is done never makes an interrupted/failed observation verified. This verdict is only about this fixed two-file probe, not arbitrary task correctness or the existing Her acceptance system.

## Safety and scope

- The read tool accepts only fixture IDs `a` and `b`, not paths or URLs. It rejects symlinks/non-files, enforces a 64 KiB limit, and returns digests rather than content.
- Permission is checked in both the hook and the execution body, including replay. The experiment's tiny allowlist is not a replacement for Cedar.
- A tool without `replay: safe` is simulated with an otherwise read-only fixture. No actual external side effects are introduced to test non-replay behavior.
- Only temporary SQLite state and test instrumentation are written. The input fixtures are checked for changes at cleanup. Nothing reads the real Her memory directory.
- Worker environment variables are allowlisted; provider secrets, proxy settings and `NODE_OPTIONS` are not forwarded. Accidental `fetch` calls in the worker throw.
- View tests exercise the built-in conversation watch plus a separate `watchDoc(Receipts, ...)` subscription. Pi 1.0.0 mounts only `pi.agent`, `pi.live`, `pi.inbox`, and `pi.usage` in its conversation view. This composite projection converges from two committed streams; it does not promise one atomic UI frame across both. Tests check checkpoint/reconnection snapshots at quiescent boundaries and receipt delivery to an already attached client, not a browser UI, multi-machine service or network authentication.
- This is not an OS security sandbox. A malicious process with the same filesystem permissions is outside scope, as are power-loss guarantees, multi-writer storage, billing recovery, and exactly-once external effects.

## Validation record

Authoring container: **12/12 dependency-free policy tests passed**, Node 22.16.0. Every authored `.mjs` file passed `node --check`. The full SDK suite is a separate gate and is not reported as passed from these checks. The authoring container cannot resolve the npm registry and lacks SDK packages; its Node is also below the supported SDK minimum.

The first real Linux and Windows CI run (`36989524025`) reached the SDK: 14/18 tests passed on each OS. The four failures exposed an adapter mistake, not absent stored receipts: custom documents are not mounted in the built-in conversation view. The adapter now subscribes to the receipt document separately; original recovery assertions remain and live custom-document delivery is also asserted. The corrected code commit `cf88ce0726aaa842069fc395110b7c2887bedb63` passed the real SDK workflow on 2026-10-02:

- Run: https://github.com/next1foreal-dotcom/pi/actions/runs/36990233514
- Linux job `110784476527`: **18/18 passed, 0 failed, 0 skipped**.
- Windows job `110784476845`: **18/18 passed, 0 failed, 0 skipped**.
- Both used Node **24.21.0**, with Chord, Pi AI and Pi Durable all exactly **1.0.0**.
- The SIGKILL probe measured attempts `{a: 1, b: 2}`, one admitted user input/submission, and equal reconnected receipts. Both logs were inspected, not only the workflow's green indicator.

These are six real SDK scenarios plus twelve policy tests on each OS, not 36 distinct scenarios. The faux model does not call a paid provider. The custom-document fix also asserts that an already attached client receives receipt updates.

**Remaining gates:** root `npm run check` and actual Her integration have not run. Keep the PR draft and unmerged. The separate `Merge Upstream Dry Run` workflow (`36990233576`) still reports conflicts in existing files including `biome.json`, `package-lock.json`, `agent-session.ts`, `main.ts`, and `tsconfig.json`; this experiment does not modify or resolve those files. Passing the isolated probe does not approve migrating Her's primary runtime.

## Source contract

Implemented against the tagged upstream sources, not remembered API names:

- https://earendil.com/posts/pi-durable/
- https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md
- https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/chat-support.ts
- https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/harness-tools.test.ts
- https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/harness-generation-recovery.test.ts
- https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/view.ts

Next migration decision: only after these measurements, consider an opt-in read-only observer adapter. Keep Her's durable memory and acceptance-policy ownership unchanged.
