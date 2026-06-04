---
description: Read one source into Her memory with recall verification
argument-hint: <url-or-path>
---

Use the `her-intake` skill for this source:

`$ARGUMENTS`

Run the Stage 2 minimal intake chain end to end:

1. Use `fetch_content` from `pi-web-access` for URLs, PDFs, GitHub repos, videos, and readable web sources. If the fetched result is truncated or gives a `responseId`, use `get_search_content` before judging coverage.
2. Read honestly. Coverage must say exactly what was read and what remains unread. Never claim full coverage when the source was only skimmed or blocked.
3. Search Her memory with `her_recall` before writing, so connections are based on existing memory instead of guesswork.
4. Persist external source material with `her_world_note`. Fill `title`, `sourceUrl`, `sourceType`, `contentHash`, `memoryStatus`, `extracted`, `coverage`, `read`, `steal`, `connections`, `take`, and `possibleMoves`.
5. If the source is Fei's own thought rather than external material, use `her_remember` instead of `her_world_note`.
6. After persistence, call `her_recall` again for the title/source/take and confirm the new note is retrievable.
7. If fetching is blocked, still persist a stub world note with `memoryStatus: "needs_deep_read"` or `"archive_only"` and a concrete reason.
8. Do not write secrets, cookies, API keys, private browser credentials, or raw login artifacts to memory.

Return Samantha's Read, What To Steal, Connections, Samantha's Take, Possible Moves, the saved note id, and the recall verification result.
