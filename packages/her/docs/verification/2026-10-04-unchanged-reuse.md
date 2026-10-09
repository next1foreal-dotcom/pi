# Unchanged method reuse: scoped verification

Status: review candidate, not merge-ready. No integration, deployment, live learning, or task-gain claim.

## Scope and base

- Repository: `next1foreal-dotcom/pi`.
- Target: `her/phase-0-pi-hygiene`, base `a2d72123d94289d53d7336289f0d6102b0b2b25e`.
- The user asked to implement the previously proposed candidate. Publication is limited to an isolated review branch and draft PR.
- Production changes are limited to `growth-experiment/parse.ts` and `growth-experiment/model.ts`.
- An explicit empty `adaptation` array now represents unchanged reuse. Decision, reason, array presence, item validation, and the 32-item bound remain required.
- Selection guidance permits unchanged reuse and rejects invented adaptations. The driver, host, applicability collector, grants, STOP, budgets, executor, and memory are unchanged.

## Actual verification

Linux, Node v22.16.0, TypeScript strip-only execution. GitHub cloning failed with DNS resolution failure. This is a pinned-source subset, not a full checkout.

The original parser, growth model adapter, loop, core model, model-fetch dependency, and existing test file were reconstructed from the connected repository and verified against their Git blob SHAs before execution. Runtime modules are not replaced by stubs. The tests inject scripted model responses and host ports; they do not instantiate the production HerGrowthHost.

| Run | Passed | Failed | Meaning |
| --- | ---: | ---: | --- |
| Original existing growth-experiment suite | 27 | 0 | Baseline regression check |
| New parser + unchanged-reuse tests on original code | 20 | 16 | RED: the parser rejects empty adaptation before downstream checks |
| Existing + both new suites on candidate | 63 | 0 | GREEN, repeated three times |

The 16 RED failures are consequences of the same rejection, not 16 independent production bugs. The three GREEN runs contain 63 distinct tests, not 189 distinct tests. The candidate adds 16 parser cases and 20 real-driver cases.

The driver cases check required applicability and task authorization; missing evidence and host errors; exhausted thought budget; cancellation; pending result non-replay; method/task/run receipt binding; failure/unknown suspension; and concurrent reservation. Host STOP or budget errors are injected to verify propagation, not evidence of production STOP/budget acceptance.

Commands actually run in the pinned subset:

```sh
node --experimental-strip-types --test --test-reporter=tap packages/her/test/growth-experiment.test.ts
node --experimental-strip-types --test --test-reporter=tap packages/her/test/growth-selection.test.ts packages/her/test/growth-unchanged-reuse.test.ts
node --experimental-strip-types --test --test-reporter=tap packages/her/test/growth-selection.test.ts packages/her/test/growth-unchanged-reuse.test.ts packages/her/test/growth-experiment.test.ts
```

All four changed/new TypeScript files also passed `node --experimental-strip-types --check`.

## Integration gates still open

- Full `npm run check`, root type/format checks, and normal local pre-commit hooks were not run. GitHub API publication does not imply local hooks passed.
- The existing `.github/workflows/ci.yml` targets `main` only. Do not retarget this change to `main`, weaken gates, or edit workflow filters merely to obtain a green badge.
- Run the focused tests with the repository's installed `tsx` plus the existing growth-host and growth-applicability suites, then the complete repository check, in a full prepared checkout.
- Windows host behavior, real model selection, live method reuse, and measurable learning gains remain unverified.
- Top-level `Her/BACKLOG.md` is unchanged and no DONE entry was created. Record scoped acceptance there during normal integration; this document is not a substitute for that gate.
- Existing failed/stopped pilots, unknown usage, protected memory, credentials, model configuration, and running processes are untouched. No paid model requests, new permission windows, automatic retry, merge, or deployment.

## Candidate file fingerprints

- `packages/her/src/growth-experiment/parse.ts`: Git blob `949cedd2c8908447e90e1beebeec0d363aae964f`, SHA-256 `4ff9d011efecdbdd30ba2cd4a118458d77e23443cab0e3373a6fe7678aac12b9`.
- `packages/her/src/growth-experiment/model.ts`: Git blob `2819af283b7f56a46e7af4ea11da66c67e1fc4e0`, SHA-256 `ce89743f5d0b6887c3abe1d6890123304add1c7a3ae741ce537452bb70e9ae3e`.
- `packages/her/test/growth-selection.test.ts`: Git blob `71a438026011bd548b5ff8ab63b0c70312619f26`, SHA-256 `3cd5dce848986805999b860bc6ba1d26c6b3b762d346e7cadfac379734e5a6e6`.
- `packages/her/test/growth-unchanged-reuse.test.ts`: Git blob `f9759f397ff29ee126cc3df64f9b8b6ce815febb`, SHA-256 `aedbdc5a9f9c00223064bdb3f48cf5b0b09c6b619b0af4596412f03a21c405ff`.

## Execution log fingerprints

- `combined-green-run2.log`: SHA-256 `bf5cb41acab8fd4e65190e04c8d86ea65f0bdaa4d5f2248c5a3be1fecefa7db3`.
- `combined-green-run3.log`: SHA-256 `22b38aadc89b9ac022740f59f4b85f70a608339173972adafca9b9711dd49fb3`.
- `combined-green.log`: SHA-256 `aeae2f06e8b91d721538bbe00219cb837113269a232589acfcfa7d508535b073`.
- `existing-baseline.log`: SHA-256 `1c05d17d3af0ac42234511db7b25d805e730a50863f05295fea1aced6c265a40`.
- `new-baseline-red.log`: SHA-256 `f996f76bff153f08c7dd7a0840f55eae5f3c1864af446236ebba2a6230797329`.
