# Primary-session observation report bridge (opt-in)

This connects an existing Durable observer owner to a Pi command. It does not migrate the main runtime, start an observation, select a provider, execute a model turn, or open an existing SQLite file in a second owner.

## Host wiring

In the process that already owns the `observer`, `harness`, `root`, and cancellation `context` from HER-OBSERVER.md:

```js
import { randomBytes } from 'node:crypto';
import { serveObserverReport } from './observer-report-server.mjs';

const token = randomBytes(32).toString('hex');
const service = await serveObserverReport({
  observer, harness, root, context, token,
  sessionId: approvedPiSessionId,
});
const piEnvironment = {
  HER_OBSERVER_REPORT_ENABLED: '1',
  HER_OBSERVER_REPORT_URL: service.url,
  HER_OBSERVER_REPORT_TOKEN: token,
  HER_OBSERVER_REPORT_MANIFEST: observer.manifestId,
};
// Pass these values privately to the intended Pi process. Do not log the token.
// Before closing the owning harness:
await service.close();
```

`approvedPiSessionId` must be the actual intended Pi session ID. The host provisions it; the endpoint never accepts a client's request to change that binding. The host must run on the same machine as Pi. Provisioning and starting the existing observation remain explicit operator responsibilities. This is not a new background daemon.

The project entrypoint `.pi/extensions/her-observer.ts` loads the bridge. With no enable flag it registers nothing. With the four environment values set before loading/reloading the extension, the operator can use:

```text
/her-observer refresh
/her-observer status
/her-observer clear
```

`refresh` performs one authenticated loopback GET, calls the existing observer's fresh report validation, persists the accepted envelope, and queues a visible custom message. It does not request a model turn. `status` shows only a historical cached snapshot, with no network call. `clear`, session changes, and tree changes invalidate the cache; historical transcript entries are not deleted. The main extension imports no Durable runtime.

## Boundaries

The owner binds to numeric `127.0.0.1` only. It checks a random bearer token, session ID, manifest ID, exact route/method/Host, and rejects browser Origin requests. Concurrent refreshes receive 429. The client refuses redirects, non-JSON, oversized bodies, stale success timestamps, incorrect scope and malformed counts. Endpoint text and paths are not forwarded to the model; only a whitelisted structural envelope is rendered with fixed wording.

Refresh does not automatically continue interrupted work. A failed refresh invalidates cached success. Session replacement or cancellation discards late responses. UI disconnection does not change evidence. Failure to archive a fresh result cannot create a cached pass.

The report rechecks current enablement, Cedar and source bytes. It does not create tool calls or mutate the observation receipt document. Disk revalidation is bounded and sequential, not an atomic multi-file snapshot. It is a time-stamped structural check, never a correctness or task-completion verdict. A bearer token is not an OS sandbox against a malicious same-user process.

## Verification

Run `node packages/her/experiments/durable-readonly/run-her-observer.mjs`.

The expanded isolated suite targets 42 tests: 13 source-scope tests, 14 protocol/command tests, and 15 SDK/Her/report/loader tests. The runner additionally type-checks the four bridge TypeScript entry/source/test files against published Pi 1.0.0 types. Its temporary dependencies are pinned, installation scripts disabled, and root dependency files untouched.

The real loader tests exercise published Pi's module loader and ExtensionAPI registration against the real Durable/Cedar report endpoint. Session storage/UI dispatch in those tests are capture sinks, not a deployed main AgentSession. This is not a browser renderer, live-user installation, or proof of the unupgraded 0.87 host.

### Measured results (2026-10-02)

Code commit `2fbc3354b641a2c868bf6abb4c11d9f0bd90088e` passed the dedicated Linux and Windows workflow `37042549370`. Both jobs completed successfully (Linux `110955954611`; Windows `110955954936`). The Linux detailed log records 42 passed, 0 failed, 0 skipped and successful SDK type checking; the Windows job completed the same mandatory runner successfully. These are the same 42 scenarios on two platforms, not 84 distinct scenarios.

The previous run exposed an invalid `session_switch` event through real SDK type checking. The adapter and tests now use Pi 1.0.0's `session_before_switch` event; no check or assertion was disabled. Local authoring validation is separately 27/27 scope/protocol tests on Node 22.16.0; it is not a local real SDK run.

A subsequent follow-up only consolidates duplicate imports in `observer-sdk.test.mjs` and updates this document. The passing CI evidence above belongs to `2fbc3354`, not automatically to later commits. The follow-up needs its own CI result.

## Workspace gate — not clean

The initial workspace workflow `37040407212` failed locked installation on both revisions because the lockfile was missing dependencies. A later run, `37042549502`, successfully installed both revisions and actually ran Her regressions and `npm run check`; those commands failed. The later measurements supersede the earlier installation-only limitation.

| Revision in run 37042549502 | Test summary | Root check |
| --- | --- | --- |
| Base `a142e559` | 730 total; 653 passed, 73 failed, 4 cancelled | Failed |
| Head `2fbc3354` | 782 total; 691 passed, 87 failed, 4 cancelled | Failed |

Both revisions have missing generated/build artifacts and other regression failures. The head has 14 additional failures in the aggregate; their cause has NOT been isolated, so do not dismiss them as baseline-only or claim this PR is regression-free. The suites have different totals; aggregate differences are not a one-to-one diagnosis.

The root lint check also identified a duplicate import from `her-observer.mjs` in this PR's SDK test. That import was consolidated in the follow-up, without changing test behavior. This does not establish that the full check passes. No runner-generated bulk formatting edits, root dependency manifests, or lockfile changes were committed.

Keep PR #10 draft. Root check, full regressions including the additional head failures, a real primary AgentSession/browser integration, and operator provisioning remain rollout gates. No merge, deployment or enablement was performed. This bridge is implemented and integration-tested at the loader/endpoint boundary, not activated in the user's Her installation.
