# REPORT-G270

STATUS: OK

Worktree: `D:\@Her\wt-g270` branch `feat/g270-event-history`. Not pushed.

## 1) Verification

### RED evidence (TDD, before implementation)

Command: `node --import tsx --test packages\her\test\event-history.test.ts packages\her\test\event-history-verify.test.ts packages\her\test\event-history-organs.test.ts`

Exit: 1

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'D:\@Her\wt-g270\packages\her\src\her-core\event-history.ts'
imported from D:\@Her\wt-g270\packages\her\test\event-history-organs.test.ts
...
ℹ tests 3
ℹ pass 0
ℹ fail 3
```

Same MODULE_NOT_FOUND for `event-history.test.ts` and `event-history-verify.test.ts`.

### GREEN (after implementation)

`npx tsgo --noEmit` — exit 0

`npx biome check --write --error-on-warnings .` — exit 0 (5 pre-existing infos in `memory.ts` / `her-core-modules.test.ts`, unsafe template-literal suggestions, not introduced here)

`node --import tsx --test packages\her\test\*.test.ts` — exit 1, counts:

```
ℹ tests 1053
ℹ pass 1046
ℹ fail 5
ℹ skipped 2
```

Fail set is the known worktree-environment five:

- 2x `dispatch.test.ts` `resolvePiCliPath` (missing `packages/coding-agent/dist/cli.js`)
- 3x `organs.test.ts` (`.pi/git/.../pi-dynamic-workflows` and `agent-eval` ENOENT)

Pass 1046 >= 1029. No extra failures.

Focus files (event-history + cedar + organs + verify): all green, including 1000-id monotonicity and 2x200 concurrent append.

`npm run check` as a single script once hit a biome ACCESS_VIOLATION (exit -1073741819) with empty output; retrying biome and the remaining check scripts each exited 0.

## 2) Diff self-description

Done (per v2 spec):

- Unique writer `appendEvent(kind, actor, data?, refs?, root?)` in `packages/her/src/her-core/event-history.ts`: UUIDv7, append+fsync, `retryOnFsContention`, dedicated `audit/event-history.lock`. Missing actor / unknown kind throw, no row.
- Sealed CLI: `her host-event run-start|run-end|restart-planned --runner <enum> --run-id <id> [--ok --exit-code --detail]`. No `--actor`, no arbitrary kind/data. `her events-verify`.
- Host lifecycle: `her-heartbeat.ps1` after circuit gate records run-start, runs events-verify, run-end in finally. Isolated via try/catch (never blocks organs).
- `withOpBracket` writes `organ.round.start/end` (actor = op name, shared `runId`). `syncMemory` writes `organ.sync.start/end` (actor `sync`) and flushes the jsonl into git so porcelain stays clean.
- `appendSelfmodTransition` exported, commented as S5 caller; no fake call site.
- `detectPresumedCrashes`: bracket pairing by actor+runId; organ unmatched start always derived crash; host unmatched start is crash only if a later start exists (first/open run is in progress); `restart_planned` exempts that actor+runId. Derived rows, not written.
- Parser: `corrupt_tail` / `corrupt_line` markers; no crash, no silent skip.
- Prefix probe: `{prefixLength, prefixSha256, lastId}` in `event-history.state.json`. Truncation, mid rewrite, first-line replace, lastId regression all red: non-zero exit, `.her/event-history-alert.json`, `sendTelegramMessage` (injectable sender in tests). Green advances state to new EOF.
- Tool `list_her_events` (kind/since/limit/includeDerived, newest first) registered in `extension.ts` and `governed-tools.ts` as `destructive: false`. Not a write tool.
- Cedar: exec-flag (`node|python|pwsh|powershell` `-c|-e|-enc|-encodedcommand|-command`, `cmd /c`) AND encoding keywords => anchor hit. `extractPathCandidates` adds `jsonl|json`. Named leaves `event-history.jsonl` / `event-history.state.json`. Existing interpreter+her-memory branch unchanged.
- Did not touch `anchors.ts`, `.githooks/`, `pi-package/policies/`.

Deviations:

- `appendEvent` takes optional 5th `root` so organ code does not depend on env. Tests also pass `root` or set `HER_MEMORY_DIR`. No implicit `../her-memory` fallback on the writer (avoids production writes).
- `syncMemory` now commits event-history (a sync round is itself an event). Follow-up commit after `organ.sync.end` so the working tree is not left dirty. `memory-sync` tests for "clean" / "fast-forward only" updated to expect `pushed` when the only local growth is the history file.

Not done (out of v1): `host.restore` writer (kind reserved), pulse organ, hard immutability, C-drive mirror script.

## 3) DECISIONS

| Decision | Why | Confidence |
| --- | --- | --- |
| UUIDv7 = 48-bit unix ms + 12-bit monotonic seq in rand_a + RFC variant, random rand_b; clock rollback holds lastMs | Spec asked ~20-line in-process monotonic ids; lex order matches write order including same-ms | 有把握 |
| Writer 5th arg `root`, else `HER_MEMORY_DIR`, throw if missing | Organ code has a store root; falling back to `../her-memory` could hit production | 有把握 |
| Host presumed crash only when a later `host.run.start` exists for that actor | Satisfies "empty history + first run-start in progress does not false-positive" and "start without end then report" (abandoned run + later start) | 有把握 |
| Organ unmatched `organ.round.start` always derived crash | Test 5 requires synthesize start-without-end to report while consolidate is complete | 有把握 |
| `restart_planned` exempts same actor+runId (or actor-wide if no runId) | Spec: planned restart covers that gap | 有把握 |
| `--detail` cap 200 | Matches op-brackets `errorHead` | 有把握 |
| `listHerEvents` default limit 50 | Spec omitted default | 有把握 |
| Probe missing state = bootstrap from current file | First verify must not red on a fresh history | 有把握 |
| TG via injectable `sendAlert`; CLI always calls `sendTelegramMessage`; send failure does not mask red | Spec: assert send path; live TG env may be absent in tests | 有把握 |
| Sealed CLI + not a pi tool is the host-actor check; no extra secret token | A token in env is spoofable via bash; sealing the CLI removes `--actor` | 没把握 |
| `syncMemory` commits jsonl; flush second commit after end | History belongs in her-memory git (ADR mirror). End is written after the first commit so porcelain tests stay green | 没把握 |
| Actor for sync events = `sync` | Organ name, parallel to consolidate/reingest/synthesize | 有把握 |
| Derived kinds `host.presumed_crash` / `organ.presumed_crash` | ADR names `host.presumed_crash`; organ analogue kept separate | 有把握 |
| Exec-flag list includes `python3`/`py`/`nodejs`/`cmd.exe` | Same interpreter family as the existing her-memory branch | 有把握 |

Unsure items (must not hide): host-process actor attestation beyond sealed CLI; two-commit flush of `organ.sync.end`.

## 4) Commit status

Recorded after commit in section 4b below. Branch `feat/g270-event-history`, not pushed.

## 5) heartbeat.ps1 diff (for human review)

```
function Invoke-HerEventHistorySafe { ... try node her.mjs; swallow errors }
function Complete-HerHostEvent { host-event run-end --runner heartbeat --run-id ... }

# after circuit-open exit:
$script:HistoryRunId = [guid]::NewGuid().ToString()
Invoke-HerEventHistorySafe host-event run-start ...
Invoke-HerEventHistorySafe events-verify
try {
  Assert-HerDailyCostCap   # moved inside try
  ...
} catch {
  $script:HistoryRunOk = $false
  $script:HistoryDetail = $_.Exception.Message
  ...
} finally {
  Complete-HerHostEvent
  # cedar profile restore unchanged
}
```

No UI. No browser runbook.
