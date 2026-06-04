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
- `before_agent_start` injects `CONTEXT.md` and `FACTS.md` from `HER_MEMORY_DIR`.
- `turn_end` captures raw episodes into `her-memory/episodic/raw`.
- `her_sync` commits and pushes dirty memory; capture schedules the same sync after `HER_SYNC_DEBOUNCE_MS` (default 5 minutes).
- `her-sync` is published through `ctx.ui.setStatus()` and promoted by `pi-powerline-footer` as the Her memory sync indicator.
- `synthesize()` autonomously writes `CONTEXT.md` through a reviewable git-backed `context-log.md`; `FACTS.md` remains read-only to the growth loop.
- Tools are registered for recall, remember, world notes, judgments, memory status, idea capture, and context review/keep/revert.
- Context digest follow-ups report due unreviewed context changes before Mirror, and both suppress themselves while `pi-codex-goal` owns an active continuation.
- `/her-intake <url-or-path>` is a slash prompt for the Stage 2 minimal chain: `fetch_content` -> `her_world_note` or `her_remember` -> `her_recall` verification. `her-batch-intake` coordinates multi-source workflow fan-out.
- Her project subagents live in `.pi/agents` and mirror `pi-package/agents`; they must use append/fork context inheritance.
- Phase 7 migration keeps legacy Python capture adapters and the TS pi extension writing the same independent `D:/@Her/her-memory` git repo; all growth writes belong to TS.

Verification:

```
node --import tsx --test packages\her\test\*.test.ts
npm run check
```
