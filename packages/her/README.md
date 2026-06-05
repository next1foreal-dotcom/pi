# Her Package

This package is the additive home for Samantha-specific code inside the pi fork.

Rules:

- Her code lives under `packages/her/**` and project-local `.pi/**` entries.
- Core pi packages remain upstream-owned and are not edited for Her behavior.
- Durable memory remains outside this code repo in `D:/@Her/her-memory`.
- `packages/her/PATCHES.md` must stay empty unless a generic upstream seam is unavoidable.
- Growth-loop owner = TS `packages/her/src/her-core`. Python adapters, if kept, are capture-only and must not run
  `consolidate`, `synthesize`, `approve`, topic maps, or idea generation against `her-memory`.

Current status:

- Provider pool registration is wired for Claude Pro/Max OAuth, ChatGPT Pro/Codex OAuth, Claude API-key, GPT/Codex API-key, relay, DeepSeek, and local OpenAI-compatible providers.
- Capture summaries use the first configured OpenAI-compatible summary model:
  `HER_SUMMARY_BASE_URL` + `HER_SUMMARY_MODEL` + `HER_SUMMARY_API_KEY`/`HER_LLM_API_KEY`, then relay, DeepSeek, then local.
- `before_agent_start` injects `CONTEXT.md`, `FACTS.md`, `SAMANTHA.md`, and `CHOICE-MODEL.md` from `HER_MEMORY_DIR`.
- `turn_end` captures raw episodes into `her-memory/episodic/raw`.
- `her_sync` commits and pushes dirty memory; capture schedules the same sync after `HER_SYNC_DEBOUNCE_MS` (default 5 minutes).
- `her-sync` is published through `ctx.ui.setStatus()` and promoted by `pi-powerline-footer` as the Her memory sync indicator; `sync --status` reports pending local memory count plus the upstream HEAD time as the last successful push signal.
- `recall()` and Mirror `surface()` use Reciprocal Rank Fusion over lexical search plus an injectable semantic backend. Set `HER_EMBEDDINGS_BASE_URL` + `HER_EMBEDDINGS_MODEL` (optional `HER_EMBEDDINGS_API_KEY`) to add an OpenAI-compatible embedding signal; otherwise Her degrades to lexical-only ranking. The `@howaboua/pi-semantic-grep` organ remains pinned for repo-local embedding indexes.
- `packages/her/src/cli.ts` exposes the same sync surface for operators:
  `node --import tsx packages/her/src/cli.ts sync --status` or `node packages/her/bin/her.mjs sync --status`.
- The same CLI exposes the governed archive sweep:
  `node packages/her/bin/her.mjs decay --older-than-days 180 --json`.
- Restore archived semantic notes explicitly:
  `node packages/her/bin/her.mjs restore --semantic <note-key> --json`.
- `synthesize()` autonomously writes `CONTEXT.md` through a reviewable git-backed `context-log.md`; `FACTS.md` remains read-only to the growth loop.
- `synthesizeDue()` gates narrative proposals on configured semantic-note volume, new conflict relations, or stale `last_synthesize`.
- `synthesizeSelfNarrative()` distills becoming moments and recognitions into `SAMANTHA.md` with a traceable log commit.
- `synthesizeChoiceModel()` distills world-note Judgment Trails into `CHOICE-MODEL.md` with a traceable log commit.
- The CLI exposes growth-loop maintenance commands: `consolidate`, `synthesize`, `synthesize-due`, `approve`, `topic-maps`, `ideas`, `choice-model`, and `self-narrative`.
- `decaySweep()` moves old `tier: decay` semantic notes into `archive/semantic`; `tier: exact` is never swept and archive recall is explicit.
- Long-running work has a real Her-owned ledger under `goals/*.md`: use `goal-start`, `goal-next`, `goal-checkpoint`, `goal-complete`, and `goal-list` (or the matching `her_goal_*` tools) to preserve objective, checkpoints, next continuation, completion outcome, and optional durable memory writeback. `goal-next` claims the next active continuation with a lease, so a crashed runner can be resumed after `claim_expires_at`.
- Tools are registered for recall, remember, world notes, judgments, memory status, idea capture, evolution synthesis, and context review/keep/revert.
- Idle Her goal continuations run before context digest and Mirror by sending a pinned `her-goal-continuation` follow-up with `triggerTurn: true`; context digest and Mirror both suppress themselves while `pi-codex-goal` owns an active continuation.
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
