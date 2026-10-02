# Growth host local execution — engineering PASS, actual experiment BLOCKED

Date: 2026-10-01 America/Phoenix. Main Codex session `01a0f910-9d84-7d31-9ccb-074570b833b5`. This report supersedes the pending commit/spend statements in the earlier LOCAL-EXECUTION.md; historical logs remain unchanged.

The previous gate repair is committed/pushed as pi `37ab9c387ca603109a2a9a47d80abc97b869e686` and Her ledger `ee9ba4d7e668ec21f0a8aef6518907b9b4088976`. The expressly approved one-time anchor override was consumed for that first commit only. Runtime branches were not merged or deployed.

Fetched continuation `027e298331fd74090688f062c7ff4c6b58008434`; verified growth archive SHA-256 `1025891bf0e009c274f571da51b050928c3999594b2beb72e12f38a966b1ee86` and all five source entries before integrating. The handoff branch was read, not merged. The scope remains discover → learn → transfer → correct, with tool reuse a subcase.

## Actual wiring and affected callers

The existing `runHerCli` now routes `her growth` into the host. Its existing persona/selfmod/task-reconcile/other callers retain their routes. New host methods serve the handed-off driver and explicit CLI, not a production schedule or newly registered agent permission.

- `reason`: existing configured OpenAICompatibleModel/invokeCompletion; frozen provider/model/settings; conservative token/USD reservation before a call; real usage/model identity required; existing monthly audit/cost ledger. Fresh usage on an empty-content exception is now preserved; old metadata cannot settle a new failure. Unknown spend blocks subsequent calls, including after process restart.
- `save`: one proposal Markdown journal in the existing store, storeLock/appendText/writeNewText; durable revision zero and CAS; append-only hash-linked receipts, fail-loud corruption. No parallel task ledger.
- `authorizeProbe/authorizeUse`: exact plan/operation scope, runId/request digest, single-use grant, durable pending binding, active/malformed STOP/drain, AbortSignal, token/USD/wall/process/output limits. Fixed trusted script source copied by digest; generated action is JSON input only, never shell text. Task processes have an empty environment. These boundaries are not an OS sandbox.
- `runProbe`: existing task executor, BgTask records/transitions and actual `.done`/`.log` evidence; execution intent before launch. Existing terminal task transitions retain owner wake events, and organ result events carry inquiry/task refs.
- `review`: final cases frozen before the candidate; each suite consumed once; training/probe input overlap rejected; ordinary model task calls with equal raw experiences for baseline/candidate; existing assessImprovement on independent executor outputs, actual usage costs plus learning overhead, exact methodId/planDigest receipt. Answers/score details are not returned to research prompts. Only trial-ready isolation status is possible.
- `checkApplicability/runUse`: trusted current-environment inspection plus normal model task and independently verified output; exact task/method/run receipt. Active method recall happens in a fresh CLI process; failed/unknown use suspends that version. Explicit `wake` imports real terminal BgTask/done/log evidence, retires old versions, reopens without resetting budget. No autonomous background consumer or multi-method composition is claimed.

All new source files are below 1000 lines. The small route adds 12 lines to the already oversized main CLI; its existing size is baseline debt. No upstream package, dependency, production memory, credentials, schedule or runtime permissions were changed.

## Engineering evidence

Final affected regression: 32 test files, **351 passed / 0 failed, cancelled, skipped or todo**, exit 0 (330800.4739 ms). Includes previous 25-file selfmod/anchor/evidence suite, 37 growth checks, full CLI tests and existing background-task/wakeup/reconcile tests. The handed-off 27 preset-response tests and host model fixtures are engineering evidence only; their prewritten methods/replies cannot establish autonomous learning. Host tests also exercise actual subprocesses, Git/artifacts, restart/CAS, grants, STOP, heldout sealing and failure usage retention.

Full repository `npm run check`: exit 0, `RAYON_NUM_THREADS=1`, same five pre-existing informational diagnostics. One default-thread native Biome crash (-1073741819), a subsequent type-error exit 2, and a 34/37 intermediate test failure are retained. Final pass covers the corrected source. No root npm test/build/full E2E was run.

Commands, complete logs, exact byte hashes and source Git-LF hashes: [growth-evidence/manifest.json](growth-evidence/manifest.json). Historical 228/228 gate repair evidence remains in `evidence/`.

## Actual model experiment — failure retained

Approved configured host model `deepseek-v4-flash` at `api.deepseek.com`; total USD ≤ 2, tokens ≤ 30000, wall clock ≤ 20 minutes. Frozen peak prices use [official DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/): input $0.30/M, output $1.20/M. Costs calculated from real usage are conservative estimates, not provider invoices.

Isolated root `D:/@Her/tmp/growth-live-20261002`. Initial experience is the previously observed Windows Git reader failure, with its actual artifact digest; it is a known engineering failure, not proof of novel discovery. Six owner-run Git/file groundtruth preflights and the transfer/adaptation/counterexample/final-case plan were frozen before model invocation. The trusted operation observes real Git status/text views; it does not supply a scripted model lesson. Applicability uses explicit supported facts and rejects unverifiable preconditions; it is not a generic semantic verifier.

At `2026-10-02T05:00:31.364Z`, initialized rev 0. **One real provider request**, then at `05:00:42.066Z` state rev 2 was **blocked: model returned empty content**, thoughts 1/probes 0. No question/method/probe, real gain review, transfer, adaptation or correction completed. The initial CLI exited 0 because the command returned state; that is **not experiment PASS**. CLI now returns 1 for blocked or pending action outcomes; read-only status still exits 0.

The initial process lost transient completion metadata before it could be persisted. **Actual tokens and USD are unknown**, not zero. Reservation **6877 tokens / $0.0082524** remains unsettled and blocks replay. No additional paid request was made. The later code fix records future fresh failure metadata, but does not reconstruct this lost receipt. The frozen wall budget has not been renewed.

Exact original plan/script/experience/journal and preflight artifacts are under `growth-evidence/live/`; no `.her/config.yaml`, `.env` or credential value is published. Preflight observations and preset tests are not scored as learning.

## Outstanding acceptance

Successful real discover/learn/transfer/correct, independent repeated/model gain measurements, valid provider usage reconciliation for the first call, production adoption, production observation/rollback and Samantha JUDGE are unverified. G-281 still lacks reliable production adoption refs; multi-commit rollback remains manual. Engineering integration does not pay those debts. No automatic merge/deploy or second experiment.

After valid usage reconciliation, continuation needs a fresh owner-approved frozen time window and real provider response; the current expired budget/unknown reservation must not be reset silently. Commit/push receipts are recorded in the Her ledger and final response after normal hooks and live remote SHA verification.
