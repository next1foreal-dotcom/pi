import { createHash } from 'node:crypto';

/** Diagnostic comparison only. A shared failure never becomes a passing rollout gate. */
export function parseResults(text) {
  const rows = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const summaries = rows.filter((row) => row.kind === 'summary');
  if (summaries.length !== 1) throw new Error('one-complete-summary-required');
  const summary = summaries[0];
  if (rows.at(-1) !== summary || typeof summary.success !== 'boolean') throw new Error('incomplete-test-stream');
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites']) {
    if (!Number.isSafeInteger(summary.counts?.[key]) || summary.counts[key] < 0) throw new Error('invalid-test-counts');
  }
  if (summary.counts.tests === 0) throw new Error('zero-tests-is-not-validation');
  const results = new Map();
  for (const row of rows.filter((row) => row.kind === 'result')) {
    if (typeof row.id !== 'string' || !['passed', 'failed', 'skipped', 'todo'].includes(row.outcome)) {
      throw new Error('invalid-test-result');
    }
    if (results.has(row.id)) throw new Error(`ambiguous-test-identity: ${row.id}`);
    results.set(row.id, row);
  }
  if (!results.size) throw new Error('missing-test-results');
  return { summary, results };
}

export function compareResults(base, head) {
  const result = { regressed: [], headOnlyFailures: [], sharedFailures: [], resolvedFailures: [],
    missingFromHead: [], lostVerification: [], newPasses: [], newUnverified: [] };
  for (const [id, row] of head.results) {
    const before = base.results.get(id);
    if (row.outcome === 'failed') {
      if (before?.outcome === 'failed') result.sharedFailures.push(row);
      else if (before?.outcome === 'passed') result.regressed.push(row);
      else result.headOnlyFailures.push(row);
    } else if (row.outcome === 'passed') {
      if (before?.outcome === 'failed') result.resolvedFailures.push(row);
      else if (!before) result.newPasses.push(row);
    } else if (before && before.outcome !== row.outcome) result.lostVerification.push(row);
    else if (!before) result.newUnverified.push(row);
  }
  for (const [id, row] of base.results) if (!head.results.has(id)) result.missingFromHead.push(row);
  return { ...result, base: base.summary, head: head.summary,
    verdict: 'diagnostic-only',
    warning: 'Names identify observed outcomes, not causes. Missing, skipped and cancelled tests are not passes. Shared failures still block rollout.' };
}

/** Compare exact provider bytes and manifest metadata, excluding only generatedAt. */
export function modelDataFingerprint(entries) {
  const files = new Map(entries);
  if (files.size !== entries.length || files.size < 2 || !files.has('.manifest.json')) {
    throw new Error('model-data-manifest-required');
  }
  const manifest = JSON.parse(files.get('.manifest.json').toString());
  if (!manifest || Array.isArray(manifest) || typeof manifest.generatedAt !== 'string' ||
      Number.isNaN(Date.parse(manifest.generatedAt))) throw new Error('invalid-model-data-manifest');
  const { generatedAt, ...content } = manifest;
  files.set('.manifest.json', JSON.stringify(content));
  const hash = createHash('sha256');
  for (const [name, value] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const bytes = Buffer.from(value);
    hash.update(JSON.stringify([name, bytes.length]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}
