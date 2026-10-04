import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyEvidence, verifyEvidenceContent } from '../../src/her-core/review-evidence.ts';
import { createSourceScope, digest, MAX_SOURCE_BYTES, parseSources } from './observer-scope.mjs';

const item = (extra = {}) => ({ id: 'source', path: 'src/example.ts', sha256: digest('one\ntwo\n'), lines: '1-2', ...extra });
async function workspace(t, content = 'one\ntwo\n') {
  const dir = await mkdtemp(join(tmpdir(), 'her-observer-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'her-memory'));
  await writeFile(join(dir, 'src/example.ts'), content);
  const config = { workspaceRoot: dir, memoryRoot: join(dir, 'her-memory'), sources: [item({ sha256: digest(content) })] };
  return { dir, config, scope: await createSourceScope(config) };
}

test('host manifest rejects missing/duplicate sources and non-string IDs', () => {
  for (const raw of [[], null, [item(), item()], [item({ id: undefined })], [item({ id: '__proto__' })],
    [item({ sha256: 'bad' })], [item({ lines: 'nan' })]]) assert.throws(() => parseSources(raw));
});
test('portable manifest rejects traversal, hidden/private paths and device names', () => {
  for (const path of ['../x.ts', '/x.ts', 'C:/x.ts', 'src\\x.ts', 'src/.env', 'her-memory/a.md', 'samantha/journal/a.md',
    'src/../a.ts', 'src/con.txt', 'node_modules/a.js', 'src/x.pem', 'src/x.ts ', '.git/config']) {
    assert.throws(() => parseSources([item({ path })]), path);
  }
});
test('unknown IDs cannot turn into arbitrary paths', async (t) => {
  const { scope } = await workspace(t);
  for (const id of ['../src/example.ts', 'constructor', 'source/not', undefined]) await assert.rejects(scope.read(id));
});
test('bounded reads return structural receipts, not source content', async (t) => {
  const { scope, dir } = await workspace(t);
  const receipt = await scope.read('source');
  assert.equal(receipt.sha256, item().sha256);
  assert.equal(receipt.bytes, 8);
  assert.equal(receipt.structuralOnly, true);
  assert.ok(!JSON.stringify(receipt).includes('one\ntwo'));
  assert.equal(await readFile(join(dir, 'src/example.ts'), 'utf8'), 'one\ntwo\n');
});
test('wrong line ranges use Her evidence semantics and are rejected', async (t) => {
  const { config } = await workspace(t);
  config.sources[0].lines = '10-20';
  const scope = await createSourceScope(config);
  await assert.rejects(scope.read('source'), /source-lines-unverified/);
});
test('the shared helper preserves legacy line checks', async (t) => {
  const { dir } = await workspace(t);
  for (const lines of [undefined, '1', '1-2', '1 - 2', '0', '3-2', '10', 'bad']) {
    const evidence = { file: 'src/example.ts', lines, claim: 'untrusted claim' };
    assert.deepEqual(verifyEvidence([evidence], dir)[0], verifyEvidenceContent(evidence, 'one\ntwo\n'));
  }
  assert.equal(verifyEvidence([{ file: '../missing.ts', claim: 'x' }], dir)[0].verified, false);
  assert.equal(verifyEvidence([{ file: 'missing.ts', claim: 'x' }], dir)[0].verified, false);
});
test('changed bytes invalidate the operator digest', async (t) => {
  const { scope, dir } = await workspace(t);
  await writeFile(join(dir, 'src/example.ts'), 'modified');
  await assert.rejects(scope.read('source'), /source-digest-changed/);
});
test('source and parent symlinks are rejected', async (t) => {
  const { dir, scope } = await workspace(t);
  await writeFile(join(dir, 'target.ts'), 'one\ntwo\n');
  await rm(join(dir, 'src/example.ts'));
  await symlink(join(dir, 'target.ts'), join(dir, 'src/example.ts'), 'file');
  await assert.rejects(scope.read('source'), /source-link/);
  await rm(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'other'));
  await writeFile(join(dir, 'other/example.ts'), 'one\ntwo\n');
  await symlink(join(dir, 'other'), join(dir, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(scope.read('source'), /source-link/);
});
test('hard links cannot be used to read a second alias', async (t) => {
  const { dir, scope } = await workspace(t);
  await link(join(dir, 'src/example.ts'), join(dir, 'alias.ts'));
  await assert.rejects(scope.read('source'), /source-not-bounded-file/);
});
test('byte limit applies to reads, with exact limit accepted', async (t) => {
  const { config, dir } = await workspace(t, 'x'.repeat(MAX_SOURCE_BYTES));
  config.sources[0].lines = '1';
  assert.equal((await (await createSourceScope(config)).read('source')).bytes, MAX_SOURCE_BYTES);
  const large = 'x'.repeat(MAX_SOURCE_BYTES + 1);
  await writeFile(join(dir, 'src/example.ts'), large);
  config.sources[0].sha256 = digest(large);
  await assert.rejects((await createSourceScope(config)).read('source'), /source-not-bounded-file/);
});
test('binary or invalid UTF-8 files cannot become text evidence', async (t) => {
  const { config, dir } = await workspace(t);
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from([0, 1])]) {
    await writeFile(join(dir, 'src/example.ts'), bytes);
    config.sources[0].sha256 = digest(bytes);
    await assert.rejects((await createSourceScope(config)).read('source'));
  }
});
test('missing roots, private workspaces and cancelled reads fail closed', async (t) => {
  const { config, scope, dir } = await workspace(t);
  await assert.rejects(createSourceScope({ ...config, memoryRoot: undefined }));
  await assert.rejects(createSourceScope({ ...config, workspaceRoot: config.memoryRoot }));
  await assert.rejects(createSourceScope({ ...config, memoryRoot: join(dir, 'not-there') }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scope.read('source', controller.signal));
});
test('source selection and root identity are part of the persisted binding', async (t) => {
  const { config, scope } = await workspace(t);
  config.sources[0].lines = '1';
  const other = await createSourceScope(config);
  assert.notEqual(scope.manifestId, other.manifestId);
  assert.throws(() => { scope.sources[0].path = 'other.ts'; });
});
