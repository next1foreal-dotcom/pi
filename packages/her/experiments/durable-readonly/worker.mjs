/** Disposable child process for a REAL SQLite/harness restart, not an in-memory simulation. */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, openProbe, reportProbe, REQUEST, viewSummary, watchProbe } from './host.mjs';

const [phase, scratch, replay = 'safe', policy = 'allow'] = process.argv.slice(2);
if (!['normal', 'crash', 'resume', 'inspect'].includes(phase) || !scratch || !['safe', 'unsafe'].includes(replay) ||
  !['allow', 'deny', 'throw'].includes(policy)) throw new Error('Invalid probe worker invocation.');
if (await readFile(join(scratch, 'PROBE_ONLY'), 'utf8') !== 'her-durable-readonly-fixtures-v1\n') {
  throw new Error('Refusing to use a directory not created by the probe parent.');
}
// Only the faux provider is installed; reject accidental HTTP access as an additional tripwire.
globalThis.fetch = async () => { throw new Error('Network is disabled in the probe worker.'); };
const send = async (message) => {
  if (!process.send) throw new Error('Probe workers require an IPC parent.');
  await new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
};
let opened;
let watch;
let abortTask;
try {
  opened = await openProbe({
    database: join(scratch, 'state', 'observer.sqlite'), fixtures: join(scratch, 'fixtures'), phase, replay,
    allowed: policy !== 'deny', throwInHook: policy === 'throw',
    onAttempt: async (file) => {
      // Test instrumentation only. This log is outside the read-only fixture directory.
      const fd = openSync(join(scratch, 'evidence', 'attempts.jsonl'), 'a');
      try { writeSync(fd, `${JSON.stringify({ file, pid: process.pid })}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
    },
    onPause: async (callContext) => {
      const state = await watchProbe(opened);
      const snapshot = viewSummary(state.value);
      await state.stop();
      const signal = callContext.abortSignal;
      if (!signal) throw new Error('Durable tool did not provide cancellation.');
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error('Probe cancelled.'));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        void send({ kind: 'paused', snapshot }).catch(reject);
        // This pending promise intentionally ends only by cancellation or process death.
      });
    },
  });
  watch = await watchProbe(opened);
  const initial = viewSummary(watch.value);
  const updates = [];
  watch.start(async (value) => { updates.push(viewSummary(value)); });
  const submitted = await opened.root.submit(REQUEST, context);
  await send({ kind: 'admitted', submissionId: submitted.id, conversationId: opened.root.id, initial });
  process.on('message', (message) => {
    if (message?.kind === 'abort') {
      abortTask = opened.root.abort(context);
      void abortTask.catch(() => {}); // Awaited below, before closing IPC or storage.
    }
  });
  const settled = await submitted.wait(context);
  if (abortTask) await abortTask;
  // Same request ID must resolve to the same stored submission, before and after restart.
  const duplicate = await opened.root.submit(REQUEST, context);
  const duplicateSettled = await duplicate.wait(context);
  const report = await reportProbe(opened, { ...settled, id: submitted.id });
  report.initial = initial;
  report.duplicateId = duplicate.id;
  report.duplicateStatus = duplicateSettled.status;
  report.updates = updates;
  await watch.stop();
  watch = undefined;
  await opened.harness.close(context);
  opened = undefined;
  await send({ kind: 'result', report });
  process.disconnect();
} catch (error) {
  // Do not convert load/API/storage failures into successful or skipped tests.
  await send({ kind: 'error', message: error.stack ?? String(error) }).catch(() => {});
  if (watch) await watch.stop().catch(() => {});
  if (opened) await opened.harness.close(context).catch(() => {});
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
