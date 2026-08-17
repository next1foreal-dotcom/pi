# REPORT-G271 — reversibility base (snapshot/restore/verify)

STATUS: OK

Worktree: `D:\@Her\wt-g271` branch `feat/g271-reversibility-base`. Not pushed. Not merged.

## 1) Verification

### Baseline (before implementation)

- `npx tsgo --noEmit` exit 0
- `node --import tsx --test packages/her/test/*.test.ts` → tests 1053 / pass 1045 / fail 6 / skipped 2
- Fail set: 2× `dispatch.test` resolvePiCliPath; 3× `organs.test` (Phase 6 / W0 / agent-eval pin); 1× `warm-worktree-pool` latency gate (G-272 jitter). Matches preamble known set. Did not change those files.

### RED (TDD, required)

`node --import tsx --test packages/her/test/snapshot-history.test.ts packages/her/test/snapshot.test.ts`

- tests 15 / pass 0 / fail 15
- Assertion: `unknown Her command: snapshot-create` (manifest + history-exemption tests first)

### GREEN (focus tests)

Same command after implementation: tests 15 / pass 15 / fail 0

### Delivery gates

- `npm run check` exit 0 (tsgo 0). Five pre-existing biome *infos* in `memory.ts` / `her-core-modules.test.ts` (not this card; unsafe template-literal suggestions skipped).
- Full her suite: tests 1068 / pass 1061 / fail 5 / skipped 2
  - +15 tests vs baseline 1053
  - fail set is a subset of baseline (warm-worktree-pool latency gate was green this run; not touched)
  - pass 1061 ≥ baseline 1045

## 2) Drills

### a) Fixture full cycle

Temp fake tree (initStore + nested file + taste-media + `.her/lock` + fake `.git` + two pre-snapshot events).

```
CREATE
snapshot: C:\Users\Admin\AppData\Local\Temp\her-g271-drilla-snap-cWbxpx\2026-08-17T18-15-55Z
files: 27
bytes: 3646
VERIFY_AFTER_CORRUPT code=1
missing: episodic/raw/note.txt
changed: narrative/SOUL.md
extra: extra-added.txt
CREATE_GOOD
snapshot: C:\Users\Admin\AppData\Local\Temp\her-g271-drilla-snap-cWbxpx\2026-08-17T18-15-56Z
files: 27
bytes: 3646
RESTORE
restored: C:\Users\Admin\AppData\Local\Temp\her-g271-drilla-src-c3Tq21
VERIFY_AFTER_RESTORE code=0
snapshot-verify: ok
HISTORY_OK events=5 last=host.restore
DRILL_A_OK
```

`snapshot-verify` checks snapshot `tree/` vs `manifest.json`, not the live source. Corrupt-three-ways was applied to snapshot tree (verify red). Restore used a second intact snapshot of the still-good source after mutating the source note and appending two post events. Note bytes restored; history kept pre+post ids; tail `host.restore`.

### b) Production her-memory, read-only source

`FEI_RESTORE_CONFIRM` unset. `HER_SNAPSHOT_DIR` unset (default `E:\Her-backup\her-memory-snapshots`). Restore target = fresh temp dir, never production.

Create (dir mtime 18:17:35Z → manifest 18:29 local ≈ 12 min):

- snapshot: `E:\Her-backup\her-memory-snapshots\2026-08-17T18-17-35Z` (left in place)
- files: 20027
- totalBytes: 1810519111 (~1.81 GiB)
- herMemoryGitHead: `16a7454806cd99ed43360f5b62ee88a949bc68ad`
- excluded: `.her/snapshot.lock`, `taste-media`
- skippedReparse: 0
- external: all five present (paths + truncated sha256 only; no file bodies in this report)

Verify/restore via `runHerCli` (no `--external`):

