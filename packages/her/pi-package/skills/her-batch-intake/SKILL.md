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
   - claim ledger: each material claim with source id, evidence reference, and confidence
   - Samantha read
   - what to steal
   - connections
   - take
   - possible moves
3. For research or synthesis claims, run an independent `claim-verifier` pass over the claim ledger before writing memory. The verifier must classify each claim as `supported`, `contradicted`, or `insufficient_evidence`, with source quality and caveats.
4. The final parent turn is the trusted memory writer. It must persist every accepted source with `her_intake_source` or `her_world_note`; unsupported claims become caveats or `needs_deep_read`, not facts.
5. If Fei corrects, chooses, rejects, or hesitates, record that signal with `her_judgment`.
6. Never persist secrets, cookies, browser credentials, API keys, private tokens, or raw login artifacts.
7. If `workflow` is unavailable, process sources sequentially and still keep reader, verifier, and writer roles separate in the final reasoning before using Her memory tools.

## Workflow Shape

The workflow script must be raw JavaScript. Its first statement must be:

```js
export const meta = {
  name: "her_batch_intake",
  description: "Read several sources and return structured Her world-note candidates",
};
```

Use `parallel(...)` for independent sources. Ask each reader branch to read honestly and report gaps; coverage must never pretend that a source was fully read if it was not. After branches return, build a claim ledger and send it to `claim-verifier` or an equivalent independent verifier branch. The workflow result is not the memory source of truth. It is only a staging area until the parent trusted writer writes markdown through Her tools.
