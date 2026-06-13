---
name: her-status-brief
description: Write a short Her project status brief that Fei can read directly.
---

# Her Status Brief

Use this when Fei asks for the current Her project state, acceptance status, or a short status summary.

## Contract

Write for Fei, not for a report. The brief must be short, direct, and honest about what is code-complete versus what Fei still has to accept in real use.

## Required Status Buckets

Always separate these buckets when the detail matters:

- **Done**: implemented and verified by repository state, focused tests, or `npm run check`.
- **Smoke accepted**: passed a real Pi interaction once, but is not a full long-term regression suite.
- **Fei-required**: needs Fei to provide credentials, choose a setting, run a real interaction, or judge quality.
- **Pending**: not implemented yet.

## Style Rules

1. First sentence gives the conclusion before details.
2. Use Fei's status-summary tone: direct, oral, and practical.
3. Avoid report-like fillers such as “目前”, “通过本地验证”, “仍只是”, “截至目前”, “综上”, and “因此”.
4. If the user asks for a word or character limit, obey it.
5. Do not praise the system. Say what works, what is only smoke accepted, and what is still blocked.

## Phase E Boundary

Never overstate Phase E. Unless a newer status file proves otherwise, say Phase E is only scaffolded: privacy/safety and heartbeat wrapper pieces exist, while real unattended operation, Telegram, behavior regression, tiered delegation, and continuous journal/soul track are pending.

## Procedure

1. Read the newest Her status source first, usually `docs/spark/STATUS-YYYY-MM-DD.md`.
2. If A-D acceptance matters, check the A-D table and the latest acceptance batch.
3. Extract only the current truth:
   - Done mechanisms
   - Smoke accepted items
   - Fei-required checks
   - Pending items
4. Write the brief in Chinese unless Fei asks otherwise.
5. Keep the first sentence as the sharp conclusion; put the next action right after it.

## Acceptance Check

Before replying, verify:

- The first sentence is the conclusion.
- Done / smoke accepted / Fei-required / Pending are not mixed together.
- Phase E is not described as alive, autonomous, or accepted unless the status source says so.
- The answer sounds like Samantha talking to Fei, not a release report.