```
VERIFY1_EXIT=0 VERIFY1_MS=77131
snapshot-verify: ok
TARGET=C:\Users\Admin\AppData\Local\Temp\her-g271-drill-b-restore-FABmGM
RESTORE_EXIT=0 RESTORE_MS=18090
VERIFY2_EXIT=0 VERIFY2_MS=9927
snapshot-verify: ok
```

Restored temp tree has `.her/` and `audit/event-history.jsonl`. Production `.her/snapshot.lock` absent after create. PowerShell recurse file count on restore target: 20029 vs manifest 20027 (two extras; likely runtime lock/tmp — not production).

A first create attempt was killed by PowerShell treating node stderr as terminating, leaving a stale `snapshot.lock` (pid 59388, dead). Removed that lock, then create completed. Residual: lock has no stale timeout (spec: exists ⇒ refuse).

## 3) Diff

New:

- `packages/her/src/her-core/snapshot.ts` and split modules (`-types`, `-paths`, `-fs`, `-create`, `-verify`, `-history`, `-restore`)
- `packages/her/src/cli/snapshot.ts`
- `packages/her/test/snapshot.test.ts`, `snapshot-history.test.ts`

Additive only:

- `packages/her/src/cli.ts` — intercept `snapshot-create|restore|verify` before `parseArgs` (same pattern as `host-event`)
- `packages/her/src/cli/render.ts` — three usage lines

Did not touch: `anchors.ts`, `.githooks/`, `pi-package/policies/`, `ops/scheduled/*`, G-269/G-270 write sets, production `her-memory` except the dedicated snapshot lock during create (released).

CLI: `her snapshot-create [--same-volume-ok]`, `her snapshot-verify <snapshot>`, `her snapshot-restore <snapshot> <target> [--external]`.

## 4) DECISIONS

| Decision | Why | Confidence |
|---|---|---|
| Hash concurrency 8 | Spec flagged 6500+ file hash cost; 20k-file verify was 77s then 10s cached. No extra deps. | 0.75 |
| `\\?\` only at fs call boundary | `path.join` + long prefix is unsafe; resolve first then prefix. | 0.9 |
| Reparse = `lstat.isSymbolicLink` or win32 dir `readlink` success | Covers `fs.symlink(..., "junction")`; other reparse tags may slip. Test 8 green. | 0.7 |
| Empty dirs not in manifest; extras rmdir recursive | Spec lists files+sha256. Empty `archive/semantic` from initStore made Windows `rm` EISDIR; fixed with `recursive: true` only when dir empty. | 0.8 |
| History overlay skip if dest exists; copy if missing | Spec: aside + exclude overlay/delete; missing dest takes snapshot copy then append. | 0.9 |
| Same-id merge keeps current row | Union by id; identical ids should match. | 0.85 |
| `HER_SNAPSHOT_EXTERNAL` JSON override | Tests need a missing external without touching real `.env`/`auth.json`. Unset ⇒ production list. | 0.85 |
| `snapshot-verify` = snapshot tree vs manifest | Matches CLI arity. Drill a therefore cannot corrupt the snapshot and then restore original from that same tree. | 0.9 |
| Snapshot lock: no stale TTL | Spec: exists ⇒ refuse. Crashed create leaves lock (happened once). | 0.7 |
| Pre-restore snapshot only when target realpath is live | `--external` to a temp target should not snapshot production. Live+confirm path untested against production (confirm never set). | 0.8 |

Not sure / residual:

- Python collectors ignore TS locks; live snapshot may catch half-written capture files. Fixture unaffected. True-body create used verify-green as the consistency bar.
- Snapshot dirs contain `.env` / `auth.json` copies. Treat `E:\Her-backup\her-memory-snapshots\` as secret. This report has paths and truncated hashes only.
- No automatic stale-lock reclaim.
- Windows reparse tags that are neither symlink nor readlink-able.
- Restore file count 20029 vs 20027 unexplained extras on the temp tree.

## 5) Commit

Branch `feat/g271-reversibility-base`, not pushed. Hash `29ab3423a` (`29ab3423a0908882357bd5c295643a5b06e84b2f`).
