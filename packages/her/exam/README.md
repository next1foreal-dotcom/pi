# Hands exam

Run `node --import tsx packages/her/exam/runner.ts --validate` to validate the frozen catalog and local fixtures.

Run `node --import tsx packages/her/exam/runner.ts --list` to list the 14 tasks.

Run `node --import tsx packages/her/exam/runner.ts --all` only after the Studio browser host is running and control has been handed back to Samantha. The runner creates a timestamped snapshot below `results/`.

The runner grants only `browser_navigate`, `browser_read_page`, `browser_act`, and `write`. It does not grant file or shell tools.

BU Bench and Odysseys are intentionally out of scope for v1.
