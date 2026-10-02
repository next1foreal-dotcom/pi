/** Isolated SDK adapter; deliberately never imported by Her's extension entrypoints. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, hook, ToolTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { assertReadAllowed, assertVersions, readApprovedFixture, reviewReceipts, SDK_PACKAGES } from './policy.mjs';

export const context = BACKGROUND_CONTEXT;
export const REQUEST = Object.freeze({ type: 'input', content: 'Read the two approved probe fixtures.',
  requestId: 'her-durable-readonly-v1' });
export const DOC_KIND = 'her.probe-readonly';
export const Receipts = defineDoc({
  kind: DOC_KIND, version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ completed: {} }),
});

async function sdkVersions() {
  const versions = {};
  for (const name of SDK_PACKAGES) {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
      let pkg;
      try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pkg?.name === name) { versions[name] = pkg.version; break; }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`Cannot find installed package metadata for ${name}`);
      dir = parent;
    }
  }
  assertVersions(versions);
  return versions;
}

export function viewSummary(value) {
  return {
    entryIds: value.entries.map((entry) => entry.id),
    entryKinds: value.entries.map((entry) => entry.kind),
    receipts: structuredClone(value.docs[DOC_KIND]?.completed ?? {}),
  };
}

/** All mutable input is host-owned test configuration, never a model-callable configuration tool. */
export async function openProbe({ database, fixtures, phase, replay = 'safe', allowed = true,
  throwInHook = false, onAttempt = async () => {}, onPause = async () => {} }) {
  const versions = await sdkVersions();
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider); // No real provider is ever installed.
  const registry = createRegistry();
  const toolName = replay === 'safe' ? 'her_probe_read' : 'her_probe_read_no_replay';
  const read = defineTool({
    name: toolName,
    description: 'Read a fixed, operator-owned fixture and record only its digest and byte count.',
    parameters: Type.Object({ file: Type.Union([Type.Literal('a'), Type.Literal('b')]) }, { additionalProperties: false }),
    ...(replay === 'safe' ? { replay: 'safe' } : {}),
    execute: async (args, api, callContext) => {
      // Check at execution as well: resume must not reuse permission revoked since the crash.
      assertReadAllowed(args.file, allowed);
      await onAttempt(args.file);
      if (phase === 'crash' && args.file === 'b') {
        await api.details({ stage: 'entered-before-read', file: args.file }, callContext);
        await onPause(callContext);
      }
      const receipt = await readApprovedFixture(fixtures, args.file, allowed);
      await api.commit(async (tx) => {
        const doc = await tx.doc(Receipts, api.conversationId);
        doc.completed[args.file] = receipt;
      }, callContext);
      return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
    },
  });
  registry.install(defineExtension({
    name: 'her-readonly-probe', tools: [read],
    hooks: [hook(ToolTask, {
      beforeTool: () => {
        if (throwInHook) throw new Error('Injected probe authorization failure.');
        return allowed ? undefined : { block: 'Probe read permission revoked.' };
      },
    })],
  }));
  const call = (file) => fauxAssistantMessage([fauxToolCall(toolName, { file }, { id: `read-${file}` })],
    { stopReason: 'toolUse' });
  faux.setResponses(phase === 'inspect' ? [] : phase === 'resume' ? [fauxAssistantMessage('probe response')] :
    [call('a'), call('b'), fauxAssistantMessage('probe response')]);
  const reports = [];
  const harness = await Harness.open(await openNodeSqliteStorage(database), {
    models, registry,
    settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, toolExecution: 'sequential' },
    onReport: (error) => { reports.push(String(error)); },
  }, context);
  const root = await harness.root(context, { agent: {
    model: { provider: 'faux', modelId: 'faux-1' }, tools: [read],
    instructions: 'Only inspect the two approved test fixtures. A response is not an acceptance verdict.',
  } });
  return { harness, root, faux, versions, reports };
}

export async function reportProbe(opened, settled) {
  const { root, harness, faux } = opened;
  const entries = (await root.entries({}, 1000, undefined, context)).items;
  const toolResults = entries.filter((entry) => entry.kind === 'pi.tool-result')
    .flatMap((entry) => entry.model ?? []).filter((message) => message.role === 'toolResult');
  const receipts = (await harness.snapshot(Receipts, root.id, context))?.completed ?? {};
  const watch = await root.watch(context);
  const reconnected = viewSummary(watch.value);
  await watch.stop();
  return {
    node: process.versions.node, versions: opened.versions, conversationId: root.id,
    submissionId: settled.id, submissionStatus: settled.status,
    observerStatus: reviewReceipts(receipts, toolResults),
    receipts, userEntryCount: entries.filter((entry) => entry.kind === 'pi.user').length,
    toolResults: toolResults.map((r) => ({ toolCallId: r.toolCallId, toolName: r.toolName, isError: r.isError,
      text: r.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') })),
    modelCalls: faux.state.callCount, reconnected, reports: opened.reports,
  };
}
