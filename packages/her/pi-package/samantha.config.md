# Samantha Body Config

Code repo: `D:/@Her/samantha`

Memory root: `HER_MEMORY_DIR`, defaulting to `D:/@Her/her-memory` when launched from the fork root.

Project-local pi settings: `.pi/settings.json`

Project-local Her extension: `.pi/extensions/her/index.ts`

Additive Her package: `packages/her`

Third-party organs are pinned in `packages/her/ORGANS.md`.

Current status:

- Her extension loads from `packages/her/src/extension.ts`.
- Provider pool is registered with environment-backed credentials only.
- CONTEXT/FACTS/SAMANTHA/CHOICE-MODEL injection, turn capture, durable recall, remember, world-note, judgment, and memory-status tools are wired.
- `/her-intake` is the rich conversational intake path.
- `her-batch-intake` uses the workflow organ for multi-source fan-out, requires claim-ledger verification through `claim-verifier`, and keeps final persistence in the parent trusted Her writer.
- Her long-task state is durable in `goals/*.md` via `her_goal_start`, `her_goal_checkpoint`, `her_goal_complete`, and `her_goal_list`; this is the resume substrate for Stage 4, not a claim that unattended autonomous running is finished.
- Mirror is active and suppresses itself when an active `pi-codex-goal` entry owns the next continuation.
- `pi-oracle` may be used for external analysis, but returned analysis is not durable until written through Her memory tools.
- `agent-eval@0.0.1` is pinned as a placeholder; current critical eval coverage is repo-local node tests.
