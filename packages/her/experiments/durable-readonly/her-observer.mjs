/** Opt-in, model-neutral Her adapter for a dedicated Durable conversation. */
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool, hook, LiveDoc, ToolTask } from '@earendil-works/pi-durable';
import { evaluate, policyEnvelope } from '../../src/lib/cedar.ts';
import { resolveGovernedTool } from '../../src/lib/governed-tools.ts';
import { createSourceScope } from './observer-scope.mjs';

export const OBSERVER_TOOL = 'her_observe_source';
export const OBSERVER_DOC_KIND = 'her.readonly-observation';
export const Observation = defineDoc({
  kind: OBSERVER_DOC_KIND, version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ manifestId: '', maxCalls: 0, attempts: 0, completed: {}, authorizations: [] }),
});

/** A narrower implementation of Her's existing read capability, never an invented permit. */
export function authorizeHerRead() {
  const name = 'read';
  const tool = resolveGovernedTool(name);
  if (!tool.registered || tool.destructive) throw new Error('read-capability-unavailable');
  const verdict = evaluate({
    principal: { type: 'Agent', id: 'samantha' },
    action: { type: 'Action', id: 'CallTool' },
    resource: { type: 'Tool', id: name }, context: {},
    entities: [
      { uid: { type: 'Agent', id: 'samantha' }, attrs: {}, parents: [] },
      { uid: { type: 'Tool', id: name }, attrs: { name, destructive: tool.destructive }, parents: [] },
    ],
    ...policyEnvelope('plan'), // Existing read-only policy; never inherit the full-permission profile.
  });
  if (verdict.decision !== 'allow') throw new Error('cedar-read-denied');
  return { profile: 'plan', capability: name, matched: verdict.matched };
}

/**
 * The caller owns models, storage and lifetime. This installs no provider, worker,
 * timer, memory writer or automatic continuation. isEnabled is a host callback.
 */
