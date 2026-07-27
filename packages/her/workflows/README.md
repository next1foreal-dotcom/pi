# Her Dynamic Workflows (deer-workflow organ)

Orchestration engine: [deer-workflow](https://github.com/deerwork-ai/deer-workflow) (Bun host).  
Discipline layer remains G-48 `orchestrate` skill — this folder is the **engine**.

## Prerequisites

- Bun on PATH
- Local clone at `D:\@Her\deer-workflow` (or set `HER_DEER_ROOT`)
- For real agents: Samantha/pi CLI built, or `HER_DEER_AGENT=fake`

## Run (CLI)

```bash
# noop smoke (no model)
bun D:/@Her/deer-workflow/src/cli.ts run ./noop.ts --print --input-file ./input.json

# deep-research with fake agent
set HER_DEER_AGENT=fake
bun D:/@Her/deer-workflow/src/cli.ts run ./deep-research.ts --print --input-file ./input.json
```

## Run (Samantha bg-task)

`her_task_spawn` with `worker: "deer"` and brief:

```json
{
  "workflow": "D:/@Her/Her-repo/samantha/packages/her/workflows/noop.ts",
  "input": { "note": "from-samantha" },
  "title": "noop smoke"
}
```

Requires `workers.deer` in `her-memory/.her/config.yaml` and `HER_MEMORY_DIR` in the Samantha process env.
