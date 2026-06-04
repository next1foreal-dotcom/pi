# Her Package

This package is the additive home for Samantha-specific code inside the pi fork.

Rules:

- Her code lives under `packages/her/**` and project-local `.pi/**` entries.
- Core pi packages remain upstream-owned and are not edited for Her behavior.
- Durable memory remains outside this code repo in `D:/@Her/her-memory`.
- `packages/her/PATCHES.md` must stay empty unless a generic upstream seam is unavoidable.

Current status:

- Provider pool registration is wired for Claude, GPT/Codex, relay, DeepSeek, and local OpenAI-compatible providers.
- Capture summaries use the first configured OpenAI-compatible summary model:
  `HER_SUMMARY_BASE_URL` + `HER_SUMMARY_MODEL` + `HER_SUMMARY_API_KEY`/`HER_LLM_API_KEY`, then relay, DeepSeek, then local.
- `before_agent_start` injects `CONTEXT.md` and `FACTS.md` from `HER_MEMORY_DIR`.
- `turn_end` captures raw episodes into `her-memory/episodic/raw`.
- Tools are registered for recall, remember, world notes, judgments, memory status, and idea capture.
- `/her-intake` handles single-source Universal Inbox work; `her-batch-intake` coordinates multi-source workflow fan-out.
- Her project subagents live in `.pi/agents` and mirror `pi-package/agents`; they must use append/fork context inheritance.
- Mirror can surface a memory on idle and suppresses itself while `pi-codex-goal` owns an active continuation.
- Phase 7 migration keeps Python adapters and the TS pi extension writing the same independent `D:/@Her/her-memory` git repo.

Verification:

```
node --import tsx --test packages\her\test\*.test.ts
npm run check
```
