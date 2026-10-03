/** Explicit operator/CI command. Installs in a disposable directory, never the Pi workspace. */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersions, SDK_PACKAGES, SDK_VERSION } from './policy.mjs';

assertVersions(Object.fromEntries(SDK_PACKAGES.map((name) => [name, SDK_VERSION])));
const source = dirname(fileURLToPath(import.meta.url));
const stage = await mkdtemp(join(tmpdir(), 'her-durable-sdk-'));
function run(command, args, shell = false) {
  const result = spawnSync(command, args, { cwd: stage, shell, stdio: 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: exit=${result.status}, signal=${result.signal}`);
}
try {
  for (const name of ['package.json', 'host.mjs', 'worker.mjs', 'policy.mjs', 'policy.test.mjs', 'integration.test.mjs']) {
    await copyFile(join(source, name), join(stage, name));
  }
  console.log(`Isolated SDK probe: Node ${process.versions.node}; SDK ${SDK_VERSION}; no Pi workspace install.`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows requires a shell for npm.cmd; arguments are fixed, never user input.
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false'], process.platform === 'win32');
  run(npm, ['ls', '--all'], process.platform === 'win32');
  run(process.execPath, ['--test', '--test-concurrency=1', 'policy.test.mjs', 'integration.test.mjs']);
} finally {
  await rm(stage, { recursive: true, force: true });
}
