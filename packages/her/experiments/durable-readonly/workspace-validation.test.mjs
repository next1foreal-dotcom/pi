import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import report from './workspace-reporter.mjs';
import { compareResults, modelDataFingerprint, parseResults } from './workspace-comparison.mjs';
import { OBSERVER_TIMEOUTS, runStage } from './validation-stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const makeRun = (rows, summary = {}) => parseResults([...rows, { kind: 'summary', success: true,
  counts: { tests: rows.length, passed: rows.length, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 },
  ...summary }].map((row) => JSON.stringify(row)).join('\n'));
const row = (id, outcome = 'passed') => ({ kind: 'result', id, outcome });

test('installation has a separate budget; observer test deadline remains four minutes', () => {
  assert.equal(OBSERVER_TIMEOUTS.install, 600000);
  assert.equal(OBSERVER_TIMEOUTS.tests, 240000);
});
test('validation stage retains argv boundaries, refuses a shell, and logs its outcome', () => {
  const logs = [];
  const result = runStage('test', 'node', ['a b', 'c&d'], { cwd: '/fixture', timeout: 123, shell: true },
    (command, args, options) => {
      assert.equal(command, 'node'); assert.deepEqual(args, ['a b', 'c&d']);
      assert.equal(options.shell, false); assert.equal(options.timeout, 123);
      return { status: 0, signal: null };
    }, (line) => logs.push(JSON.parse(line)));
  assert.equal(result.outcome, 'passed');
  assert.equal(logs[0].event, 'start'); assert.equal(logs[1].event, 'end');
});
test('timeout, spawn failure, signal and nonzero exit are never passing stages', () => {
  for (const child of [{ status: null, error: { code: 'ETIMEDOUT' } }, { status: null, error: { code: 'ENOENT' } },
    { status: null, signal: 'SIGTERM' }, { status: 1 }, { status: 0, error: { code: 'EIO' } }]) {
    assert.equal(runStage('test', 'node', [], { timeout: 1 }, () => child, () => {}).outcome, 'failed');
  }
});
test('validation refuses an absent or unbounded timeout before spawning', () => {
  for (const timeout of [undefined, 0, -1, Infinity, NaN]) {
    assert.throws(() => runStage('test', 'node', [], { timeout }, () => assert.fail('spawned')), /timeout-required/);
  }
});
test('comparison separates a genuine pass-to-fail from shared and head-only failures', () => {
  const base = makeRun([row('regression'), row('shared', 'failed'), row('fixed', 'failed')]);
  const head = makeRun([row('regression', 'failed'), row('shared', 'failed'), row('fixed'), row('new', 'failed')]);
  const result = compareResults(base, head);
  assert.deepEqual(result.regressed.map((item) => item.id), ['regression']);
  assert.deepEqual(result.sharedFailures.map((item) => item.id), ['shared']);
  assert.deepEqual(result.headOnlyFailures.map((item) => item.id), ['new']);
  assert.deepEqual(result.resolvedFailures.map((item) => item.id), ['fixed']);
  assert.equal(result.verdict, 'diagnostic-only');
});
test('removed, skipped and todo cases cannot look like resolved failures', () => {
  const result = compareResults(makeRun([row('removed', 'failed'), row('skip', 'failed'), row('todo')]),
    makeRun([row('skip', 'skipped'), row('todo', 'todo'), row('new-skip', 'skipped')]));
  assert.equal(result.resolvedFailures.length, 0);
  assert.equal(result.missingFromHead.length, 1);
  assert.equal(result.lostVerification.length, 2);
  assert.equal(result.newUnverified.length, 1);
});
test('adding passing tests never conceals an unchanged failing test', () => {
  const result = compareResults(makeRun([row('bad', 'failed')]), makeRun([row('bad', 'failed'), row('new')]));
  assert.equal(result.sharedFailures.length, 1); assert.equal(result.newPasses.length, 1);
});
test('missing, corrupt, duplicate and zero-test summaries fail loudly', () => {
  for (const text of ['', '{', JSON.stringify(row('a'))]) assert.throws(() => parseResults(text));
  assert.throws(() => makeRun([]), /zero-tests/);
  assert.throws(() => makeRun([row('a'), row('a')]), /ambiguous-test/);
  const summary = { kind: 'summary', counts: {}, success: true };
  assert.throws(() => parseResults(`${JSON.stringify(summary)}\n${JSON.stringify(summary)}`), /one-complete/);
  assert.throws(() => makeRun([row('a')], { counts: { tests: -1 } }), /invalid-test-counts/);
});
test('a truncated stream with results after its summary is rejected', () => {
  const summary = { kind: 'summary', success: true, counts: { tests: 1 } };
  assert.throws(() => parseResults(`${JSON.stringify(summary)}\n${JSON.stringify(row('a'))}`), /incomplete/);
});
test('reporter does not confuse identical names in different suites or line-number shifts', async () => {
  const file = join(process.cwd(), 'packages/her/test/fixture.test.ts');
  const events = [];
  for (const suite of ['one', 'two']) {
    events.push({ type: 'test:start', data: { file, name: suite, nesting: 0 } });
    events.push({ type: 'test:start', data: { file, name: 'same', nesting: 1 } });
    events.push({ type: 'test:pass', data: { file, name: 'same', nesting: 1, line: 42 } });
  }
  const rows = [];
  for await (const line of report(events)) rows.push(JSON.parse(line));
  assert.notEqual(rows[0].id, rows[1].id); assert.ok(!rows[0].id.includes('42'));
  assert.equal(rows[0].file, 'packages/her/test/fixture.test.ts');
});
test('reporter keeps only the final global summary, not each child-file summary', async () => {
  const events = [{ type: 'test:summary', data: { file: '/fixture', counts: { tests: 1 } } },
    { type: 'test:summary', data: { counts: { tests: 2 }, success: false } }];
  const rows = [];
  for await (const line of report(events)) rows.push(JSON.parse(line));
  assert.equal(rows.length, 1); assert.equal(rows[0].counts.tests, 2);
});
test('real Node subprocess reports pass, failure, nested names, skipped and cancelled tests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'her-workspace-report-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'test/fixture.mjs'), `import { test, describe } from 'node:test';
    import assert from 'node:assert/strict';
    describe('one', () => { test('same', () => {}); });
    describe('two', () => { test('same', () => {}); });
    test('fails', () => assert.equal(1, 2));
    test('skip', { skip: true }, () => {});
    const cancelled = new AbortController();
    // Error retains custom cancellation metadata across process serialization.
    cancelled.abort(new Error('fixture cancellation'));
    test('cancel', { signal: cancelled.signal }, () => assert.fail('cancelled body ran'));\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // The child is a separate runner, not a nested test context.
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${join(here, 'workspace-reporter.mjs')}`,
    'test/fixture.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 15000, shell: false });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const parsed = parseResults(result.stdout);
  t.diagnostic(JSON.stringify(parsed.summary));
  assert.equal(parsed.summary.success, false);
  assert.equal(parsed.summary.counts.passed, 2);
  assert.equal(parsed.summary.counts.failed, 1);
  assert.equal(parsed.summary.counts.cancelled, 1);
  assert.equal(parsed.summary.counts.skipped, 1);
  const failed = [...parsed.results.values()].filter((item) => item.outcome === 'failed');
  assert.equal(failed.find((item) => item.names.at(-1) === 'fails')?.code, 'ERR_ASSERTION');
  assert.equal(failed.find((item) => item.names.at(-1) === 'cancel')?.failureType, 'testAborted');
  assert.ok(!failed.some((item) => item.message?.includes('cancelled body ran')));
  assert.equal([...parsed.results.values()].filter((item) => item.names.at(-1) === 'same').length, 2);
});

