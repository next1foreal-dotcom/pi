# CUA Driver 0.33.3 integration evidence

Verified on Windows on 2026-10-05. This is a local candidate, not a runtime rollout.

## Provenance

- Official tag: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.33.3
- Binary asset: cua-driver-rs-0.33.3-windows-x86_64-binary.zip
- SHA256: 4AF1FE348B0E42CEEF8E198EAE2DD5C41F7FB8F0423F9A7908A957673E1603EA
- `cua-driver --version`: 0.33.3.
- Protocol schemas were obtained from this binary's `describe` output. Public schemas omit host session and arbitrary screenshot-file output authority.
- Engine candidate: `feat/her-cua-0333-20261005`, base a2d72123d94289d53d7336289f0d6102b0b2b25e. Previous fc54ab8fb native adaptation was carried forward by scoped files.
- Studio candidate: `feat/her-cua-ui-0333-20261005`, base 75d76fe31682d79ab0970b29c6f52103ba8ba712.

## Implemented boundaries

12 new typed tools: list_windows, get_window_state, verify_state, browser_prepare, get_browser_state, browser_navigate, browser_click, browser_type, browser_pointer, browser_dialog, browser_download, browser_set_input_files. Names are prefixed `her_cua_`. Native `her_hands_snapshot` / `her_hands_act` remain compatible with their public inputs, using opaque latest-driver tokens internally.

Persistent MCP connections are necessary: raw CLI browser_download was reproduced refusing host consent, then the MCP-host route completed the download. The extension retains the driver instance. Each host session owns its connection, bindings, refs and lifecycle cleanup. Browser actions require actual UI approval, including when Studio runs in an isolated directory. Global drivers, existing-profile grants and production configuration were not changed.

## Checks

- Core `pnpm run check`: exit 0 (Biome, pinned/runtime dependencies, TypeScript imports, entry graphs, shrinkwrap/install-lock, TypeScript, browser smoke build).
- Focused hands/CUA/MCP tests: 59/59 passed.
- Extension registration/Cedar integration tests: 2/2 passed. New tools appear in the shared static registry as well as runtime registration.
- Studio permission tests: 13/13 passed; `pnpm run typecheck`: exit 0.
- Studio changed permission modules: ESLint exit 0. Full touched-file lint retains the baseline `react-hooks/rules-of-hooks` error in `useRpcBuildWithPermissions` within `pi-build.ts`; the untouched HEAD reproduces it at line 1539 (candidate line 1540). This unrelated naming issue was not modified.

## Scripted live acceptance

The actual Her tool wrappers ran against the official binary, standard-mode daemon on a private named pipe, isolated Chrome profile, and local task-owned HTML fixture. The harness explicitly approved only this fixture. No paid model/provider calls or personal-profile grant were made.

Passed: isolated preparation, exact window discovery/binding, native tree plus real screenshot, stable window-exists verification, semantic page observation, navigation, typing, save button, application file readback, hover, file assignment, MCP-approved download, JavaScript prompt inspection/resolution and final screenshot. The downloaded opaque id `cc98bc29-1c89-4d42-8b65-9770c4a68374` matches the local 20-byte file containing `CUA download fixture`. The saved file contains `Her CUA verified`; the final page also shows `Saved Her CUA verified`, `upload.txt`, and `Dialog verified`.

Important observed limitations:

- Native verification of Chromium page text returned `unknown / untrusted_source`; Her correctly kept `goalVerified:false`. Application output and semantic page state were checked independently.
- Opening the JS prompt returned `browser_input_trust_unavailable` after a CDP input timeout even though the prompt was present. Her arms dialog events before input, retains the exact binding after the refusal, invalidates action refs, and permits inspection/resolution without replaying the click. The recovered prompt and final state were verified.
- Native status verification sets `goalVerified:true` only for `satisfied` and `stable:true`. A successful dispatch or screenshot never receives that flag.

Raw local evidence: `D:/@Her/work/cua-0333-20261005/` (`unit-tests.log`, `registry-tests.log`, `check.log`, `ui-typecheck.log`, `ui-permission-tests.log`, `ui-eslint-baseline.log`, `live-final.log`, `live/`). The final screenshot is `live/16-browser_dialog.png`.

Not claimed: model-planned end-to-end Her conversation acceptance, real Studio modal click-through, logged-in personal-profile attachment, every pointer variant or native action in every app, production installation, commit, push, merge or deployment. Repository product review/Samantha review remains a release-stage item; no shared BACKLOG card was marked DONE.