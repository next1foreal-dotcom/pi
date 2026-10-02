/** Explicit isolated validation; installs no packages into the user's Pi workspace. */
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBSERVER_TIMEOUTS, requireStage } from './validation-stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node >=22.19.0 required; use Node 24 for the CI probe.');
const temp = await mkdtemp(join(tmpdir(), 'her-real-observer-'));
const run = (stage, args) => requireStage(stage, process.execPath, args, { cwd: temp, timeout: OBSERVER_TIMEOUTS[stage] });
try {
  const dependencies = { '@earendil-works/chord': '1.0.0', '@earendil-works/pi-ai': '1.0.0',
    '@earendil-works/pi-durable': '1.0.0', '@cedar-policy/cedar-wasm': '4.11.1',
    '@earendil-works/pi-coding-agent': '1.0.0', 'typescript': '5.9.3', '@types/node': '22.19.19' };
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
    overrides: { '@earendil-works/chord': '1.0.0', '@earendil-works/pi-ai': '1.0.0' } }, null, 2));
  const experiment = 'packages/her/experiments/durable-readonly';
  const files = ['observer-scope.mjs', 'observer-scope.test.mjs', 'her-observer.mjs', 'observer-worker.mjs', 'observer-sdk.test.mjs', 'observer-report-server.mjs',
    'validation-stage.mjs', 'workspace-reporter.mjs', 'workspace-comparison.mjs', 'workspace-validation.test.mjs']
    .map((file) => `${experiment}/${file}`);
  files.push(...['lib/cedar.ts', 'lib/governed-tools.ts', 'lib/audit.ts', 'rsi/anchors.ts',
    'her-core/review-evidence.ts', 'her-core/read-before-edit.ts', 'observer-report/protocol.ts', 'observer-report/extension.ts'].map((file) => `packages/her/src/${file}`));
  files.push('packages/her/test/observer-report.test.ts', '.pi/extensions/her-observer.ts');
  for (const path of files) {
    await mkdir(dirname(join(temp, path)), { recursive: true });
    await copyFile(join(root, path), join(temp, path));
  }
  await cp(join(root, 'packages/her/pi-package/policies'), join(temp, 'packages/her/pi-package/policies'), { recursive: true });
  // Invoke npm's JS entrypoint directly. No Windows shell string / argument concatenation.
  const npm = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
  if (!npm) throw new Error('Cannot find npm CLI alongside this Node installation.');
  run('install', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
  for (const [name, wanted] of Object.entries(dependencies)) {
    const pkg = JSON.parse(await readFile(join(temp, 'node_modules', name, 'package.json'), 'utf8'));
    if (pkg.version !== wanted) throw new Error(`SDK mismatch: ${name}@${pkg.version}`);
  }
  console.log(JSON.stringify({ node: process.versions.node, dependencies, integration: 'real Her Cedar + real Her evidence helper' }));
  run('inventory', [npm, 'ls', '--depth=0']);
  await writeFile(join(temp, 'tsconfig.report.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: ['node'] },
    files: ['packages/her/src/observer-report/extension.ts', 'packages/her/src/observer-report/protocol.ts',
      'packages/her/test/observer-report.test.ts', '.pi/extensions/her-observer.ts'],
  }, null, 2));
  run('typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.report.json']);
  run('tests', ['--experimental-strip-types', '--test', '--test-concurrency=1',
    `${experiment}/workspace-validation.test.mjs`, `${experiment}/observer-scope.test.mjs`, `${experiment}/observer-sdk.test.mjs`,
    'packages/her/test/observer-report.test.ts']);
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
