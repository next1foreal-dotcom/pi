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

Local authoring check: 27/27 dependency-free scope and protocol/command tests passed on Node 22.16.0; changed MJS syntax checks passed. Real SDK/typecheck results must come from the dedicated Linux/Windows workflow, not from that local result.

## Workspace gate

Workspace workflow 37040407212 attempted locked installation on both the unchanged base and the PR head. Both failed because the root lockfile lacks `undici@8.5.0` and `@earendil-works/pi-session-backend-sqlite-node@0.87.0`. Consequently full Her regressions and root `npm run check` did not execute. This bridge does not modify the root lockfile to bypass that baseline failure.

Keep PR #10 draft. Root install/check, full regressions, live primary-session integration and operator provisioning remain rollout gates. No deployment or merge is performed by these workflows.
