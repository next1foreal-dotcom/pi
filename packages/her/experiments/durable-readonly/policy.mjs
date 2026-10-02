/** Probe-only policy. No SDK, model calls, shell commands, or project writes. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const SDK_VERSION = '1.0.0';
export const SDK_PACKAGES = Object.freeze([
  '@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-durable',
]);
export const MAX_BYTES = 64 * 1024;
export const FILES = Object.freeze({ a: 'a.txt', b: 'b.txt' });

export function assertVersions(versions, nodeVersion = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new Error('The SDK probe requires Node >=22.19.0; CI uses Node 24.');
  }
  for (const name of SDK_PACKAGES) {
    if (versions[name] !== SDK_VERSION) {
      throw new Error(`${name}: expected ${SDK_VERSION}, got ${versions[name] ?? 'missing'}`);
    }
  }
}

export function assertReadAllowed(file, allowed = true) {
  if (allowed !== true) throw new Error('Probe read permission denied.');
  if (typeof file !== 'string' || !Object.hasOwn(FILES, file)) {
    throw new Error('Only the operator-owned fixture IDs a and b are allowed.');
  }
}

/** Return a bounded receipt, never file contents. Only fixed, direct children can be read. */
export async function readApprovedFixture(root, file, allowed = true) {
  assertReadAllowed(file, allowed);
  const base = await realpath(root);
  const target = join(base, FILES[file]);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Fixture must be a regular, non-symlink file.');
  if (before.size > MAX_BYTES) throw new Error('Fixture exceeds the read budget.');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Fixture changed while opening.');
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error('Fixture exceeds the read budget.');
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || total !== after.size) {
      throw new Error('Fixture changed during the read.');
    }
    return { file, bytes: total, digest: createHash('sha256').update(buffer.subarray(0, total)).digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Child probes deliberately do not inherit credentials, NODE_OPTIONS, or proxy settings. */
export function probeEnvironment(env = process.env) {
  const result = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) {
    if (typeof env[key] === 'string') result[key] = env[key];
  }
  return result;
}

export function reviewReceipts(receipts, toolResults) {
  const complete = ['a', 'b'].every((file) => {
    const receipt = receipts?.[file];
    return receipt?.file === file && Number.isInteger(receipt.bytes) && receipt.bytes >= 0 &&
      receipt.bytes <= MAX_BYTES && /^[a-f0-9]{64}$/.test(receipt.digest ?? '');
  });
  const successfulTools = ['a', 'b'].every((file) => toolResults.some((r) =>
    r.toolCallId === `read-${file}` && r.isError === false));
  return complete && successfulTools && toolResults.every((r) => r.isError === false) ? 'verified' : 'blocked';
}
