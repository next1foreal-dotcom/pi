# ORGANS

All organs are pinned to exact git commits or npm versions. Packages in `.pi/settings.json` are project-scoped.

| Organ | Source | Pin | Load status | Notes |
|---|---|---:|---|---|
| pi base | https://github.com/earendil-works/pi.git | dc7b547f628475676acfd00cb0f54df05d42acaf | forked | Fork lives at https://github.com/next1foreal-dotcom/pi with upstream remote set. |
| pi-subagents | git:github.com/nicobailon/pi-subagents | efa7120047eaf76a32620eed0ec7d038b6cfa44e | settings | Memory inheritance must remain append/fork in Her agent markdown. |
| pi-dynamic-workflows | git:github.com/Michaelliv/pi-dynamic-workflows | 31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2 | settings | Phase 6 batch/workflow organ. `her-batch-intake` requires workflow results to be persisted with `her_world_note`. |
| pi-codex-goal | git:github.com/fitchmultz/pi-codex-goal | e1fd927fc8df5b13c3b96e1a23788204b6173c5f | settings | This pin has hidden idle continuations and no public disable flag; Her coordinates by detecting active `pi-codex-goal` entries and suppressing Mirror. |
| pi-agent-browser-native | git:github.com/fitchmultz/pi-agent-browser-native | 6a1e387bcf4e7c11a0a0610a359f2d592a099532 | settings | Strong-login/browser organ. Review config before real credentials. |
| pi-web-access | git:github.com/nicobailon/pi-web-access | 076bf0db5e739b200286ca37486e4edd8d19123c | settings | Main source acquisition organ. |
| pi-powerline-footer | git:github.com/nicobailon/pi-powerline-footer | e34dacc8a9b932e4990db949d473ac01abdb03e1 | settings | Peer range targets pi 0.74-0.76; verify against pi 0.78 before relying on it. |
| context-mode | npm:context-mode | 1.0.162 | settings | Use npm package rather than git source because the pi adapter loads built files. |
| pi-fff | npm:@ff-labs/pi-fff | 0.9.0 | settings | Lexical search organ. |
| pi-skill-selector | npm:@ramarivera/pi-skill-selector | 0.1.16 | settings | Skill selection UX organ. |
| pi-fallback-provider | npm:pi-fallback-provider | 0.0.1 | settings | Provider routing/fallback organ. |
| pi-oracle | npm:pi-oracle | 0.7.5 | settings | External-analysis organ. Its returned analysis must be copied into markdown through Her tools before it becomes durable memory. |
| agent-eval | npm:agent-eval | 0.0.1 | settings | Eval organ placeholder package at this pin; Her keeps repo-local golden tests until a richer eval package is selected. |
| pi-auto-reasoning-tool | npm:@howaboua/pi-auto-reasoning-tool | 0.1.6 | settings | From howaboua-pi-stuff monorepo. |
| pi-codex-conversion | npm:@howaboua/pi-codex-conversion | 1.5.19 | settings | Must append/coordinate prompts with Her injection. |
| pi-explore-subagents | npm:@howaboua/pi-explore-subagents | 0.1.8 | settings | Use only if not redundant with Her explorer agent. |
| pi-semantic-grep | npm:@howaboua/pi-semantic-grep | 0.1.12 | settings | Semantic RRF upgrade path. Derived index only. |
| agent-native-hardening | npm:@howaboua/pi-skill-agent-native-hardening | 0.0.2 | settings | Voice/style skill package. |
| chrome-cdp-skill | npm:@howaboua/pi-skill-chrome-cdp | 0.0.1 | settings | Browser fallback skill. |
| pi-subagent-review | npm:@howaboua/pi-subagent-review | 0.2.2 | settings | Code review organ. |

## W0 workflow capability spike

Decision for Stage 2 T2 and Stage 3: use `pi-dynamic-workflows` for bounded adversarial validation, but do not rely on it as the whole long-running/quarantine/worktree runtime.

What is verified at the pinned `pi-dynamic-workflows` commit:

- Good fit for adversarial validation: scripts expose `agent()`, `parallel()`, `pipeline()`, phases, abort, and JSON-schema structured output. The Her test suite runs a minimal workflow shape: synthesize a CONTEXT candidate, send it to an independent skeptic, and return a keep/drop verdict.
- Child sessions are fresh in-memory Pi sessions. The parent workflow must include enough Her context in each prompt; children must not assume parent conversation context is already present.
- The workflow tool has no persisted resume or `/workflows` manager at this pin. Its README explicitly calls this prototype status out.
- `isolation: "worktree" is prompt-only` in `src/workflow.ts`; it is copied into agent instructions but does not create a git worktree.
- Quarantine is not a runtime permission boundary here. `WorkflowAgent` defaults to standard coding tools via `createCodingTools(cwd)`, so untrusted-source readers are not automatically read-only and must not be allowed to persist Her memory directly.

Selected Her path:

- T2 adversarial CONTEXT checks can use `pi-dynamic-workflows` directly: candidate agent -> skeptic agent -> structured keep/drop result.
- Stage 3 quarantine and heavy intake use parent-only persistence: workflow/subagent results are staging only; the parent turn writes accepted durable notes through `her_world_note`, `her_judgment`, or future Her-only tools.
- For true quarantine, worktree isolation, or resumable long jobs, use `pi-subagents` capabilities or a thin Her orchestrator that spawns restricted children, records state, and resumes deterministically. The first Her-owned long-task base now records durable `goals/*.md` ledgers through `her_goal_start`, `her_goal_checkpoint`, `her_goal_complete`, and `her_goal_list`; it is a state/resume substrate, not a full autonomous runner yet. Do not fake stronger guarantees with `pi-dynamic-workflows` prompt wording alone.

## Growth-loop ownership

owner = TS her-core (`packages/her/src/her-core`).

- `consolidate`, `synthesize`, `approve`, `buildTopicMaps`, `generateIdeas`, context digesting, and context review/keep/revert are owned by the TS Her package in this pi fork.
- Legacy Python adapters may remain only as capture-only transition shims. They must not run scheduled growth maintenance or write `narrative/CONTEXT.md`.
- No Python `schtasks` for `consolidate` or `synthesize` are active on this machine as of 2026-06-04 verification.

## Footer sync status

owner = TS Her extension (`packages/her/src/extension.ts`); renderer = `pi-powerline-footer`.

- Her publishes `her-sync` with `ctx.ui.setStatus()`.
- Project `.pi/settings.json` promotes `her-sync` to a powerline custom item with prefix `Her`.
- The status is computed from the independent `her-memory` git repo: dirty files plus commits ahead of upstream become the pending count, and upstream HEAD commit time is reported as the last successful push signal.
