# RSI-S0 Decisions

## Selfmod Cedar profile

- Decision: Add a separate `selfmod` profile.
- Why: The existing `default` profile denies every destructive tool. Selfmod must allow writes under the v1 skill prefix while keeping `default` and `heartbeat` behavior unchanged.
- Confidence: confident.

## Repository-relative anchor paths

- Decision: Copy `ANCHOR_PATHS` exactly, supplement runtime matching with `packages/her/src/rsi/anchors.ts`, and treat `packages/her/` as an optional prefix for package-local contract paths.
- Why: Git reports `packages/her/pi-package/policies/...`, while the contract records `pi-package/policies/...`. The task also explicitly requires the runtime anchor list to protect itself.
- Confidence: confident.

## Existing hook chain

- Decision: Call `.githooks/anchor-path-gate.ts` from the existing Husky pre-commit hook.
- Why: `core.hooksPath` already points at Husky. Chaining preserves all existing lockfile, formatting, type, and browser checks.
- Confidence: confident.

## Audit destination

- Decision: Let `appendAuditLog` accept an optional memory directory and pass the selfmod request directory explicitly.
- Why: Runtime callers keep the existing environment-based default, while selfmod tests and isolated runs write DENY evidence to their actual memory store without mutating process-wide environment state.
- Confidence: confident.

## Environment example location

- Decision: Create the previously absent `.env.example` at the repository root.
- Why: The root `.gitignore` already documents a repository-level environment example, and no package-level example exists.
- Confidence: confident.

## Uncertain decisions

None.
