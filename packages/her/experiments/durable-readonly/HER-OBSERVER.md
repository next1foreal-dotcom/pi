# Her source observer adapter (opt-in)

Stacked on the isolated Durable recovery probe (PR #9). This adds a usable model-neutral extension factory, not a migration or a background service. It is not auto-loaded by Her. No existing authorization rule, root dependency, primary runtime, live session, or memory store is changed.

## What is now shared with Her

- `her-observer.mjs` calls the existing `lib/cedar.ts` evaluator with `policyEnvelope("plan")` and the existing registered `read` capability. Its tool is strictly narrower than `read`: only operator-selected sources are reachable. It does not inherit `full` mode or grant a new Cedar permit.
- `review-evidence.ts` exports `verifyEvidenceContent()`. The original file-based verifier delegates its line checks to this same helper without changing those semantics. The observer uses the helper on a bounded authorized snapshot, avoiding a second unbounded file read.
- `createHerObserver()` returns a Durable extension, its one tool, and `bind`, `watch`, `report` integration functions. The caller supplies its own models/storage and starts the conversation explicitly. No fake model provider is present in the adapter; faux providers exist only in tests.

## Host contract

Create a dedicated conversation. Supply absolute existing `workspaceRoot` and `memoryRoot`, an explicit `isEnabled` callback, and 1–16 sources shaped like:

```json
{"id":"review","path":"src/review.ts","sha256":"<operator-computed SHA-256 of the selected version>","lines":"1-30"}
```

The example digest must be replaced by a real 64-character lowercase SHA-256. Source selection, digests and budget are host-owned, not model-chosen. This is a source-version contract, not a request to let the model compute its own pass condition.

```javascript
const observer = await createHerObserver({
  workspaceRoot, memoryRoot, sources,
  isEnabled: () => operatorState.readonlyObserverEnabled === true,
  maxCalls: 32,
});
registry.install(observer.extension);
// Open a Durable 1.0.0 Harness with the application's own models and storage.
const root = await harness.root(context, { agent: { tools: [observer.tool], model } });
await observer.bind(harness, root, context); // before submit/resume
const watch = await observer.watch(harness, root, context);
watch.start(async (committed) => renderObservation(committed));
// Submit with a stable requestId. After it settles:
const report = await observer.report(harness, root, context);
await watch.stop();
```

This sketch assumes the caller has constructed `registry`, `harness`, `model`, and cancellation context. Use a fresh, dedicated store/conversation. Do not share an unrestricted tool registry with this observer. The host must cap model requests/cost and place SQLite outside the source checkout and private memory store. The adapter caps source-tool executions (including retries), not model billing.

Only `evidence-complete` means all selected file/line receipts have matching successful Durable tool results and their bytes were revalidated for this report. It is NOT code correctness, semantic claim verification, a test-suite pass, or overall task completion. `structuralOnly` remains true. Revalidation is sequential, not an atomic multi-file snapshot; use an immutable checkout for stronger snapshot semantics. A later file change invalidates this point-in-time report.

## Boundaries

- Model input contains source IDs only, never paths. Hidden/private path segments, traversal, Windows device names, symlinks, directory junctions, hardlinks, binary text and files over 64 KiB are refused. There is no source-content output: only relative paths, line ranges, sizes and hashes.
- The actual configured private-memory root is excluded even if named differently from `her-memory`. Both roots are re-resolved for each read.
- Authorization runs in the Durable hook, in the execution body, and after reading. An operator revocation or callback/evaluator failure cannot publish a new receipt. No real private-memory read is involved in this test suite.
- Manifest identity includes canonical roots, pinned source versions and line ranges. Rebinding a saved conversation to different sources or a larger budget fails rather than resetting the gate.
- The bounded attempt/audit state and receipts live in a custom Durable document, not Her long-term memory. Missing tool results cannot become completed evidence. A model's success claim alone remains pending.
- Reporting revalidates the files, including sources whose completed tools are not rerun after restart. Do not confuse zero repeated tool calls with zero physical disk reads.
- Custom-document watches are separate from the conversation's built-in view. Consumers must not label every receipt update as task completion; use `report()` after settlement.
- Any recorded tool error keeps this first version blocked; repair uses a new explicit observation run. It does not loop or repair autonomously.
- This is not an OS sandbox against malicious same-user processes/host extensions. Path checking cannot promise protection from every concurrent filesystem race. It does not establish external side-effect exactly-once guarantees.

## Reproduce

On Node >=22.19 (CI uses Node 24):

```sh
node packages/her/experiments/durable-readonly/run-her-observer.mjs
```

The runner copies the actual Her authorization modules/policies and evidence helper into a temporary installation. It pins Durable, Pi AI and Chord to 1.0.0 and Cedar WASM to the repository's 4.11.1, disables install scripts and invokes npm without a Windows shell. Root dependency files remain untouched. Transitive dependencies are not fully lockfile-pinned; this is validation, not a production release.

The suite has 13 dependency-free scope/compatibility tests and 10 SDK/Her integration tests. It reads copies of two actual Her source files, exercises the real Cedar evaluator/policies, performs SIGKILL recovery, and verifies permission revocation, unknown IDs, unchanged private-store sentinels, source mutation, persistent budgets and manifest rejection. The model is simulated; the SDK, SQLite, files, child processes, Her policy code and evidence helper are real.

Local authoring result: 13/13 scope tests passed and all authored `.mjs` files pass `node --check`. Local SDK execution is blocked by Node 22.16.0 and unavailable npm DNS. CI results must be recorded separately after inspection. Root `npm run check`, full Her regression tests, a live primary-session integration and browser UI are still required before rollout. Keep draft; do not auto-merge.