test('model fingerprint ignores only manifest generation time, not actual model data', () => {
  const manifest = { schemaVersion: 3, generatedAt: '2026-10-02T00:00:00Z', structureHash: 'structure', files: { 'provider.json': 'hash' } };
  const entries = (value, provider = '{"value":1}') => [['.manifest.json', JSON.stringify(value)], ['provider.json', provider]];
  const before = modelDataFingerprint(entries(manifest));
  assert.equal(before, modelDataFingerprint(entries({ ...manifest, generatedAt: '2026-10-02T01:00:00Z' })));
  assert.equal(before, modelDataFingerprint(entries(manifest).reverse()));
  assert.notEqual(before, modelDataFingerprint(entries(manifest, '{"value":2}')));
  assert.notEqual(before, modelDataFingerprint(entries({ ...manifest, structureHash: 'different' })));
  assert.notEqual(before, modelDataFingerprint(entries({ ...manifest, schemaVersion: 4 })));
  assert.notEqual(before, modelDataFingerprint(entries({ ...manifest, files: { 'provider.json': 'different' } })));
});
test('model fingerprint rejects missing, malformed and duplicate manifests', () => {
  for (const entries of [[], [['.manifest.json', '{']], [['.manifest.json', '{}']],
    [['.manifest.json', 'null']], [['.manifest.json', '{"generatedAt":"invalid"}']],
    [['.manifest.json', '{}'], ['.manifest.json', '{}']]]) {
    assert.throws(() => modelDataFingerprint(entries));
  }
});
