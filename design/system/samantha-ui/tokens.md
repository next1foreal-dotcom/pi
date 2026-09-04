# samantha-ui design system

Source: ../samantha-ui/src/app/globals.css @ 5077b2789d0dd5c60f6d5ba9adbba994633735e0
Loaded: 2026-09-04T16:48:44.439Z

/* ============================================================
   Theme tokens. :root = Gallery LIGHT (neutral paper).
   .dark = Gallery DARK (neutral near-black, the shipped default).
   One accent (sage green) carried by content and state, never by
   chrome. Every ink step clears WCAG 4.5:1 on the surfaces it
   sits on except ink-fainter, which is decorative-only (never text).
   Theme-agnostic tokens (motion, radius) live in :root only.
   ============================================================ */

| token | light | dark |
| --- | --- | --- |
| --background | #FFFFFF | #1A1A18 |
| --surface-2 | #F7F7F7 | #222220 |
| --surface-3 | #EFEFEF | #2A2A27 |
| --surface-4 | #E5E5E5 | #343430 |
| --ink-bright | #171717 | #F5F4F1 |
| --ink | #2A2A2A | #E1E0DB |
| --ink-soft | #5C5C5C | #B8B7B1 |
| --ink-faint | #7A7A7A | #94938D |
| --ink-fainter | #A3A3A3 | #5E5D58 |
| --gold | #8A6A2E | #C2A878 |
| --bubble | #F3F3F3 | #2E2E32 |
| --foreground | #2A2A2A | #E1E0DB |
| --foreground-strong | #171717 | #F5F4F1 |
| --foreground-soft | #5C5C5C | #B8B7B1 |
| --card | #FFFFFF | #2A2A27 |
| --card-foreground | #2A2A2A | #E1E0DB |
| --popover | #FFFFFF | #2A2A27 |
| --popover-foreground | #2A2A2A | #E1E0DB |
| --primary | #587A4F | #7B9E72 |
| --primary-foreground | #FFFFFF | #1A1A18 |
| --secondary | #EFEFEF | #2A2A27 |
| --secondary-foreground | #2A2A2A | #B8B7B1 |
| --muted | #EFEFEF | #2A2A27 |
| --muted-foreground | #5C5C5C | #B8B7B1 |
| --accent | #587A4F | #7B9E72 |
| --accent-foreground | #FFFFFF | #1A1A18 |
| --destructive | #B6442C | #D06A52 |
| --border | #E5E5E5 | #3C3C37 |
| --input | #E5E5E5 | #2A2A27 |
| --ring | #587A4F | #7B9E72 |
| --lime | #587A4F | #7B9E72 |
| --activity | #93B85A | — |
| --lime-foreground | #FFFFFF | #1A1A18 |
| --chart-1 | #587A4F | #7B9E72 |
| --chart-2 | #8A8A8A | #B8B7B1 |
| --chart-3 | #5C5C5C | #94938D |
| --chart-4 | #B8B8B8 | #5E5D58 |
| --chart-5 | #E5E5E5 | #3C3C37 |
| --shadow-float | 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px rgba(0, 0, 0, 0.08) | 0 8px 32px rgba(0, 0, 0, 0.32) |
| --ns-semantic | #587A4F | #7B9E72 |
| --ns-world | #6E8C63 | #4E6547 |
| --ns-ideas | #3C5535 | #C6D9B8 |
| --ns-topics | #4A6742 | #A3BD97 |
| --ns-narrative | #2E4428 | #E9F0E1 |
| --ns-fallback | #8A8A8A | #5E5D58 |
| --radius | 4px | — |
| --ease | cubic-bezier(0.16, 1, 0.3, 1) | — |
| --ease-soft | cubic-bezier(0.22, 1, 0.36, 1) | — |
| --dur-fast | 150ms | — |
| --dur | 300ms | — |
| --dur-slow | 500ms | — |
| --dur-stage | 400ms | — |
| --sidebar | #F7F7F7 | #222220 |
| --sidebar-foreground | #2A2A2A | #E1E0DB |
| --sidebar-primary | #587A4F | #7B9E72 |
| --sidebar-primary-foreground | #FFFFFF | #1A1A18 |
| --sidebar-accent | #EFEFEF | #2A2A27 |
| --sidebar-accent-foreground | #2A2A2A | #E1E0DB |
| --sidebar-border | #E5E5E5 | #3C3C37 |
| --sidebar-ring | #587A4F | #7B9E72 |
| --ai-radius | 20px | — |
| --ai-radius-inner | 14px | — |
| --ai-pad-x | 1.25rem | — |
| --ai-pad-y | 1rem | — |
| --cd-t1 | color-mix(in srgb, var(--ink) 4%, transparent) | — |
| --cd-t2 | color-mix(in srgb, var(--ink) 7%, transparent) | — |
| --cd-t3 | color-mix(in srgb, var(--ink) 11%, transparent) | — |
| --cd-t4 | color-mix(in srgb, var(--ink) 16%, transparent) | — |
| --cd-t5 | color-mix(in srgb, var(--ink) 25%, transparent) | — |
| --cd-t6 | color-mix(in srgb, var(--ink) 49%, transparent) | — |
| --cd-t7 | color-mix(in srgb, var(--ink) 75%, transparent) | — |
| --cds-radius | 6px | — |
| --cds-h-control | 24px | — |
| --cds-h-control-nested | 18px | — |
| --cds-icon | 16px | — |
| --cds-pad-sm | 6px | — |
| --cds-pad-md | 8px | — |
| --cds-pad-lg | 12px | — |
| --cds-pad-xl | 20px | — |
| --cds-checkbox | 16px | — |
| --cds-checkbox-glyph | 16px | — |
| --cds-checkbox-radius | 4px | — |
| --cds-switch-h | 16px | — |
| --cds-gap-xs | 6px | — |
| --cds-gap-sm | 8px | — |
| --cds-gap-md | 12px | — |
| --cds-gap-lg | 20px | — |
| --cds-gap-xl | 32px | — |
| --cds-ease-out | cubic-bezier(.165, .84, .44, 1) | — |
| --cds-ease-snap | cubic-bezier(.32, .72, 0, 1) | — |
| --cds-ease-overshoot | cubic-bezier(.34, 1.3, .64, 1) | — |
| --cds-dur-fast | 60ms | — |
| --cds-dur-snap | .12s | — |
| --cds-dur-base | .2s | — |
| --cds-dur-slow | .45s | — |
| --cds-btn-spring | linear(0,.2459,.6526,.9468,1.0764,1.0915,1.0585,1.0219,.9993,.9914,.9921,.9957,.9988,1.0004,1) | — |
| --cds-focus-shadow | inset 0 0 0 1px var(--background),
    0 0 0 1px var(--lime),
    0 0 6px 1px color-mix(in srgb, var(--lime) 35%, transparent) | — |
