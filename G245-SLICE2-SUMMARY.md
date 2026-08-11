# G-245 Slice 2 verification

Scope is Slice 2 only: peer-session message delivery, fenced inbox rendering, gated wake accounting, and the existing `before_agent_start` inbox hook. No Slice 3 work was added. `session-roster.ts` and `session-read.ts` were not changed.

Changed files and line counts:

- `packages/her/src/her-core/messages.ts`: 197 lines, new storage/delivery/inbox/wake module.
- `packages/her/src/extension.ts`: 65 added lines for `her_session_send`, governed-tool registration, and inbox injection/archive.
- `packages/her/src/her-core/index.ts`: 15 added export lines.
- `packages/her/test/messages.test.ts`: 301 lines, 11 direct regression tests.

All tests use `mkdtemp` stores and fake session files. The extension smoke uses a fake `sendMessage` that throws if called; it exited successfully, so no real wake was sent. No network or Telegram call was made.

## Ten red-line acceptance results

### C1: non-pi delivery is rejected without a write

Command: `node --experimental-strip-types packages/her/test/messages.test.ts`

Real output:

```text
✔ non-pi targets are rejected for claude, codex, cursor, and archive without writes
```

### C2: sender identity comes from the frontmatter input used by the runtime

Real output:

```text
✔ message identity comes from frontmatter input, not body claims
```

### C3: every inbox body is inside the required untrusted-data fences

Real output:

```text
✔ formatInbox fences injected instructions inside untrusted data
```

### C4: disabled, daily-cap, and USD-cap gates produce no sent wake row

Real output:

```text
✔ maybeWake blocks disabled, daily_cap, and usd_cap without sent rows
```

### C5: batch, timeout, urgent, and single-message threshold behavior

Real output:

```text
✔ maybeWake waits for a batch or timeout, while urgent wakes immediately
✔ a single ordinary fresh message does not wake before batch or timeout
```

### C6: one origin cannot create an echo wake on the return hop

Real output:

```text
✔ same origin does not create an echo wake on the return hop
```

### C7: read messages are moved to `read/` and retained

Real output:

```text
✔ archiveInbox moves read messages into read without unlinking content
```

### C8: delivery writes only the messages store

Real output:

```text
✔ message delivery stays in messages and does not touch forbidden memory paths
```

### C9: malformed frontmatter is skipped without throwing

Real output:

```text
✔ drainInbox skips malformed frontmatter without throwing
```

The temporary-store extension smoke also exited 0 with: `extension send queues; before_agent_start injects and archives; real wake was not called`.

### C10: secrets are redacted before inbox rendering

Real output:

```text
✔ formatInbox redacts secrets before rendering
```

The complete direct message test run reported `11` tests, `11` pass, `0` fail.

## Additional verification

- `npx tsgo --noEmit`: exit 0 with no diagnostics immediately before the final direct test round.
- `node --experimental-strip-types packages/her/test/session-roster.test.ts`: `10` pass, `0` fail. The whole-transcript search and unclosed-excerpt sweep both passed.
- `node --experimental-strip-types packages/her/test/event-wake.test.ts`: `8` pass, `0` fail.
- `node --experimental-strip-types packages/her/test/extension.test.ts`: `20` pass, `8` failed before their assertions because the sandbox denies the test helper's `git` child process with `spawn EPERM`. The failures are not Slice 2 assertion failures.
- `npm run check`: formatting, pinned-dependency, import, shrinkwrap, install-lock, and TypeScript checks passed; browser smoke could not run because the sandbox returned `spawn EPERM`.
- Canonical `node --import tsx --test ...` could not run: the sandbox returned `spawn EPERM` before the test file started. The direct strip-types commands above are the verified substitute.

The changes are committed on `her/g245-session-roster`. Nothing was pushed or merged.

G245-SLICE2-DONE