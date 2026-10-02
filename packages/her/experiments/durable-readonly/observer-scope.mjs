/** A host-selected source manifest. Never accepts a model-provided path. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { verifyEvidenceContent } from '../../src/her-core/review-evidence.ts';

export const MAX_SOURCE_BYTES = 64 * 1024;
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html', '.yaml', '.yml']);
const ID = /^[A-Za-z0-9_-]{1,48}$/;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

export function parseSources(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw new Error('manifest-size');
  const result = raw.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ID.test(item.id) || ['constructor', 'prototype', '__proto__'].includes(item.id)) throw new Error('source-id');
    if (typeof item.path !== 'string' || item.path.length > 512 || /[\\:\x00-\x1f]/.test(item.path)) throw new Error('source-path');
    const segments = item.path.split('/');
    if (segments.some((s) => !s || s.startsWith('.') || /[. ]$/.test(s) || /^(?:her-memory|node_modules|samantha)$/i.test(s) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) throw new Error('source-path');
    if (!EXTENSIONS.has(extname(item.path).toLowerCase())) throw new Error('source-type');
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('source-digest');
    if (typeof item.lines !== 'string' || !/^\d+(?:-\d+)?$/.test(item.lines) || item.lines.length > 24) throw new Error('source-lines');
    return Object.freeze({ id: item.id, path: item.path, sha256: item.sha256, lines: item.lines });
  });
  if (new Set(result.map((s) => s.id)).size !== result.length || new Set(result.map((s) => s.path.toLowerCase())).size !== result.length) throw new Error('duplicate-source');
  return Object.freeze(result);
}

export async function createSourceScope({ workspaceRoot, memoryRoot, sources }) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || typeof memoryRoot !== 'string' || !isAbsolute(memoryRoot)) throw new Error('explicit-roots-required');
  // Both roots must exist; do not silently guess the location of Her's private store.
  const workspace = await realpath(workspaceRoot);
  const memory = await realpath(memoryRoot);
  if (!(await lstat(workspace)).isDirectory() || !(await lstat(memory)).isDirectory() || within(memory, workspace)) throw new Error('workspace-is-private');
  const manifest = parseSources(sources);
  const manifestId = digest(JSON.stringify({ workspace, memory, sources: manifest, maxBytes: MAX_SOURCE_BYTES }));
  const sourceFor = (id) => {
    if (typeof id !== 'string') throw new Error('source-id');
    const source = manifest.find((s) => s.id === id);
    if (!source) throw new Error('source-not-approved');
    return source;
  };
  return {
    manifestId, sources: manifest,
    async read(id, signal) {
      signal?.throwIfAborted();
      const source = sourceFor(id);
      // Re-resolve the roots on every read, including recovery and final validation.
      if (await realpath(workspaceRoot) !== workspace || await realpath(memoryRoot) !== memory) throw new Error('root-changed');
      let target = workspace;
      const segments = source.path.split('/');
      for (const [index, part] of segments.entries()) {
        target = join(target, part);
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) throw new Error('source-link');
      }
      const canonical = await realpath(target);
      if (!within(workspace, canonical) || within(memory, canonical) || canonical !== resolve(target)) throw new Error('source-outside-scope');
      const before = await lstat(target);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_SOURCE_BYTES) throw new Error('source-not-bounded-file');
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('source-changed');
        // Limit the allocation and read itself, not merely an earlier file-size check.
        const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          signal?.throwIfAborted();
          const read = await handle.read(bytes, size, bytes.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        const after = await handle.stat();
        if (size > MAX_SOURCE_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('source-changed');
        const content = bytes.subarray(0, size);
        if (digest(content) !== source.sha256) throw new Error('source-digest-changed');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        if (text.includes('\0')) throw new Error('source-binary');
        // Reuse Her's existing line-evidence semantics on this bounded, authorized snapshot.
        const evidence = verifyEvidenceContent({ file: source.path, lines: source.lines, claim: 'Selected source lines are readable.' }, text);
        if (evidence.verified !== true) throw new Error('source-lines-unverified');
        signal?.throwIfAborted();
        return { sourceId: source.id, path: source.path, lines: source.lines, sha256: source.sha256, bytes: size, structuralOnly: true };
      } finally { await handle.close(); }
    },
  };
}
