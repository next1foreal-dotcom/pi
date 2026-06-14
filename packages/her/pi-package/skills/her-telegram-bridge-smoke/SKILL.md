---
name: her-telegram-bridge-smoke
description: Verify the Her Telegram bridge end to end without storing tokens, starting autonomy, or treating ack-only replies as success.
---

# Her Telegram Bridge Smoke

Use this after any Telegram bridge, responder, heartbeat outbox, proxy, or model-provider change. This is a verification skill only: do not save tokens, do not print tokens, do not start autonomous scheduling, and do not edit memory unless Fei explicitly asks for a record.

## Goal

Prove that Telegram is a real Her chat entrance, not just a transport that says "received".

A pass means:

- Bot API connectivity works through the configured network/proxy path.
- Incoming messages are queued into `tasks/inbox/` without executing inbound text.
- Outgoing messages can be delivered through `telegram-push-outbox`.
- The Pi responder uses only the approved read-only tool set.
- A real user message receives a specific, context-aware reply.

An ack-only response such as "收到", "I received this", or "please send a concrete task" is **not** a pass unless the user message itself is intentionally empty or ambiguous.

Ack-only is not a pass for a real non-empty Her question.

## Inputs

- `HER_MEMORY_DIR`
- `HER_TELEGRAM_CHAT_ID`
- `HER_TELEGRAM_BOT_TOKEN` from environment only
- optional `HER_TELEGRAM_BASE_URL` for a local/mock Bot API or gateway
- optional `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
- current Her provider and model configuration

Never copy a token into a report, memory note, command transcript, or proposal.

## Procedure

1. **Preflight env without disclosure**
   - Confirm required env vars are present.
   - Report only present/missing, never values.
   - If env values appear concatenated into a path or each other, block and ask Fei to fix the launcher.
2. **Bot API connectivity**
   - Run a harmless `getMe` or existing bridge preflight.
   - If the request times out, classify it as network/proxy/gateway blocked, not a Her memory failure.
3. **Inbound queue**
   - Poll one known test message or use a local mock.
   - Verify exactly one new `tasks/inbox/*.md` entry for the message.
   - Confirm inbound text was queued only and not executed.
4. **Outbox delivery**
   - Send a small outbox test message.
   - Verify delivery state updates without exposing token or chat id.
5. **Responder safety**
   - Confirm responder allowlist is read-only: `her_status` and `her_recall` only unless code explicitly expands the safe list.
   - Any write tool in responder mode is a block.
6. **Real reply quality**
   - Ask a non-empty question that requires Her context, for example: "Her 现在 Phase F 哪些已完成, 哪些还等 Samantha review?"
   - The reply must name at least one specific current fact from Her memory or backlog.
   - The reply must not claim autonomous scheduling, key rotation, or UI build completion unless those gates are actually done.
7. **Final verdict**
   - Output `PASS` only if all checks pass.
   - Output `BLOCKED` with the first failing gate and the next concrete fix otherwise.

## Report Shape

```text
Telegram smoke: PASS | BLOCKED
First failing gate: <none | env | network | inbound | outbox | responder-safety | real-reply>
Evidence:
- <short checked fact, no secrets>
- <short checked fact, no secrets>
Next:
- <one concrete command or manual action>
```

## Hard No

- Do not store, echo, summarize, or commit `HER_TELEGRAM_BOT_TOKEN`.
- Do not treat "收到" / ack-only as a real reply.
- Do not start Task Scheduler or heartbeat autonomy from this skill.
- Do not send private memory content to an external gateway unless Fei explicitly approves that exact test.
