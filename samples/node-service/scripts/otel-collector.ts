// A tiny local OTLP/HTTP-JSON "collector" for S13 (produce direction): accepts POST /v1/traces, saves
// every payload to data/otel-collector-received.json, and prints a one-line summary per request. Not a
// real collector — just enough to prove the SDK's otelExportUrl option posts valid OTLP/JSON.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const outFile = join(dataDir, 'otel-collector-received.ndjson');
writeFileSync(outFile, '');

const port = Number(process.env.OTEL_COLLECTOR_PORT ?? 4318);

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/traces') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(body);
        appendFileSync(outFile, JSON.stringify({ receivedAt: Date.now(), headers: req.headers, payload: parsed }) + '\n');
        const spanCount =
          parsed.resourceSpans?.reduce(
            (n: number, rs: { scopeSpans?: { spans?: unknown[] }[] }) =>
              n + (rs.scopeSpans?.reduce((m: number, ss) => m + (ss.spans?.length ?? 0), 0) ?? 0),
            0,
          ) ?? 0;
        console.log(`[otel-collector] received ${spanCount} span(s)`);
      } catch (error) {
        console.error('[otel-collector] invalid JSON body', error);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`[otel-collector] listening on http://127.0.0.1:${port}`);
});
