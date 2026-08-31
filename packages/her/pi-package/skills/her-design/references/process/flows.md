<!-- moved from brilliant-local/knowledge/process/flows.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
keywords: [flow, screen, prototype, component-state, review]
---
# Process: Screen Flows

A product flow starts with a screen inventory and one primary path. Name the screens before placing pixels; each screen is a frame in the design document and each transition is a click link in the flow sidecar.

## Screen checklist

- Give every screen a stable frame id and an optional short display name.
- Choose one home screen and order screens by the path a person will take.
- Keep links explicit: one id, one source node, one target screen.
- Report and repair missing source or target nodes; a prototype skips a broken link instead of hiding it.

## Component states

Use the W-6 naming convention `<component>/<state>`. Add only the states the flow needs: `default`, `hover`, `pressed`, `disabled`, `empty`, and `error`.

## Review gate

Review every screen with `review/rubric` before calling the flow complete. Check the default path, each click target, the empty/error states selected for the flow, and the rendered frame bounds.
## Screens must contain their content

- A screen is a frame. Its content must be children of that frame, using the `parent` field in `create_nodes` or a backward `$1` reference in the same batch; unparented content leaves the prototype blank.
- A new frame defaults to an opaque white fill and sits above existing content. In dark designs, set its fill first or create the frame before creating its content as children, or it can cover the work already drawn.
- Before finishing, run `getFlow` and inspect the validation report; a non-empty `blankScreens` means the flow is incomplete.
