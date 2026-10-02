/** Attach to the existing owner of a Durable Harness. Never open its SQLite file a second time. */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { parseReport } from '../../src/observer-report/protocol.ts';

export async function serveObserverReport({ observer, harness, root, context, token, sessionId, port = 0 }) {
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('observer-host-binding-required');
  let busy = false;
  let closing = false;
  let drained = Promise.resolve();
  let host;
  const authorization = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reject = (status) => { res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close' }); res.end(); };
    const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (closing || req.method !== 'GET' || req.url !== '/her-observer/report' || req.headers.origin ||
        req.headers.host !== host || req.headers['x-her-session'] !== sessionId ||
        req.headers['x-her-manifest'] !== observer.manifestId || supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization)) { reject(403); return; }
    if (busy) { reject(429); return; }
    busy = true;
    let finish;
    drained = new Promise((resolve) => { finish = resolve; });
    try {
      // The existing observer rechecks enablement, Cedar and current bytes. No model API or scheduler is called.
      const result = await observer.report(harness, root, context);
      const envelope = parseReport({ version: 1, structuralOnly: true, manifestId: observer.manifestId,
        status: result.status, checkedAt: result.checkedAt, attempts: result.attempts,
        sources: result.receipts ? Object.keys(result.receipts).length : undefined }, observer.manifestId);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end(JSON.stringify(envelope));
    } catch { reject(503); }
    finally { busy = false; finish(); }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxHeadersCount = 12;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  host = `127.0.0.1:${address.port}`;
  return {
    url: `http://${host}/her-observer/report`,
    async close() {
      closing = true;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      await drained;
    },
  };
}
