import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { authorizeHerRead, createHerObserver, Observation } from './her-observer.mjs';
import { serveObserverReport } from './observer-report-server.mjs';
import { fetchReport } from '../../src/observer-report/protocol.ts';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluate, policyEnvelope } from '../../src/lib/cedar.ts';
import { digest } from './observer-scope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const active = new Map();
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'her-observer-sdk-'));
  const workspaceRoot = join(dir, 'workspace');
  const memoryRoot = join(dir, 'private-store');
  await mkdir(workspaceRoot); await mkdir(memoryRoot);
  await writeFile(join(memoryRoot, 'sentinel.md'), 'private sentinel: never read or changed');
  const sources = [];
  for (const [id, name] of [['review', 'review-evidence.ts'], ['guard', 'read-before-edit.ts']]) {
    const bytes = await readFile(join(root, 'packages/her/src/her-core', name));
    await writeFile(join(workspaceRoot, name), bytes);
    sources.push({ id, path: name, sha256: digest(bytes), lines: '1-5' });
  }
  const database = join(dir, 'observation.sqlite');
  const children = new Set(); active.set(database, children);
  t.after(async () => {
    for (const cleanup of children) await cleanup();
    try {
      assert.equal(await readFile(join(memoryRoot, 'sentinel.md'), 'utf8'), 'private sentinel: never read or changed');
    } finally {
      active.delete(database);
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
  return { workspaceRoot, memoryRoot, sources, database };
}
function child(t, config) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const processChild = fork(join(here, 'observer-worker.mjs'), [], {
    env, execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  processChild.stderr.on('data', (b) => { stderr = (stderr + b).slice(-16000); });
  processChild.stdout.resume();
  processChild.on('message', (message) => messages.push(message));
  let exit;
  const ended = new Promise((resolveEnd, reject) => {
    processChild.once('error', reject);
    processChild.once('exit', (code, signal) => { exit = { code, signal }; resolveEnd(exit); });
  });
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 25000);
  const cleanup = async () => { clearTimeout(timer); if (!exit) processChild.kill('SIGKILL'); await ended; };
  active.get(config.database)?.add(cleanup);
  t.after(cleanup);
  processChild.send(config);
  return {
    messages, ended,
    async wait(type) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const message = messages.find((m) => m.type === type);
        if (message) return message;
        if (exit) throw new Error(`child exited ${JSON.stringify(exit)}; ${JSON.stringify(messages)}; ${stderr}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`child deadline waiting for ${type}; ${stderr}`);
    },
    async kill() { processChild.kill('SIGKILL'); const result = await ended; assert.ok(result.signal === 'SIGKILL' || result.code !== 0); },
  };
}
async function run(t, config) {
  const c = child(t, config);
  const result = await c.wait('result');
  assert.equal((await c.ended).code, 0);
  return { ...result, messages: c.messages };
}

test('real Her Cedar policy authorizes the scoped read capability', () => {
  const permission = authorizeHerRead();
  assert.equal(permission.profile, 'plan');
  assert.ok(permission.matched.includes('allow_memory_tools'));
});
test('the actual Her plan policy does not grant writes', () => {
  const verdict = evaluate({
    principal: { type: 'Agent', id: 'samantha' }, action: { type: 'Action', id: 'CallTool' },
    resource: { type: 'Tool', id: 'write' }, context: {},
    entities: [{ uid: { type: 'Agent', id: 'samantha' }, attrs: {}, parents: [] },
      { uid: { type: 'Tool', id: 'write' }, attrs: { name: 'write', destructive: true }, parents: [] }],
    ...policyEnvelope('plan'),
  });
  assert.equal(verdict.decision, 'deny');
});
test('real SDK + Her modules observe repository sources with committed evidence and no private-store writes', { timeout: 30000 }, async (t) => {
  const config = await setup(t);
  const result = await run(t, { ...config, phase: 'start' });
  assert.equal(result.report.status, 'evidence-complete');
  assert.equal(result.report.structuralOnly, true);
  assert.deepEqual(result.delivered.sort(), ['guard', 'review']);
  assert.equal(result.doc.attempts, 2);
  assert.ok(result.doc.authorizations.every((a) => a.profile === 'plan' && a.matched.includes('allow_memory_tools')));
  t.diagnostic(JSON.stringify({ sources: config.sources.map((s) => s.path), status: result.report.status, cedar: result.doc.authorizations }));
});
test('a model claiming success without tool evidence remains pending', { timeout: 30000 }, async (t) => {
  const result = await run(t, { ...await setup(t), phase: 'start', answerOnly: true });
  assert.equal(result.report.status, 'pending'); assert.deepEqual(result.doc.completed, {});
});
test('model-supplied unapproved paths never reach the reader', { timeout: 30000 }, async (t) => {
  const result = await run(t, { ...await setup(t), phase: 'start', unknownId: true });
  assert.equal(result.report.status, 'blocked'); assert.equal(result.doc.attempts, 0);
  assert.ok(!result.messages.some((m) => m.type === 'attempt'));
});
test('permission callback errors and mid-call revocation fail closed', { timeout: 60000 }, async (t) => {
  for (const extra of [{ failAuthorization: true }, { revokeInsideRead: true }]) {
    const result = await run(t, { ...await setup(t), phase: 'start', ...extra });
    assert.equal(result.report.status, 'blocked'); assert.deepEqual(result.doc.completed, {});
  }
});
test('persisted call budget stops subsequent reads and cannot be enlarged on reopen', { timeout: 60000 }, async (t) => {
  const config = { ...await setup(t), maxCalls: 1 };
  const result = await run(t, { ...config, phase: 'start' });
  assert.equal(result.report.status, 'blocked'); assert.equal(result.doc.attempts, 1);
  const reopened = child(t, { ...config, maxCalls: 32, phase: 'inspect' });
  assert.match((await reopened.wait('error')).error, /observer-binding-mismatch/);
  assert.equal((await reopened.ended).code, 1);
});
test('changing an already-observed source invalidates a later final report', { timeout: 60000 }, async (t) => {
  const config = await setup(t);
  assert.equal((await run(t, { ...config, phase: 'start' })).report.status, 'evidence-complete');
  await writeFile(join(config.workspaceRoot, config.sources[0].path), 'changed source');
  const reopened = await run(t, { ...config, phase: 'inspect' });
  assert.equal(reopened.report.status, 'blocked');
  assert.equal(reopened.report.reason, 'source-digest-changed');
  assert.equal(reopened.modelCalls, 0);
});
test('SIGKILL + new process preserves Her evidence, rechecks Cedar and deduplicates the request', { timeout: 60000 }, async (t) => {
  const config = await setup(t);
  const crashed = child(t, { ...config, phase: 'crash' });
  assert.deepEqual((await crashed.wait('checkpoint')).completed, ['review']);
  await crashed.kill();
  const resumed = await run(t, { ...config, phase: 'resume' });
  assert.equal(resumed.report.status, 'evidence-complete'); assert.equal(resumed.userEntries, 1);
  const attempts = [...crashed.messages, ...resumed.messages].filter((m) => m.type === 'attempt');
  assert.equal(attempts.filter((m) => m.sourceId === 'review').length, 1);
  assert.equal(attempts.filter((m) => m.sourceId === 'guard').length, 2);
  assert.equal(resumed.doc.attempts, 3);
  const reattached = await run(t, { ...config, phase: 'inspect' });
  assert.equal(reattached.report.status, 'evidence-complete');
  assert.equal(reattached.modelCalls, 0);
  assert.deepEqual(reattached.doc.completed, resumed.doc.completed);
  t.diagnostic(JSON.stringify({ crash: 'SIGKILL', toolAttempts: { review: 1, guard: 2 }, userEntries: resumed.userEntries,
    reattachedModelCalls: reattached.modelCalls, note: 'Final reporting performs separate bounded source revalidation.' }));
});
test('recovery cannot revive revoked permission or silently change the source manifest', { timeout: 60000 }, async (t) => {
  const config = await setup(t);
  const crashed = child(t, { ...config, phase: 'crash' });
  await crashed.wait('checkpoint'); await crashed.kill();
  const changed = child(t, { ...config, sources: config.sources.map((s) => ({ ...s, lines: '1' })), phase: 'inspect' });
  assert.match((await changed.wait('error')).error, /observer-binding-mismatch/);
  await changed.ended;
  const resumed = await run(t, { ...config, phase: 'resume', allowed: false });
  assert.equal(resumed.report.status, 'blocked');
  assert.deepEqual(Object.keys(resumed.doc.completed), ['review']);
  assert.ok(!resumed.messages.some((m) => m.type === 'attempt'));
});

// Real owner-side endpoint. No model provider is installed in the reporting harness.
async function reportingHost(t, config) {
  const enabled = { value: true };
  const observer = await createHerObserver({ ...config, isEnabled: () => enabled.value });
  const registry = createRegistry(); registry.install(observer.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(config.database), { models: createModels(), registry }, context);
  const root = await harness.root(context);
  await observer.bind(harness, root, context);
  const token = 'e'.repeat(64);
  const service = await serveObserverReport({ observer, harness, root, context, token, sessionId: 'main-session' });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await service.close(); await harness.close(context); };
  active.get(config.database)?.add(close); t.after(close);
  return { harness, root, enabled, connection: { url: service.url, token, manifestId: observer.manifestId } };
}
test('owner-side HTTP report revalidates actual Her evidence without model or tool calls', { timeout: 30000 }, async (t) => {
  const config = await setup(t);
  await run(t, { ...config, phase: 'start' });
  const host = await reportingHost(t, config);
  const before = await host.harness.snapshot(Observation, host.root.id, context);
  const report = await fetchReport(host.connection, 'main-session', new AbortController().signal);
  assert.equal(report.status, 'evidence-complete'); assert.equal(report.sources, 2);
  assert.equal(report.structuralOnly, true);
  assert.deepEqual(await host.harness.snapshot(Observation, host.root.id, context), before);
  assert.ok(!JSON.stringify(report).includes('review-evidence.ts'));
  assert.ok(!JSON.stringify(report).includes(config.workspaceRoot));
  host.enabled.value = false;
  assert.equal((await fetchReport(host.connection, 'main-session', new AbortController().signal)).status, 'blocked');
});
test('loopback endpoint rejects wrong token, session, manifest, browser origins and writes', { timeout: 30000 }, async (t) => {
  const config = await setup(t);
  await run(t, { ...config, phase: 'start' });
  const host = await reportingHost(t, config);
  const headers = { Authorization: `Bearer ${host.connection.token}`, 'X-Her-Session': 'main-session', 'X-Her-Manifest': host.connection.manifestId };
  for (const patch of [{ Authorization: 'wrong' }, { 'X-Her-Session': 'another-session' },
    { 'X-Her-Manifest': '0'.repeat(64) }, { Origin: 'https://example.com' }]) {
    const response = await fetch(host.connection.url, { headers: { ...headers, ...patch } });
    assert.equal(response.status, 403); await response.body?.cancel();
  }
  const response = await fetch(host.connection.url, { method: 'POST', headers });
  assert.equal(response.status, 403); await response.body?.cancel();
  assert.equal((await host.harness.snapshot(Observation, host.root.id, context)).attempts, 2);
});
test('source mutation after service attachment invalidates the next report', { timeout: 30000 }, async (t) => {
  const config = await setup(t);
  await run(t, { ...config, phase: 'start' });
  const host = await reportingHost(t, config);
  await writeFile(join(config.workspaceRoot, config.sources[0].path), 'changed since completed observation');
  assert.equal((await fetchReport(host.connection, 'main-session', new AbortController().signal)).status, 'blocked');
});

// This exercises Pi's actual module loader/API registration. Session persistence
// and UI dispatch remain test sinks, not the user's deployed AgentSession.
test('real Pi loader registers nothing when the report bridge is disabled', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'her-pi-loader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.HER_OBSERVER_REPORT_ENABLED;
  let loaded;
  try {
    process.env.HER_OBSERVER_REPORT_ENABLED = '0';
    loaded = await discoverAndLoadExtensions([join(root, '.pi/extensions/her-observer.ts')], dir, join(dir, 'agent'));
  } finally {
    if (previous === undefined) delete process.env.HER_OBSERVER_REPORT_ENABLED;
    else process.env.HER_OBSERVER_REPORT_ENABLED = previous;
  }
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].commands.size, 0);
  assert.equal(loaded.extensions[0].handlers.size, 0);
  assert.equal(loaded.extensions[0].tools.size, 0);
});
test('real Pi loader command reaches actual Durable/Her HTTP report without triggering a turn', { timeout: 60000 }, async (t) => {
  const config = await setup(t);
  await run(t, { ...config, phase: 'start' });
  const host = await reportingHost(t, config);
  const env = {
    HER_OBSERVER_REPORT_ENABLED: '1', HER_OBSERVER_REPORT_URL: host.connection.url,
    HER_OBSERVER_REPORT_TOKEN: host.connection.token, HER_OBSERVER_REPORT_MANIFEST: host.connection.manifestId,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  let loaded;
  try {
    Object.assign(process.env, env);
    loaded = await discoverAndLoadExtensions([join(root, '.pi/extensions/her-observer.ts')],
      config.workspaceRoot, join(config.workspaceRoot, 'agent-dir'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.tools.size, 0);
  const command = extension.commands.get('her-observer');
  assert.ok(command);
  const entries = [];
  const deliveries = [];
  loaded.runtime.appendEntry = (kind, data) => entries.push({ kind, data });
  loaded.runtime.sendMessage = (message, options) => deliveries.push({ message, options });
  const ctx = { hasUI: false, signal: new AbortController().signal,
    sessionManager: { getSessionId: () => 'main-session' } };
  await command.handler('refresh', ctx);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.report.status, 'evidence-complete');
  assert.equal(deliveries[0].options.triggerTurn, undefined);
  assert.ok(!JSON.stringify(deliveries).includes(host.connection.token));
  for (const handler of extension.handlers.get('session_before_switch') ?? []) await handler({}, ctx);
  await command.handler('status', ctx);
  assert.match(deliveries.at(-1).message.content, /尚无观察回执/);
  assert.equal((await host.harness.snapshot(Observation, host.root.id, context)).attempts, 2);
  t.diagnostic(JSON.stringify({ loader: 'pi-coding-agent@1.0.0', endpoint: 'real Durable + Her',
    providerInstalledInReportHost: false, toolAttempts: 2, triggeredTurns: 0 }));
});
