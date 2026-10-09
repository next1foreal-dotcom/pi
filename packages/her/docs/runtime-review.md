# Runtime review (draft)

## Scope

A receipt-based supervisor around the existing Her extension, not a new plugin framework or a Claude Mods compatibility layer. Cedar and the existing tools remain authoritative. No upstream Pi files, permissions, dependency manifests, or long-term memory files are changed.

`extension-with-review.ts` calls Her first and then registers the observer. Both existing extension entrypoint shims load this wrapper. The original `src/extension.ts` stays unchanged; integrations importing it directly do not get runtime review.

## Operator activation

Successful read/write receipts are tracked for read-before-edit checks whenever the wrapper is loaded. Failed or merely requested reads do not grant editing permission. Relative paths use the session working directory.

The completion gate is opt-in. At idle, the operator pins exact tool inputs:

```text
/her-review begin {"checks":[{"name":"unit","tool":"bash","input":{"command":"node --test test/unit.test.ts"}}],"maxToolCalls":64,"maxContinuations":0}
```

Use paths and a command that actually match the project. This command only records a verification contract; it never executes that command and grants no additional permissions. The exact tool name and entire input object must match, including any timeout options. Only trusted operators should set the contract. The transcript receives the contract so the model knows which checks to run; receipt snapshots retain hashes rather than raw commands or outputs.

`/her-review status` shows the state. `/her-review reset` clears the operator gate after inspection; successful read receipts are retained. Models cannot reconfigure the contract through a model-callable tool. This is not isolation against malicious host extensions or unrestricted shell access.

## Enforcement and display

- Final `tool_execution_end` status, not assistant prose, credits a check.
- Missing/failed checks, pending calls and observer faults block `her_goal_complete` and `her_task_update(status=done|completed)` while armed.
- Mutation attempts invalidate previous verification. Concurrent checks cannot certify an unfinished mutation. Only a causally later identical successful retry resolves a recorded failure.
- Completion must be a standalone model tool call: never inside a still-running Code Mode parent or a batch containing other work.
- Nested calls are handled through the same event handlers; no nested executor or alternate authorization path is added. A Code Mode parent never masks a failed child.
- `agent_before_settle` adds a structured, visible verification message. The TUI status uses the same view, and `her:runtime-review` exposes it to same-process UI consumers. A separate web UI still needs to subscribe/render it; no browser panel or buttons are implemented here.
- No extra model calls by default. Operator opt-in allows at most two continuations, bounded by the recorded tool-call budget. Cancellation and pending user input suppress continuation.
- Snapshots use Pi custom session entries and restore only the active branch. Interrupted work is not credited as successful; corrupt state blocks rather than resetting to a pass. UI failures do not disable checks, while persistence failures block execution.

`verified` means only that the operator-pinned checks passed against the observed revision. It is not proof of arbitrary task correctness. File changes outside observed tools, malicious result-transforming extensions and external side effects are not independently verified. The existing legacy read guard still runs first; after reload it may conservatively require another read even when this observer restored a receipt.

## Verification

Executed in an isolated extracted workspace, Node v22.16.0:

```sh
node --experimental-strip-types --test packages/her/test/runtime-review.test.ts
```

30/30 tests passed. These include pure-state regressions, real local exit-code fixtures, and a mocked ExtensionAPI contract harness. They are NOT a live Pi, QuickJS, Cedar integration, Windows or full-project test.

Before merge, run root `npm run check`, the focused test in the real workspace, and a live Pi 1.0 probe covering direct/nested denial, cancelled reads, reload, failed checks, argument rewrites, user cancellation and completion in parallel batches. Network/DNS is unavailable in the current execution container, so the full checkout/dependencies, root check, and live Pi host verification were not available. Keep this PR draft until those gates pass. Do not merge automatically.

## Pi Durable boundary

Pi Durable is a separate experimental harness. This change does not migrate to it or claim Durable compatibility. The decision state is separated from the Pi adapter so a later, independently tested adapter can use Durable hooks and committed documents without maintaining a second acceptance policy. Keep Her long-term memory separate from transient execution state.