export async function createHerObserver({ workspaceRoot, memoryRoot, sources, isEnabled,
  maxCalls = 32, onBeforeRead = async () => {} }) {
  if (typeof isEnabled !== 'function' || typeof onBeforeRead !== 'function') throw new Error('host-callback-required');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) throw new Error('observer-budget');
  const scope = await createSourceScope({ workspaceRoot, memoryRoot, sources });
  const authorize = async (signal) => {
    signal?.throwIfAborted();
    if (await isEnabled() !== true) throw new Error('observer-disabled');
    signal?.throwIfAborted();
    return authorizeHerRead();
  };
  const assertBinding = (doc) => {
    if (!doc || doc.manifestId !== scope.manifestId || doc.maxCalls !== maxCalls || !Number.isSafeInteger(doc.attempts) ||
        doc.attempts < 0 || doc.attempts > maxCalls) throw new Error('observer-binding-mismatch');
  };
  const read = defineTool({
    name: OBSERVER_TOOL, replay: 'safe',
    description: `Observe operator-selected sources (${scope.sources.map((s) => s.id).join(', ')}). ` +
      'Returns hashes and file/line evidence only, never source text. Evidence is structural, not a correctness verdict.',
    parameters: Type.Object({ sourceId: Type.Union(scope.sources.map((s) => Type.Literal(s.id))) }, { additionalProperties: false }),
    execute: async (args, api, context) => {
      const permission = await authorize(context.abortSignal);
      await api.commit(async (tx) => {
        const doc = await tx.doc(Observation, api.conversationId);
        assertBinding(doc);
        if (doc.attempts >= maxCalls) throw new Error('observer-budget-exhausted');
        doc.attempts++;
        doc.authorizations.push({ taskId: api.taskId, ...permission });
      }, context);
      await api.details({ sourceId: args.sourceId, stage: 'authorized-before-read' }, context);
      // Host instrumentation may pause a call for a crash test. It cannot grant permission.
      await onBeforeRead(args.sourceId, api, context);
      await authorize(context.abortSignal);
      const receipt = await scope.read(args.sourceId, context.abortSignal);
      await authorize(context.abortSignal); // Revocation/cancellation during a read cannot publish evidence.
      const stored = { ...receipt, manifestId: scope.manifestId, taskId: api.taskId };
      await api.commit(async (tx) => {
        const doc = await tx.doc(Observation, api.conversationId);
        assertBinding(doc);
        doc.completed[args.sourceId] = stored;
      }, context);
      return { content: [{ type: 'text', text: JSON.stringify(stored) }] };
    },
  });
  const extension = defineExtension({
    name: 'her-readonly-observer', tools: [read],
    hooks: [hook(ToolTask, { beforeTool: async (call) => {
      if (call.name !== OBSERVER_TOOL) return { block: 'This dedicated Her observer only permits source observation.' };
      await authorize(); // Exceptions remain refusals, never permission grants.
    } })],
  });
  return {
    extension, tool: read, manifestId: scope.manifestId,
    async bind(harness, root, context) {
      // Bind BEFORE starting pending tasks. Reopening cannot silently replace the acceptance scope or budget.
      await root.commit(async (tx) => {
        const doc = await tx.doc(Observation, root.id);
        if (!doc.manifestId) {
          doc.manifestId = scope.manifestId;
          doc.maxCalls = maxCalls;
        }
        assertBinding(doc);
      }, context);
    },
    async watch(harness, root, context) {
      const watch = await harness.watchDoc(Observation, root.id, context);
      if (!watch) throw new Error('observer-not-bound');
      return watch; // A custom committed stream, not an atomic union with root.watch().
    },
    async report(harness, root, context) {
      const base = { structuralOnly: true, manifestId: scope.manifestId };
      try {
        await authorize(context.abortSignal);
        const live = await harness.snapshot(LiveDoc, root.id, context);
        if (live?.run) return { ...base, status: 'pending', reason: 'run-still-active' };
        const doc = await harness.snapshot(Observation, root.id, context);
        assertBinding(doc);
        const page = await root.entries({}, 1000, undefined, context);
        // This is a dedicated bounded conversation, never an arbitrary long-running transcript reader.
        if (page.items.length >= 1000) return { ...base, status: 'blocked', reason: 'transcript-limit' };
        const results = page.items.filter((e) => e.kind === 'pi.tool-result');
        if (results.some((e) => e.model?.some((m) => m.role === 'toolResult' && m.isError))) {
          return { ...base, status: 'blocked', reason: 'tool-error' };
        }
        for (const source of scope.sources) {
          const receipt = doc.completed[source.id];
          if (!receipt) return { ...base, status: 'pending', reason: 'missing-receipt' };
          const result = results.find((e) => e.byTaskId === receipt.taskId && e.model?.some((m) =>
            m.role === 'toolResult' && m.toolName === OBSERVER_TOOL && m.isError === false &&
            m.content.some((c) => c.type === 'text' && c.text === JSON.stringify(receipt))));
          if (!result) return { ...base, status: 'blocked', reason: 'missing-successful-tool-result' };
          // Revalidate fresh disk state, including already-completed sources, before emitting a final report.
          // This is a separate bounded read, not a repeated agent tool call.
          await authorize(context.abortSignal);
          const fresh = await scope.read(source.id, context.abortSignal);
          if (fresh.sha256 !== receipt.sha256 || fresh.bytes !== receipt.bytes || receipt.manifestId !== scope.manifestId) {
            return { ...base, status: 'blocked', reason: 'stale-receipt' };
          }
        }
        await authorize(context.abortSignal);
        const latest = await harness.snapshot(Observation, root.id, context);
        if (latest.attempts !== doc.attempts || (await harness.snapshot(LiveDoc, root.id, context))?.run) {
          return { ...base, status: 'pending', reason: 'observation-advanced' };
        }
        return { ...base, status: 'evidence-complete', checkedAt: new Date().toISOString(),
          attempts: doc.attempts, receipts: doc.completed };
      } catch (error) {
        const safe = ['observer-disabled', 'cedar-read-denied', 'observer-binding-mismatch', 'source-digest-changed', 'source-lines-unverified'];
        return { ...base, status: 'blocked', reason: safe.includes(error?.message) ? error.message : 'observer-unavailable' };
      }
    },
  };
}
