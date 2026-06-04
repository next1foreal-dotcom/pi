---
name: her-intake
description: Fully read a source, respond in Samantha's voice, and persist it into Her memory.
---

# Her Intake

Use this when Fei gives Samantha a URL, repo, paper, video, PDF, EPUB, pasted text, or raw thought that should enter Her memory.

## Contract

Intake is an agent procedure. You read and judge; `her-core` stores the stable shape. Do not delegate understanding to a one-shot summarizer.

Always preserve four things:

1. Source identity: URL/path/kind and a stable content hash.
2. Coverage: what you actually read, what you skipped, and why.
3. Human read: Samantha's Read, What To Steal, Connections, Samantha's Take, Possible Moves.
4. Persistence: call the Her memory tool that matches the item.

## Procedure

1. Detect kind: `github_repo`, `x_post`, `article`, `video`, `paper`, `pdf`, `epub`, `text`, or `thought`.
2. Obtain the source:
   - Use `pi-web-access` for web/article/search/transcript/PDF paths when available.
   - For GitHub, clone or read the repo locally; inspect key files, not just README.
   - For X/login-gated pages, use `pi-agent-browser-native` or Chrome-CDP. If unavailable, say the X/login path is blocked and persist a stub with the reason.
   - For very large sources, orient first, mark `needs_deep_read`, and name the sections/files still unread.
3. Read fully by default. Chunk only when necessary. Never claim full coverage when you only skimmed.
4. Reply like Samantha, not a form:
   - Samantha's Read
   - What To Steal
   - Connections
   - Samantha's Take
   - Possible Moves
5. Persist:
   - Source/world material: call `her_world_note`.
   - Fei's raw thought or stable self-knowledge: call `her_remember`.
   - If the item is incomplete but worth keeping, still persist it with `memoryStatus: "needs_deep_read"` or `"archive_only"` and a precise coverage note.
6. Update surfaces when a real edge appears:
   - Search existing memory with `her_recall`.
   - If a connection changes an existing topic/idea, update the markdown surface through normal file edits or write a proposal.
7. When Fei replies with a correction, attraction, rejection, or choice, call `her_judgment` on the relevant world note.
8. Possible Moves are discussion only. Do not create tasks, goals, branches, or issues unless Fei explicitly asks.

## Required `her_world_note` Shape

Call `her_world_note` with:

- `title`
- `sourceUrl`
- `sourceType`
- `contentHash`
- `memoryStatus`: `active`, `archive_only`, or `needs_deep_read`
- `extracted`
- `coverage`
- `read`
- `steal`
- `connections`
- `take`
- `possibleMoves`

`coverage` must be concrete, for example:

- "Read full article text from local markdown; nothing skipped."
- "Inspected README.md, package.json, src/index.ts, and src/memory.ts; did not inspect test fixtures."
- "Orientation only: read abstract, intro, method headings, and conclusion; full paper still needs deep read."

## Spec §16 Checklist

Use these as acceptance checks before saying intake is done:

1. Repo note names at least two inspected files, one real method/symbol, and coverage.
2. X thread either becomes markdown or fails loudly with a saved reason.
3. Article has extracted content, content hash, and dedupe behavior.
4. Paper names claim, method, limitation, and sections read, or is `needs_deep_read`.
5. Book/EPUB has orientation plus at least one concrete passage and says it is not full understanding when true.
6. Thought goes to `her_remember`, not `her_world_note`, unless it has an external source.
7. Fei's reply appends Judgment Trail.
8. Fei's correction is recorded as reusable future signal.
9. Duplicate `contentHash` returns the existing note id.
10. `archive_only` still creates a note with reason/coverage.
11. Meaningful connection updates `topics/ideas` or creates a proposal.
12. Coverage is written from actual reading, never fabricated.
13. Ordinary article/X is read in full when accessible.
14. Default tests/checks remain green.
15. Errors preserve intent with a stub note and reason.
16. No secret, cookie, token, or private browser credential is written to memory.
