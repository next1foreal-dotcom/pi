# G-120 — Background task executor (runner / launch / stop / wake)

> 2026-07-26 · Mechanism appendix A + E stage 2 (+ wake hook from stage 1)

## Delivered

- `task-runner.mjs` — detached watcher; writes `.pid` / `.heartbeat` / `.log` / `.done`
- `task-executor.ts` — `launchTask` / `stopTask` / Windows `.cmd` resolve
- `bg-task-record.ts` / `bg-task-spawn.ts` / `bg-task-reconcile.ts` / `bg-task-output.ts`
- Tools: `her_task_spawn` · `her_task_stop` · `her_task_output` · `her_bg_task_list`
- `before_agent_start` reconciles + injects `<her-task-events>` (handles only)

## Verify

```
cd samantha/packages/her
npx tsx --test test/bg-task-executor.test.ts
```

## Non-goals (later cards)

- Budget / concurrency gates (G-122)
- Telegram / TUI (G-123)
- `her_publish` (G-124)
