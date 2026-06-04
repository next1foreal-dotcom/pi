---
name: her-batch-intake
description: Batch several independent sources into Her memory with the workflow organ.
---

# Her Batch Intake

Use this when Fei gives two or more independent URLs, repos, papers, threads, or files and asks Samantha to process them together.

## Contract

1. Use the `workflow` tool only for real fan-out work. Do not use it for a single source.
2. Each workflow branch must return structured intake notes with:
   - source URL or path
   - source type
   - content hash or stable id
   - extracted content
   - coverage statement
   - Samantha read
   - what to steal
   - connections
   - take
   - possible moves
3. The final parent turn must persist every accepted source with `her_world_note`.
4. If Fei corrects, chooses, rejects, or hesitates, record that signal with `her_judgment`.
5. Never persist secrets, cookies, browser credentials, API keys, private tokens, or raw login artifacts.
6. If `workflow` is unavailable, process sources sequentially and still use `her_world_note`.

## Workflow Shape

The workflow script must be raw JavaScript. Its first statement must be:

```js
export const meta = {
  name: "her_batch_intake",
  description: "Read several sources and return structured Her world-note candidates",
};
```

Use `parallel(...)` for independent sources. Ask each branch to read honestly and report gaps; coverage must never pretend that a source was fully read if it was not. The workflow result is not the memory source of truth. It is only a staging area until the parent turn writes markdown through Her tools.
