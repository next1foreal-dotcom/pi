# Her Dynamic Workflows (deer-workflow organ)

Orchestration **engine**: [deer-workflow](https://github.com/deerwork-ai/deer-workflow) (Bun host).  
**Discipline**: G-48 `orchestrate` skill — do not put control flow only in SKILL.md.  
**How to start from Samantha**: skill `deer-workflow` → `her_task_spawn({ worker: "deer", brief })`.

Design: `Her-repo/docs/spark/2026-07-27-her-dynamic-workflow-design.md`.

## Prerequisites

- Bun on PATH
- Local clone at `D:\@Her\deer-workflow` (or `HER_DEER_ROOT`)
- Agents: `HER_DEER_AGENT=samantha` (default) or `fake` for smoke

## Recipes

| File | Phases | Notes |
|---|---|---|
| `noop.ts` | Alpha → Beta | No model; bridge/runner smoke |
| `deep-research.ts` | Plan → Research → Verify → Synthesis | Fan-out + light adversarial verify |
| `map-wire-verify.ts` | Map → Wire → Verify | Coding大活：并行侦察 → 单写手计划 → gate+对抗复核 |

## CLI

```bash
# noop
bun D:/@Her/deer-workflow/src/cli.ts run ./noop.ts --print --input-file ./input.json

# deep-research (fake)
set HER_DEER_AGENT=fake
bun D:/@Her/deer-workflow/src/cli.ts run ./deep-research.ts --print --input-file ./input.json

# map-wire-verify (fake)
bun D:/@Her/deer-workflow/src/cli.ts run ./map-wire-verify.ts --print --input-file ./mwv-input.json
```

## Samantha `her_task_spawn`

```json
{
  "worker": "deer",
  "objective": "Deep research: Dynamic Workflows",
  "brief": "{\"workflow\":\"D:/@Her/Her-repo/samantha/packages/her/workflows/deep-research.ts\",\"input\":{\"question\":\"…\",\"maxAngles\":2},\"title\":\"her-deep-research\"}"
}
```

Coding 大活：

```json
{
  "worker": "deer",
  "objective": "Map-Wire-Verify: …",
  "brief": "{\"workflow\":\"D:/@Her/Her-repo/samantha/packages/her/workflows/map-wire-verify.ts\",\"input\":{\"objective\":\"…\",\"maxLanes\":2,\"verifyHint\":\"npx tsx --test …\"},\"title\":\"her-map-wire-verify\"}"
}
```

Requires `workers.deer` in `her-memory/.her/config.yaml` and `HER_MEMORY_DIR` on the Samantha process.
