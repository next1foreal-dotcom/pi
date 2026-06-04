# PATCHES

## coding-agent compact hook customInstructions

- Files:
  - `packages/coding-agent/src/core/extensions/types.ts`
  - `packages/coding-agent/src/core/agent-session.ts`
- Reason: `session_before_tree` already supports `customInstructions`, but `session_before_compact`
  only allowed cancel/full custom compaction. Her needs a compact-time guard for pinned memory
  context without replacing the whole compaction implementation.
- Scope: generic extension seam. `session_before_compact` results may append or replace
  `customInstructions`; manual and auto compaction both pass the merged instructions into the
  existing default compactor.
