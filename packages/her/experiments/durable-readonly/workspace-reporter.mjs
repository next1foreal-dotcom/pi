/** Node TestsStream adapter: stable file/suite/name identities, not parsed console glyphs. */
import { isAbsolute, relative } from 'node:path';

export function testPath(file, cwd = process.cwd()) {
  if (!file) return '<unknown>';
  return (isAbsolute(file) ? relative(cwd, file) : file).replaceAll('\\', '/');
}

export default async function* report(source) {
  const parents = new Map();
  const stderr = new Map();
  for await (const { type, data } of source) {
    const file = testPath(data.file);
    if (type === 'test:stderr') {
      stderr.set(file, `${stderr.get(file) ?? ''}${data.message}`.slice(-8192));
    } else if (type === 'test:start') {
      const stack = parents.get(file) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      parents.set(file, stack);
    } else if (type === 'test:pass' || type === 'test:fail') {
      const error = data.details?.error;
      const names = [...(parents.get(file) ?? []).slice(0, data.nesting),
        data.name === data.file || isAbsolute(data.name) ? testPath(data.name) : data.name];
      // Suites and failed file containers are evidence too, but are not extra leaf-test counts.
      yield `${JSON.stringify({ kind: 'result', id: JSON.stringify([file, ...names]), file, names,
        line: data.line ?? null, type: data.details?.type ?? 'test',
        outcome: data.skip ? 'skipped' : data.todo ? 'todo' : type === 'test:pass' ? 'passed' : 'failed',
        failureType: error?.failureType ?? null, code: error?.cause?.code ?? error?.code ?? null,
        message: error ? String(error.cause?.message ?? error.message).slice(0, 2048) : null,
        stderrTail: type === 'test:fail' ? stderr.get(file) ?? '' : '',
      })}\n`;
    } else if (type === 'test:summary' && !data.file) {
      yield `${JSON.stringify({ kind: 'summary', counts: data.counts, success: data.success })}\n`;
    }
  }
}
