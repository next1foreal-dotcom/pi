/** Run the same checked-in validation driver on two isolated checkouts, without provider credentials. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareResults, modelDataFingerprint, parseResults } from './workspace-comparison.mjs';
import { runStage } from './validation-stage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [basePath, headPath, outputPath] = process.argv.slice(2);
if (!basePath || !headPath || !outputPath) throw new Error('usage: workspace-gates.mjs BASE_CHECKOUT HEAD_CHECKOUT OUTPUT_DIR');
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const npm = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync);
if (!npm) throw new Error('npm-cli-not-found');
const revisions = {};
for (const [label, directory] of [['base', basePath], ['head', headPath]]) {
  const cwd = resolve(directory);
  const env = {};
  // Do not inherit LLM endpoints, tokens, private memory or a global Cedar profile.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI', 'GITHUB_ACTIONS', 'SystemRoot', 'WINDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HER_MEMORY_DIR = join(output, `${label}-memory`);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', shell: false });
  if (revision.status !== 0) throw new Error(`cannot-identify-${label}-revision`);
  const stages = [];
  const run = (name, args, timeout) => {
    const stage = runStage(`${label}:${name}`, process.execPath, args, { cwd, env, timeout });
    stages.push(stage); return stage.outcome === 'passed';
  };
  const metadata = { sha: revision.stdout.trim(), node: process.versions.node, stages };
  revisions[label] = metadata;
  const installed = run('install', [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 600000);
  if (installed) {
    // Existing data-only generator; never fake missing provider JSON or edit generated TS by hand.
    run('hydrate', [npm, 'run', 'hydrate:model-data'], 600000);
    run('model-data-check', [npm, 'run', 'check:model-data'], 120000);
    const dataDir = join(cwd, 'packages/ai/src/providers/data');
    if (existsSync(dataDir)) {
      try {
        const entries = [];
        for (const file of (await readdir(dataDir)).sort()) entries.push([file, await readFile(join(dataDir, file))]);
        metadata.modelDataSha256 = modelDataFingerprint(entries);
      } catch (error) { metadata.modelDataError = error.message; }
    }
    metadata.lockSha256 = createHash('sha256').update(await readFile(join(cwd, 'package-lock.json'))).digest('hex');
    const testFiles = (await readdir(join(cwd, 'packages/her/test')))
      .filter((file) => file.endsWith('.test.ts')).sort().map((file) => `packages/her/test/${file}`);
    const resultsPath = join(output, `${label}-tests.jsonl`);
    run('tests', ['--import', 'tsx', '--test', '--test-reporter=dot',
      `--test-reporter=${pathToFileURL(join(here, 'workspace-reporter.mjs')).href}`, '--test-reporter-destination=stdout',
      `--test-reporter-destination=${resultsPath}`, ...testFiles], 600000);
    try { metadata.tests = parseResults(await readFile(resultsPath, 'utf8')); }
    catch (error) { metadata.resultsError = error.message; }
    run('check', [npm, 'run', 'check'], 600000);
    runStage(`${label}:generated-edits`, 'git', ['status', '--short'], { cwd, env, timeout: 30000 });
  }
}
let comparison;
if (revisions.base.tests && revisions.head.tests) {
  comparison = compareResults(revisions.base.tests, revisions.head.tests);
} else comparison = { verdict: 'inconclusive', warning: 'At least one revision has no complete machine-readable test stream.' };
comparison.environmentMatches = Boolean(revisions.base.modelDataSha256 &&
  revisions.base.modelDataSha256 === revisions.head.modelDataSha256 &&
  revisions.base.lockSha256 === revisions.head.lockSha256);
comparison.revisions = Object.fromEntries(Object.entries(revisions).map(([label, { tests, ...metadata }]) => [label, metadata]));
comparison.rolloutReady = false; // These gates do not validate primary-session/browser integration.
const serialized = JSON.stringify(comparison, null, 2);
await writeFile(join(output, 'comparison.json'), `${serialized}\n`);
console.log(`HER_WORKSPACE_COMPARISON\n${serialized}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const counts = Object.fromEntries(Object.entries(comparison).filter(([, value]) => Array.isArray(value)).map(([name, rows]) => [name, rows.length]));
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Her workspace evidence\n\nDiagnostic only; no rollout approval. Full details are in the job log.\n\n\`\`\`json\n${JSON.stringify({
    counts, base: comparison.base, head: comparison.head, environmentMatches: comparison.environmentMatches,
    revisions: comparison.revisions }, null, 2)}\n\`\`\`\n`);
}
if (Object.values(revisions).some((revision) => !revision.tests || !revision.tests.summary.success || revision.stages.some((stage) => stage.outcome !== 'passed')) ||
  !comparison.environmentMatches || comparison.missingFromHead?.length || comparison.lostVerification?.length || comparison.newUnverified?.length) {
  process.exitCode = 1;
}
