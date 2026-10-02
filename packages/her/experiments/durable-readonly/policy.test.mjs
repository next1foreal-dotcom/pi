import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertReadAllowed, assertVersions, MAX_BYTES, probeEnvironment, readApprovedFixture,
  reviewReceipts, SDK_PACKAGES } from './policy.mjs';

const versions = Object.fromEntries(SDK_PACKAGES.map((name) => [name, '1.0.0']));
const fixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'her-probe-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  await writeFile(join(root, 'b.txt'), 'bravo');
  return root;
};

test('requires every SDK package to be exactly 1.0.0', () => {
  assert.doesNotThrow(() => assertVersions(versions, '24.0.0'));
  assert.doesNotThrow(() => assertVersions(versions, '22.19.0'));
  for (const name of SDK_PACKAGES) {
    for (const version of ['0.87.0', '1.0.1', undefined]) {
      assert.throws(() => assertVersions({ ...versions, [name]: version }, '24.0.0'), /expected/);
    }
  }
});
test('unsupported or malformed Node versions fail rather than skip', () => {
  for (const version of ['22.16.0', '20.19.0', 'unknown']) {
    assert.throws(() => assertVersions(versions, version), /Node/);
  }
});
test('file IDs cannot carry paths, traversal, prototypes, or URLs', () => {
  for (const file of ['../a', '/etc/passwd', 'C:\\private', '__proto__', 'constructor', 'https://example.com', '', null, {}]) {
    assert.throws(() => assertReadAllowed(file), /fixture/);
  }
});
test('revocation is checked before any file operation', async () => {
  await assert.rejects(readApprovedFixture('/does-not-exist', 'a', false), /permission denied/);
  assert.throws(() => assertReadAllowed('a', 'true'), /permission denied/);
});
test('read returns digest and byte count without modifying or exposing contents', async (t) => {
  const root = await fixture(t);
  const receipt = await readApprovedFixture(root, 'a');
  assert.deepEqual(receipt, { file: 'a', bytes: 5, digest: createHash('sha256').update('alpha').digest('hex') });
  assert.equal(JSON.stringify(receipt).includes('alpha'), false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha');
});
test('rejects missing files and directories', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'a.txt'));
  await assert.rejects(readApprovedFixture(root, 'a'));
  await mkdir(join(root, 'a.txt'));
  await assert.rejects(readApprovedFixture(root, 'a'), /regular/);
});
test('rejects symbolic links even when they point to another approved file', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'a.txt'));
  await symlink(join(root, 'b.txt'), join(root, 'a.txt'));
  await assert.rejects(readApprovedFixture(root, 'a'), /regular/);
});
test('enforces the byte limit and permits the exact limit', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'a.txt'), Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(readApprovedFixture(root, 'a'), /budget/);
  await writeFile(join(root, 'a.txt'), Buffer.alloc(MAX_BYTES));
  assert.equal((await readApprovedFixture(root, 'a')).bytes, MAX_BYTES);
});
test('accepts an empty approved file without pretending it has content', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'a.txt'), '');
  assert.equal((await readApprovedFixture(root, 'a')).bytes, 0);
});
test('child environment excludes provider secrets and execution overrides', () => {
  assert.deepEqual(probeEnvironment({ PATH: '/bin', TEMP: '/tmp', OPENAI_API_KEY: 'fixture',
    ANTHROPIC_API_KEY: 'fixture', NODE_OPTIONS: '--import anything', HTTPS_PROXY: 'fixture' }),
  { PATH: '/bin', TEMP: '/tmp' });
});
test('two receipts and actual successful tool results are required', () => {
  const receipts = Object.fromEntries(['a', 'b'].map((file) => [file, { file, bytes: 5, digest: 'a'.repeat(64) }]));
  const results = ['a', 'b'].map((file) => ({ toolCallId: `read-${file}`, isError: false }));
  assert.equal(reviewReceipts(receipts, results), 'verified');
  assert.equal(reviewReceipts({ a: receipts.a }, results), 'blocked');
  assert.equal(reviewReceipts(receipts, []), 'blocked');
  assert.equal(reviewReceipts(receipts, [{ ...results[0], isError: true }, results[1]]), 'blocked');
});
test('malformed receipts and unknown failures cannot become verified', () => {
  const receipts = { a: { file: 'a', bytes: -1, digest: 'a'.repeat(64) },
    b: { file: 'b', bytes: 0, digest: 'a'.repeat(64) } };
  const results = [{ toolCallId: 'read-a', isError: false }, { toolCallId: 'read-b', isError: false }];
  assert.equal(reviewReceipts(receipts, results), 'blocked');
  receipts.a.bytes = 0;
  assert.equal(reviewReceipts(receipts, [...results, { toolCallId: 'unknown', isError: true }]), 'blocked');
});
