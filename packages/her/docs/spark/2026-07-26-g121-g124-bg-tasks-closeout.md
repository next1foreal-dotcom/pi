# G-121…124 — Background tasks + publish closeout

> 2026-07-26

| Card | Delivered |
|---|---|
| G-121 | `truncateLogBuffer` / terminal log head+tail |
| G-122 | `max_concurrent` + daily budget gate on `spawnBgTask` |
| G-123 | Telegram outbox notices + TUI `her-bg` status board |
| G-124 | `her_publish` → `published/<slug>.html` + loopback static server; Studio `GET /api/published` |

Verify: `npx tsx --test test/bg-task-executor.test.ts test/bg-task-g121-g124.test.ts` (14/14)
