# Her Package

This package is the additive home for Samantha-specific code inside the pi fork.

Rules:

- Her code lives under `packages/her/**` and project-local `.pi/**` entries.
- Core pi packages remain upstream-owned and are not edited for Her behavior.
- Durable memory remains outside this code repo in `D:/@Her/her-memory`.
- `packages/her/PATCHES.md` must stay empty unless a generic upstream seam is unavoidable.
- Growth-loop owner = TS `packages/her/src/her-core`. Python adapters, if kept, are capture-only and must not run
  `consolidate`, `synthesize`, `approve`, topic maps, or idea generation against `her-memory`.

Cache discipline (2026-07-23, distilled from earendil.com/posts/prompt-caching — prompt prefixes are
KV-cache keys; changing an early token re-bills the whole session):

- **C1. Frozen prefix.** Memory blocks injected into the system prompt (CONTEXT/FACTS/SOUL/SAMANTHA/
  CHOICE-MODEL via `composeSystemPrompt`) must be stable within a session: pin the injected content at
  session start; mid-session memory updates take effect next session or are appended as late messages,
  never rewritten into the prefix. *Enforcement:* prefix-stability characterization test in
  `packages/her/test`, to land together with the session-pinning fix (KNOWN VIOLATION as of 2026-07-23:
  `before_agent_start` re-reads memory every agent run — see extension.ts:673). Until then: distill scan.
- **C2. Memory append-only on the wire.** Episodic/semantic memory files are append-only from the
  agent loop's perspective; rewrites happen only through governed synthesize/consolidate paths with
  reviewable logs. *Enforcement:* pre-commit gate in the `her-memory` repo rejecting modifications or
  deletions under `episodic/raw` (additions only) — follow-up, must be tested dual-machine before
  activation so it cannot block live `her_sync`. Until then: distill scan.
- **C3. Consolidation runs in idle windows.** `synthesize`/`consolidate`/compaction are cache resets;
  schedule them after idle gaps longer than the provider cache TTL (the cache is already cold, the
  rewrite is free) — never mid-conversation. *Enforcement:* not machine-judgeable; distill periodic scan.

Current status:

- Provider pool registration is wired for Claude Pro/Max OAuth, ChatGPT Pro/Codex OAuth, Claude API-key, GPT/Codex API-key, relay, DeepSeek, and local OpenAI-compatible providers.
- Capture summaries use the first configured OpenAI-compatible summary model:
  `HER_SUMMARY_BASE_URL` + `HER_SUMMARY_MODEL` + `HER_SUMMARY_API_KEY`/`HER_LLM_API_KEY`, then relay, DeepSeek, then local.
- `before_agent_start` injects `CONTEXT.md`, `FACTS.md`, `SOUL.md`, `SAMANTHA.md`, and `CHOICE-MODEL.md` from `HER_MEMORY_DIR`.
- `turn_end` captures raw episodes into `her-memory/episodic/raw`.
- `her_sync` commits and pushes dirty memory; capture schedules the same sync after `HER_SYNC_DEBOUNCE_MS` (default 5 minutes).
- `her-sync` is published through `ctx.ui.setStatus()` and promoted by `pi-powerline-footer` as the Her memory sync indicator; `sync --status` reports pending local memory count plus the upstream HEAD time as the last successful push signal.
- `recall()` and Mirror `surface()` use Reciprocal Rank Fusion over three rebuildable signals: in-memory SQLite FTS5, an injectable OpenAI-compatible embedding backend, and entity/path/title matching. If FTS5 is unavailable, Her degrades to lexical-only ranking. Set `HER_EMBEDDINGS_BASE_URL` + `HER_EMBEDDINGS_MODEL` (optional `HER_EMBEDDINGS_API_KEY`) to add the embedding signal. The `@howaboua/pi-semantic-grep` organ remains pinned for repo-local embedding indexes.
- `packages/her/src/cli.ts` exposes the same sync surface for operators:
  `node --import tsx packages/her/src/cli.ts sync --status` or `node packages/her/bin/her.mjs sync --status`.
- The same CLI exposes the governed archive sweep:
  `node packages/her/bin/her.mjs decay --older-than-days 180 --json`.
- Restore archived semantic notes explicitly:
  `node packages/her/bin/her.mjs restore --semantic <note-key> --json`.
