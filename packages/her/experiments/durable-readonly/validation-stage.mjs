/** Bounded validation stages. A failed/unfinished process is never a passing gate. */
import { spawnSync } from 'node:child_process';

export const OBSERVER_TIMEOUTS = Object.freeze({ install: 600000, inventory: 120000, typecheck: 240000, tests: 240000 });

export function runStage(name, command, args, options, spawn = spawnSync, log = console.log) {
  const { timeout, ...rest } = options;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('validation-timeout-required');
  log(JSON.stringify({ stage: name, event: 'start', timeoutMs: timeout }));
  const start = Date.now();
  const child = spawn(command, args, { ...rest, timeout, stdio: 'inherit', shell: false });
  const result = {
    name, outcome: !child.error && child.status === 0 && !child.signal ? 'passed' : 'failed',
    exitCode: child.status ?? null, signal: child.signal ?? null,
    error: child.error?.code ?? null, elapsedMs: Date.now() - start,
  };
  log(JSON.stringify({ ...result, event: 'end' }));
  return result;
}

export function requireStage(name, command, args, options) {
  const result = runStage(name, command, args, options);
  if (result.outcome !== 'passed') {
    throw new Error(`validation stage ${name} failed: ${result.error ?? result.signal ?? result.exitCode}`);
  }
  return result;
}