| --cds-ring-outer | 1px | — |
| --cds-ring-inner | 0px | — |
| --cds-radius-fit-max | 16px | — |
| --cds-radius-fit-gutter | 24px | — |
| --cds-git-added | #1e9e3c | #32d74b |
| --cds-git-removed | #cd2054 | #ff2c56 |
| --cds-git-modified | #98801f | #ffd014 |
| --cds-git-merged | #8e6bd9 | #b796ff |
| --cds-git-closed | #ff3a30 | #ff6159 |
| --cds-git-conflicting | #c5621b | #fa832e |
| --cds-git-draft | #737373 | #a6a6a6 |
| --cds-z0 | var(--background) | color-mix(in srgb, var(--ink) 3.9%, var(--background)) |
| --cds-z1 | color-mix(in srgb, var(--ink) 3.9%, var(--background)) | color-mix(in srgb, var(--ink) 10.2%, var(--background)) |
| --cds-z2 | color-mix(in srgb, var(--ink) 7.8%, var(--background)) | color-mix(in srgb, var(--ink) 14.9%, var(--background)) |
| --cds-z3 | color-mix(in srgb, var(--ink) 12.2%, var(--background)) | color-mix(in srgb, var(--ink) 20%, var(--background)) |
| --cds-z4 | color-mix(in srgb, var(--ink) 16.1%, var(--background)) | color-mix(in srgb, var(--ink) 23.9%, var(--background)) |
| --cds-z5 | color-mix(in srgb, var(--ink) 40%, var(--background)) | color-mix(in srgb, var(--ink) 32.2%, var(--background)) |
| --cds-z6 | color-mix(in srgb, var(--ink) 54.9%, var(--background)) | color-mix(in srgb, var(--ink) 65.1%, var(--background)) |
| --cds-shadow-card | inset 0 0 0 0 transparent,
    0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent),
    0 4px 24px color-mix(in srgb, var(--ink) 4%, transparent) | inset 0 0 0 1px color-mix(in srgb, white 6%, transparent),
    0 0 0 0 transparent,
    0 4px 24px color-mix(in srgb, black 8%, transparent) |
| --cds-shadow-float | 0 0 0 0.5px color-mix(in srgb, var(--ink) 5%, transparent),
    0 2px 8px color-mix(in srgb, var(--ink) 4%, transparent),
    0 12px 32px color-mix(in srgb, var(--ink) 3%, transparent) | 0 0 0 0.5px color-mix(in srgb, white 6%, transparent),
    0 2px 8px color-mix(in srgb, black 30%, transparent),
    0 12px 32px color-mix(in srgb, black 25%, transparent) |
| --cds-shadow-pop | 0 0 0 0.5px color-mix(in srgb, var(--ink) 6%, transparent),
    0 4px 12px color-mix(in srgb, var(--ink) 6%, transparent),
    0 16px 40px color-mix(in srgb, var(--ink) 8%, transparent) | 0 0 0 0.5px color-mix(in srgb, white 8%, transparent),
    0 4px 12px color-mix(in srgb, black 40%, transparent),
    0 16px 40px color-mix(in srgb, black 50%, transparent) |
| --cds-page-bg | var(--background) | — |
| --cds-surface | var(--surface-2) | — |
| --cds-surface-raised | var(--surface-3) | — |
| --cds-fill | var(--surface-4) | — |
| --cds-fill-accent | var(--lime) | — |
| --cds-bg-accent | color-mix(in srgb, var(--lime) 35%, transparent) | — |
| --cds-text | var(--ink) | — |
| --cds-text-muted | var(--ink-soft) | — |
| --cds-text-faint | var(--ink-faint) | — |
| --cds-border | var(--border) | — |
