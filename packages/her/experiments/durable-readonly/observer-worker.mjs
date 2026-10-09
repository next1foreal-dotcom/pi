/** Test-only process driver. Production adapter does not install a model provider. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createHerObserver, Observation, OBSERVER_TOOL } from './her-observer.mjs';

const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
globalThis.fetch = async () => { throw new Error('No network in observer tests.'); };
process.once('message', async (config) => {
  let harness;
  let watch;
  try {
    let enabled = config.allowed !== false;
    const observer = await createHerObserver({
      ...config, isEnabled: () => {
        if (config.failAuthorization) throw new Error('injected permission failure');
        return enabled;
      },
      onBeforeRead: async (sourceId, api, callContext) => {
        await send({ type: 'attempt', sourceId });
        if (config.revokeInsideRead) enabled = false;
        if (config.phase === 'crash' && sourceId === 'guard') {
          const doc = await harness.snapshot(Observation, api.conversationId, context);
          await send({ type: 'checkpoint', completed: Object.keys(doc.completed), attempts: doc.attempts });
          await new Promise((_, reject) => {
            const signal = callContext.abortSignal;
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
      },
    });
    const models = createModels();
    const faux = fauxProvider(); models.setProvider(faux.provider);
    const registry = createRegistry(); registry.install(observer.extension);
    const call = (id) => fauxAssistantMessage([fauxToolCall(OBSERVER_TOOL, { sourceId: id }, { id: `observe-${id}` })], { stopReason: 'toolUse' });
    faux.setResponses(config.phase === 'inspect' ? [] : config.phase === 'resume' ? [fauxAssistantMessage('Done.')] :
      config.answerOnly ? [fauxAssistantMessage('Everything passed.')] :
      config.unknownId ? [call('../her-memory/private.md'), fauxAssistantMessage('Done.')] :
      [...config.sources.map((s) => call(s.id)), fauxAssistantMessage('Done.')]);
    harness = await Harness.open(await openNodeSqliteStorage(config.database), {
      models, registry, settings: { retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, toolExecution: 'sequential' },
    }, context);
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, tools: [observer.tool] } });
    await observer.bind(harness, root, context);
    watch = await observer.watch(harness, root, context);
    const delivered = new Set();
    watch.start(async (doc) => { for (const id of Object.keys(doc?.completed ?? {})) delivered.add(id); });
    let submission;
    if (config.phase !== 'inspect') {
      const request = { type: 'input', content: 'Observe selected source ranges.', requestId: 'her-observe-sources-v1' };
      submission = await root.submit(request, context);
      await submission.wait(context);
    }
    const report = await observer.report(harness, root, context);
    const doc = await harness.snapshot(Observation, root.id, context);
    const until = Date.now() + 2000;
    while (delivered.size < Object.keys(doc.completed).length && Date.now() < until && config.phase !== 'inspect') {
      await new Promise((r) => setTimeout(r, 5));
    }
    await send({ type: 'result', report, doc, delivered: [...delivered], modelCalls: faux.state.callCount,
      submissionId: submission?.id, userEntries: (await root.entries({}, 1000, undefined, context)).items.filter((e) => e.kind === 'pi.user').length });
  } catch (error) {
    await send({ type: 'error', error: String(error) });
    process.exitCode = 1;
  } finally {
    await watch?.stop();
    await harness?.close(context);
    process.disconnect();
  }
});
