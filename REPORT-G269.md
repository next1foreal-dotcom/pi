# REPORT-G269

STATUS: OK

Worktree: `D:\@Her\wt-g269` branch `feat/g269-missed-fire`. Not pushed.

## 1) Verification

### Baseline (before edits)

`npx tsgo --noEmit` — exit 0

`node --import tsx --test packages\her\test\*.test.ts`:

```
ℹ tests 1053
ℹ pass 1046
ℹ fail 5
ℹ skipped 2
```

Known env five: 2x `dispatch.test.ts` resolvePiCliPath, 3x `organs.test.ts` agent-eval / pi-dynamic-workflows ENOENT. `warm-worktree-pool` latency gate was green this run.

### RED evidence (TDD, tests before `missed-fire.ts`)

Command: `node --import tsx --test packages\her\test\missed-fire.test.ts`

Exit: 1

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'D:\@Her\wt-g269\packages\her\src\her-core\missed-fire.ts'
imported from D:\@Her\wt-g269\packages\her\test\missed-fire.test.ts
code: 'ERR_MODULE_NOT_FOUND'
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

### GREEN (after implementation)

`npx tsgo --noEmit` — exit 0

Focus: `packages\her\test\missed-fire.test.ts` + `reflect.test.ts` + `her-core.test.ts` + `choice-model-append.test.ts` + `cli.test.ts` + `event-history.test.ts` — 150/150 pass.

`node --import tsx --test packages\her\test\*.test.ts`:

```
ℹ tests 1067
ℹ pass 1059
ℹ fail 6
ℹ skipped 2
```

Pass 1059 >= baseline 1046. Fail set is the known env five plus `warm-worktree-pool` LATENCY GATE (ratio 0.94, G-272 jitter; preamble: red does not count, do not patch). 14 new missed-fire tests are in the pass count (1053+14=1067 total).

`npx biome check --write --error-on-warnings` on the write-set — exit 0; 4 pre-existing `memory.ts` useTemplate infos, not introduced here.

## 2) Diff + policy=once equivalence

New pure module `packages/her/src/her-core/missed-fire.ts`: `computeMissedFire` on lastRun-anchored grids, G = max(0, floor((now-lastRun)/interval)), GRACE=2h, `all` owed=1 per tick, skip voids via `advanceAnchorTo`.

Wired only at the three threshold mouths:

- `reflect({ ifDue })`
- `choiceModelSynthesizeDue`
- `synthesizeDue` **stale** branch

`synthesizeDue` conflict / new_notes return before missed-fire (no `missed`/`owed`/`policy` on those results). consolidate is not wired (see exemption below).

State: `last_due_check_<op>` written after a terminal decision (not-due or skip-void) and after a successful organ run. New `last_reflect` / `last_choice_model` / `last_synthesize` writes are full ISO; date-only strings still parse as 00:00 UTC.

Config: cadence scalars `missed_fire_reflect` / `missed_fire_choice_model` / `missed_fire_synthesize`, default `once`. Invalid value: warn + once.

Events: `organ.cadence.missed` and `organ.cadence.voided` added to `EVENT_KINDS`; `appendEventBestEffort` with actor = organ name.

**once equivalence:** `owed = min(1, G)` with G>=1 means a single run, same as the old boolean due. After that run, `last_*` stamps now, so the next check is G=0. Existing `synthesizeDue` / `reflect` / `choiceModelSynthesizeDue` tests stayed green. First check after upgrade (no `last_due_check`) treats the latest grid as a normal shift (`missed = max(G-1,0)`), so skip/once/all all fire 1 — same as "it is due, run once".

**Threshold note:** old synthesize stale used `daysSince > N` (due on the N+1 day). Grid G>=1 is due at exactly N days. Default N=10; no existing test sat on that 1-day boundary.

### consolidate exemption

consolidate has no due function and no `--if-due`. It is a cursor drain loop (`last_consolidate` is a cursor timestamp, not a cadence anchor). Out of v2 scope; no missed-fire policy.

## 3) DECISIONS

| Decision | Why | Confidence |
|---|---|---|
| GRACE = 2h constant | Spec | 有把握 |
| Grid anchored on lastRun, not calendar midnight | Spec (G = floor((now-lastRun)/interval)) | 有把握 |
| Reuse `audit/organ-skips.jsonl`; widen organ/reason; add `voided` + `policy` | Shape of ideas/topic-maps skip was too narrow; one ledger, new reason `missed-fire-skip` | 有把握 |
| skip ledger first, then move `last_*` | Spec; appendText throw aborts the anchor move | 有把握 |
| `all` success advances `last_*` by one interval (clamped to now), not to now | Otherwise one successful run would zero G and erase remaining ticks | 有把握 |
| Failed organ run does not move `last_*` / `last_due_check` | Remaining debt recomputes next tick; matches "fail then stop, recount next round" | 有把握 |
| `last_due_check` is not written when due=true before the run | #18: writing then crashing would mark an unrun shift as seen (skip would then miss a live GRACE window) | 有把握 |
| Missing `last_due_check` => latest grid is a live shift | Upgrade path must match current "run once" | 有把握 |
| `appendEventBestEffort` not throwing `appendEvent` | Same as organ.round; cadence must not die if history write fails | 有把握 |
| New kinds registered only in `EVENT_KINDS` | Spec; did not invent a side writer | 有把握 |
| synthesize stale due at G>=1 vs old `daysSince > N` | Followed the G formula; one-day earlier than the old `>` | 没把握 (no boundary test existed) |
| Manual `synthesize()` (no `--if-due`) still uses `nextCadenceAnchorIso(policy)` | Default once => now; `all` + manual would step one interval | 没把握 (all is opt-in) |

## 4) Suggested policy per organ (Fei decides; code defaults stay once)

| Organ | Suggest | One-line judgment |
|---|---|---|
| reflect | **once** | Daily; one missed day should surface at most one recognition pass, not a backlog. |
| choice-model | **once** | 10-day distill; trails accumulate in the files. `all` would rewrite CHOICE-MODEL.md on every later tick. |
| synthesize (stale only) | **once** (alt: skip) | once = pay the one missed weekly narrative (today's behavior, and the 8/9 lock-miss). skip if a catch-up narrative from a hole is worse than waiting for the next clean week. |
| synthesize conflict / new_notes | n/a | Event-driven, not a shift; exempt. |
| consolidate | n/a | Cursor drain, no due mouth; exempt. |

Defaults in config.yaml / DEFAULT_CONFIG remain `once`. This table is not applied.

## 5) Commit

Tree: `D:\@Her\wt-g269` branch `feat/g269-missed-fire` hash `53497d446`. Not pushed.
