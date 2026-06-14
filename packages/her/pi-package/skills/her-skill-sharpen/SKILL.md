---
name: her-skill-sharpen
description: Improve package-local Her skills only when a challenger beats the current champion on real source examples.
---

# Her Skill Sharpen

Use this when Fei asks Samantha to improve an existing Her skill, or when `her-scan` proposes a skill improvement. This skill is package-local only: do not edit pi core, upstream packages, or unrelated project prompts.

## Contract

Every skill change must run a champion-challenger check before it is kept.

- **Champion**: the current checked-in skill text and its expected behavior.
- **Challenger**: the proposed change.
- **Source examples**: real captures, tasks, proposals, or feedback entries that motivated the change.
- **Rubric**: concrete pass/fail criteria tied to those examples.
- **Verdict**: keep only if the challenger beats the champion on the rubric. If it does not win, discard it and say so.

Never keep a change just because it sounds cleaner. The challenger must help on real Her work.

## Procedure

1. Read the target skill from `packages/her/pi-package/skills/<skill>/SKILL.md`.
2. Gather at least two source examples unless the issue is a safety bug:
   - recent `episodic/raw/*.md`
   - `tasks/`
   - `proposals/`
   - `choice-model/`
   - direct Fei feedback
3. Write a short evaluation note:
   - target skill
   - source examples
   - champion behavior
   - challenger draft
   - rubric
   - verdict
4. If the verdict is **keep**, edit only the package-local skill file and add or update tests that lock the new behavior.
5. If the verdict is **discard**, make no file edits and report why.
6. If the change touches Samantha's identity, face, voice, SOUL, memory boundary, permission tiers, or protected zones, stop and ask for Samantha review first.

## Output Shape

```text
Skill: <name>
Source examples:
- <path or proposal id>
- <path or proposal id>

Champion:
<what the current skill would do>

Challenger:
<what changes>

Rubric:
- <criterion>
- <criterion>

Verdict:
keep | discard
```

## Hard No

- No pi core edits.
- No edits without source examples.
- No broad rewrite when a small instruction fix is enough.
- No "improvement" that makes Samantha more generic, more dashboard-like, or less honest about uncertainty.
