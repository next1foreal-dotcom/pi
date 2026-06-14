---
name: her-scan
description: Proactively scan Her memory for stalled goals, repeated themes, taste conflicts, and blocked tasks, then record at most three proposals.
---

# Her Scan

Use this when Fei asks Samantha to proactively look around and say what she notices. This skill is read-first and proposal-only: do not execute the proposed work unless Fei explicitly says to do it.

Use `mode: skill-mining` when Fei asks for the second flywheel, skill mining, or "from the last captures, what should become a skill?"

## Contract

Output at most three proposals in this shape:

```text
我注意到 ___
建议 ___
依据 ___
```

Every proposal must be grounded in memory, goals, tasks, or recent episodes. Do not propose busywork. Do not create tasks, branches, commits, or edits from this skill.

In `skill-mining` mode, proposals must be SKILL.md draft proposals, not finished skills. They require Fei approval before any file is created or edited.

## Procedure

### Default Scan

1. Check proposal calibration first:
   - Call `her_proposal_stats` when available.
   - If mode is `conservative`, only propose high-confidence items with direct evidence from at least two surfaces, or safety/blocked-work items.
2. Read the stable context:
   - `narrative/CONTEXT.md`
   - `narrative/FACTS.md`
   - `narrative/CHOICE-MODEL.md`
   - `choice-model/*.md`
3. Read work state:
   - `goals/*.md`
   - `tasks/active/*.md`
   - recent `episodic/raw/*.md` entries, newest first, up to five files
4. Look for four signals:
   - stalled goals: an active goal or task has not advanced, is blocked, or has repeated checkpoints without completion
   - repeated themes: the same concern appears across recent episodes
   - taste conflicts: CHOICE-MODEL rules contradict recent output or feedback
   - safety/maintenance gaps: audit, sync, registry, or docs drift that could break future work
5. Choose at most three proposals. Rank by:
   - urgency
   - reversibility
   - evidence quality
   - usefulness to Fei now
6. Record each proposal:
   - Call `her_proposal_record` with `title`, `observation`, `suggestion`, `evidence`, and `source: "her-scan"`.
   - If the tool is unavailable, include a stable short id in the response so Fei can refer to it later.
7. Finish with a compact answer:
   - List the proposals in the required shape.
   - Include the proposal id returned by `her_proposal_record`.
   - If there is nothing worth proposing, say so and name the surfaces checked.

### Skill Mining Mode

1. Check proposal calibration first with `her_proposal_stats` when available.
2. Read the recent working stream:
   - newest `episodic/raw/*.md` entries, up to sixty files
   - `tasks/done/*.md`
   - `tasks/active/*.md`
   - `proposals/scan/*.md`
   - direct Fei feedback in `choice-model/*.md`
3. Look for repeatable procedures that already happened at least twice, especially:
   - commands or test loops Fei keeps asking for
   - review/acceptance patterns that prevent overclaiming
   - browser, Telegram, reader, or memory workflows that needed manual repair
   - private-boundary habits that must be protected
4. Reject weak candidates:
   - one-off tasks
   - vague personality advice
   - anything that would require pi core edits
   - anything that touches identity, face, voice, SOUL, memory boundary, permission tiers, or protected zones without Samantha review
5. For each surviving candidate, draft a SKILL.md proposal with:
   - proposed skill name
   - trigger
   - source examples
   - procedure
   - acceptance examples
   - why this should be a skill instead of a one-off note
6. Record at most one to three proposals with `her_proposal_record`, using `source: "her-scan:skill-mining"`.
7. Finish by listing the proposal ids and saying clearly that no skill file was created yet.

## Quality Bar

A good scan sounds like: "I noticed this real thing in our working state; here is a small next move; here is why I believe it matters."

A bad scan sounds like generic productivity advice, speculative psychology, or a hidden attempt to start work without permission.

## Feedback Loop

When Fei replies:

- "做" means call `her_proposal_feedback` with `verdict: "do"`.
- "放着" means call `her_proposal_feedback` with `verdict: "later"`.
- "不对" means call `her_proposal_feedback` with `verdict: "wrong"` and capture Fei's reason in `note`.

If proposals are repeatedly marked `wrong`, future scans must become quieter and require stronger evidence before speaking.
