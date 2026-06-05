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
- Mirror is active and suppresses itself when an active `pi-codex-goal` entry owns the next continuation.
- `pi-oracle` may be used for external analysis, but returned analysis is not durable until written through Her memory tools.
- `agent-eval@0.0.1` is pinned as a placeholder; current critical eval coverage is repo-local node tests.
