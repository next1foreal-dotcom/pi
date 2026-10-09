/** These tests require the real 1.0.0 SDK. Missing dependencies are failures, never skips. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { probeEnvironment } from './policy.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const LIMIT_MS = 20_000;
const workers = new Map();

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'her-durable-real-'));
  workers.set(path, []);
  await Promise.all(['fixtures', 'state', 'evidence'].map((dir) => mkdir(join(path, dir))));
  await writeFile(join(path, 'PROBE_ONLY'), 'her-durable-readonly-fixtures-v1\n');
  await writeFile(join(path, 'fixtures', 'a.txt'), 'alpha\n');
  await writeFile(join(path, 'fixtures', 'b.txt'), 'bravo\n');
  t.after(async () => {
    await Promise.all((workers.get(path) ?? []).map(async ({ child, exited }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }));
    workers.delete(path);
    assert.equal(await readFile(join(path, 'fixtures', 'a.txt'), 'utf8'), 'alpha\n');
    assert.equal(await readFile(join(path, 'fixtures', 'b.txt'), 'utf8'), 'bravo\n');
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function launch(t, path, phase, replay = 'safe', policy = 'allow') {
  const child = fork(workerPath, [phase, path, replay, policy], {
    env: probeEnvironment(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  let exitState;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  child.stdout.on('data', () => {});
  child.stderr.on('data', (data) => { stderr = (stderr + String(data)).slice(-32768); });
  child.on('message', (message) => { messages.push(message); notify(); });
  child.on('error', (error) => { messages.push({ kind: 'error', message: String(error) }); notify(); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    exitState = { code, signal }; notify(); resolve(exitState);
  }));
  workers.get(path)?.push({ child, exited });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS + 1000);
  child.once('exit', () => clearTimeout(watchdog));
  t.after(async () => {
    if (!exitState) child.kill('SIGKILL');
    await exited;
  });
  const wait = (kind) => new Promise((resolve, reject) => {
    const done = (error, message) => {
      clearTimeout(timer); listeners.delete(check);
      if (error) reject(error); else resolve(message);
    };
    const check = () => {
      const error = messages.find((m) => m.kind === 'error');
      const message = messages.find((m) => m.kind === kind);
      if (error) done(new Error(error.message));
      else if (message) done(undefined, message);
      else if (exitState) done(new Error(`Worker exited before ${kind}: ${JSON.stringify(exitState)}\n${stderr}`));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); done(new Error(`Timed out waiting for ${kind}\n${stderr}`));
    }, LIMIT_MS);
    listeners.add(check); check();
  });
  return { child, wait, exited, messages, result: async () => {
    const message = await wait('result');
    const status = await exited;
    assert.equal(status.code, 0, stderr);
    return message.report;
  } };
}

async function attempts(path) {
  let text;
  try { text = await readFile(join(path, 'evidence', 'attempts.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { a: 0, b: 0 }; throw error; }
  const result = { a: 0, b: 0 };
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    assert.ok(row.file === 'a' || row.file === 'b');
    result[row.file]++;
  }
  return result;
}

async function crash(t, path, replay = 'safe') {
  const first = launch(t, path, 'crash', replay);
  const admitted = await first.wait('admitted');
  const paused = await first.wait('paused');
  assert.deepEqual(Object.keys(paused.snapshot.receipts), ['a']);
  assert.equal(paused.snapshot.entryKinds.filter((kind) => kind === 'pi.tool-result').length, 1);
  assert.deepEqual(await attempts(path), { a: 1, b: 1 });
  assert.equal(first.child.kill('SIGKILL'), true);
  const exit = await first.exited;
  assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0, 'must terminate without a graceful close');
  assert.equal(first.messages.some((message) => message.kind === 'result'), false);
  return { admitted, paused };
}

function assertSameSubmission(admitted, report) {
  assert.equal(report.submissionId, admitted.submissionId);
  assert.equal(report.duplicateId, admitted.submissionId);
  assert.equal(report.conversationId, admitted.conversationId);
  assert.equal(report.userEntryCount, 1);
}

test('real SDK: happy path and repeated request ID do not repeat work', { timeout: 60_000 }, async (t) => {
  const path = await fixture(t);
  const child = launch(t, path, 'normal');
  const admitted = await child.wait('admitted');
  const report = await child.result();
  assertSameSubmission(admitted, report);
  assert.equal(report.submissionStatus, 'done');
  assert.equal(report.observerStatus, 'verified');
  assert.equal(report.modelCalls, 3);
  assert.deepEqual(report.reconnected.receipts, report.receipts);
  assert.ok(report.updates.some((update) => Object.keys(update.receipts).length === 2),
    'custom-document commits must reach an already attached client, not only a new snapshot');
  assert.deepEqual(await attempts(path), { a: 1, b: 1 });
  t.diagnostic(JSON.stringify({ node: report.node, versions: report.versions, observerStatus: report.observerStatus }));
});

test('real SDK: SIGKILL resumes B, does not repeat A, and reconnects committed state', { timeout: 90_000 }, async (t) => {
  const path = await fixture(t);
  const { admitted, paused } = await crash(t, path);
  const resumed = await launch(t, path, 'resume').result();
  assertSameSubmission(admitted, resumed);
  assert.equal(resumed.observerStatus, 'verified');
  assert.equal(resumed.modelCalls, 1);
  assert.deepEqual(resumed.initial.receipts, paused.snapshot.receipts);
  assert.ok(paused.snapshot.entryIds.every((id) => resumed.reconnected.entryIds.includes(id)));
  assert.deepEqual(resumed.reconnected.receipts, resumed.receipts);
  assert.deepEqual(await attempts(path), { a: 1, b: 2 });
  const reopened = await launch(t, path, 'inspect').result();
  assertSameSubmission(admitted, reopened);
  assert.equal(reopened.modelCalls, 0);
  assert.deepEqual(reopened.initial.receipts, resumed.receipts);
  assert.deepEqual(reopened.receipts, resumed.receipts);
  assert.equal(reopened.observerStatus, 'verified');
  assert.deepEqual(await attempts(path), { a: 1, b: 2 });
  t.diagnostic(JSON.stringify({ crash: 'SIGKILL', attempts: await attempts(path), requestDeduplicated: true,
    reconnectedStateEqual: true }));
});

test('real SDK: a tool without safe replay is interrupted, not rerun or verified', { timeout: 60_000 }, async (t) => {
  const path = await fixture(t);
  const { admitted } = await crash(t, path, 'unsafe');
  const resumed = await launch(t, path, 'resume', 'unsafe').result();
  assertSameSubmission(admitted, resumed);
  assert.equal(resumed.submissionStatus, 'done', 'a final model answer is not an acceptance verdict');
  assert.equal(resumed.observerStatus, 'blocked');
  assert.deepEqual(Object.keys(resumed.receipts), ['a']);
  assert.deepEqual(await attempts(path), { a: 1, b: 1 });
  const interrupted = resumed.toolResults.find((result) => result.toolCallId === 'read-b');
  assert.equal(interrupted?.isError, true);
  assert.match(interrupted.text, /interrupt/i);
});

test('real SDK: revoked permission is checked again before replay can read', { timeout: 60_000 }, async (t) => {
  const path = await fixture(t);
  await crash(t, path);
  const resumed = await launch(t, path, 'resume', 'safe', 'deny').result();
  assert.equal(resumed.observerStatus, 'blocked');
  assert.deepEqual(await attempts(path), { a: 1, b: 1 });
  assert.deepEqual(Object.keys(resumed.receipts), ['a']);
  assert.equal(resumed.toolResults.find((result) => result.toolCallId === 'read-b')?.isError, true);
});

test('real SDK: authorization hook errors block execution', { timeout: 60_000 }, async (t) => {
  const path = await fixture(t);
  const report = await launch(t, path, 'normal', 'safe', 'throw').result();
  assert.equal(report.observerStatus, 'blocked');
  assert.deepEqual(await attempts(path), { a: 0, b: 0 });
  assert.equal(report.toolResults.length, 2);
  assert.ok(report.toolResults.every((result) => result.isError));
});

test('real SDK: explicit cancellation is not resurrected on reopening', { timeout: 60_000 }, async (t) => {
  const path = await fixture(t);
  const child = launch(t, path, 'crash');
  const admitted = await child.wait('admitted');
  await child.wait('paused');
  child.child.send({ kind: 'abort' });
  const cancelled = await child.result();
  assert.equal(cancelled.submissionStatus, 'unanswered');
  assert.equal(cancelled.observerStatus, 'blocked');
  const reopened = await launch(t, path, 'inspect').result();
  assertSameSubmission(admitted, reopened);
  assert.equal(reopened.submissionStatus, 'unanswered');
  assert.equal(reopened.modelCalls, 0);
  assert.equal(reopened.observerStatus, 'blocked');
  assert.deepEqual(await attempts(path), { a: 1, b: 1 });
});
