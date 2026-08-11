# PATCHES

- 2026-08-11: `packages/coding-agent/src/core/agent-session.ts` classifies OAuth 401/token-expired assistant errors, forces the existing OAuth resolver with a one-hour validity window, and continues the same turn once with freshly resolved request auth.
  - Why: provider-side token expiry can disagree with the locally stored OAuth expiry; the main `ModelRuntime.streamSimple` request resolves auth on each invocation, so a post-error continuation can use the refreshed token without changing `resolveStoredOAuth`.
  - Upstream: candidate for an upstream PR; the behavior is isolated to the coding-agent session retry seam and preserves the existing generic retry policy for all other errors.