- `synthesize()` autonomously writes `CONTEXT.md` through a reviewable git-backed `context-log.md`; `FACTS.md` remains read-only to the growth loop.
- `synthesizeDue()` gates narrative proposals on configured semantic-note volume, new conflict relations, or stale `last_synthesize`.
- `SOUL.md` is Samantha's stable voice/persona seed. It is injected every turn but remains separate from ground-truth `FACTS.md`.
- `synthesizeSelfNarrative()` distills becoming moments and recognitions into `SAMANTHA.md` with a traceable log commit.
- `synthesizeChoiceModel()` distills world-note Judgment Trails into `CHOICE-MODEL.md` with a traceable log commit.
- The CLI exposes growth-loop maintenance commands: `consolidate`, `synthesize`, `synthesize-due`, `approve`, `topic-maps`, `ideas`, `choice-model`, and `self-narrative`.
- `decaySweep()` moves old `tier: decay` semantic notes into `archive/semantic`; `tier: exact` is never swept and archive recall is explicit.
- Long-running work has a real Her-owned ledger under `goals/*.md`: use `goal-start`, `goal-next`, `goal-checkpoint`, `goal-complete`, and `goal-list` (or the matching `her_goal_*` tools) to preserve objective, checkpoints, next continuation, completion outcome, and optional durable memory writeback. `goal-next` claims the next active continuation with a lease, so a crashed runner can be resumed after `claim_expires_at`.
- Verified work tasks live under `tasks/{active,done}` and use `her_task_create`, `her_task_update`, and `her_task_list` to enforce authorize/budget/retry/content gates with audit records.
- Proactive scan proposals live under `proposals/scan` and use `her_proposal_record`, `her_proposal_feedback`, `her_proposal_stats`, and `her_proposal_list` to track adoption rate and quiet down after repeated rejections.
- Privacy/provenance guardrails use `privacy/classification.md` as a sidecar ledger for legacy append-only memories. New captures and world notes write `privacy` and `provenance` frontmatter. Use `her_privacy_audit` / `her privacy-audit` and `her_privacy_check` / `her privacy-check` before shared or external output.
- `packages/her/scripts/her-heartbeat.ps1` is the Phase E heartbeat wrapper. It is STOP-aware, supports dry-run, runs privacy audit, optionally runs a configured Pi print-mode command, captures a heartbeat note, and syncs memory. Real unattended Pi execution requires `HER_HEARTBEAT_PI_COMMAND`, `HER_HEARTBEAT_MAX_USD`, and `HER_DAILY_MAX_USD`.
- Tools are registered for recall, remember, world notes, judgments, memory status, Her Zone notes, idea capture, evolution synthesis, and context review/keep/revert.
- `preview_open_review` opens a whitelisted local review page (default Roughdraft) in the samantha-ui preview panel's review view, and `browser_navigate` drives the co-drive live browser through the UI host's control-owner gate. Both call `HER_UI_BASE_URL` (default `http://127.0.0.1:3000`, the samantha-ui dev/start default) and are read-only against the running UI process — see `packages/her/src/preview/tools.ts`.
- Idle Her goal continuations run before context digest and Mirror by sending a pinned `her-goal-continuation` follow-up with `triggerTurn: true`; context digest and Mirror both suppress themselves while `pi-codex-goal` owns an active continuation.
- New stores create Samantha's Her Zone under `samantha/{journal,collection,projects,tools,dreams}` with README files. Her Zone is not injected by default; `samantha/collection/*.md` is only surfaced to the Idea Engine as a loose upstream for connections.
- `/her-intake <url-or-path>` is a slash prompt for the Stage 2 minimal chain: `fetch_content` -> `her_intake_source`/`her_world_note` or `her_remember` -> recall verification. `deep-reader` stays quarantined from memory writes; `claim-verifier` checks claim ledgers; `her-batch-intake` coordinates multi-source workflow fan-out before the parent trusted writer persists memory.
- `her intake-url --url <url>` reads ordinary article/text URLs, GitHub repository URLs, and arXiv paper metadata/abstracts. Repo intake uses GitHub metadata/tree/raw file reads, records the actual files and code symbols read, and marks weak coverage as `needs_deep_read`. `intake-source` and `intake-url` accept `--update-surfaces` to immediately refresh topic maps and idea candidates after the world note is written.
- X/Twitter status URLs, video URLs, PDFs, and EPUBs are not pretended-read by the minimal URL intake; they are saved as `needs_deep_read` stubs until a browser-native, transcript, PDF, or EPUB reader can produce honest coverage.
- World notes now require a `memoryStatusReason` when they are written as `archive_only` or `needs_deep_read`; the CLI also exposes `judgment` and `memory-status` so GUI/RPC shells can update Judgment Trail and status through TS her-core instead of editing markdown by hand.
- Her project subagents live in `.pi/agents` and mirror `pi-package/agents`; they must use append/fork context inheritance.
- Phase 7 migration keeps legacy Python capture adapters and the TS pi extension writing the same independent `D:/@Her/her-memory` git repo; all growth writes belong to TS.

Verification:

```
node --import tsx --test packages\her\test\cli.test.ts
node --import tsx --test packages\her\test\*.test.ts
npm run check
```
