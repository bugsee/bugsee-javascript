import 'reflect-metadata';
import { type Bugsee, launch, type NodeRuntime } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import type { CanActivate, INestApplication } from '@nestjs/common';
import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type SetupNestOptions, setupNest } from './index';

// End-to-end over a REAL NestJS app (express platform) + the REAL @bugsee/node SDK. This is the
// empirical proof of the seam design (docs/design/framework-adapters.md): which lifecycle phases each
// seam captures, the 4xx-skip policy, cross-seam dedup, and per-request context isolation under
// concurrency. Mirrors the express/fastify integration tests.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));
const hdr = (req: { headers: Record<string, unknown> }, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

const fakeProcess = (): NodeRuntime => {
  const proc: NodeRuntime = { on: () => proc, off: () => proc, exit: () => undefined };
  return proc;
};

function recordingTransport() {
  const bundles: Uint8Array[] = [];
  let issue = 0;
  const transport = async (url: string, options: { body?: Uint8Array } = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'a' }) };
    }
    if (url.endsWith('/v2/issues')) {
      issue += 1;
      return {
        status: 200,
        headers: {},
        body: jsonBody({
          endpoint: `https://put.test/${issue}`,
          issueId: `i${issue}`,
          recordingId: `r${issue}`,
        }),
      };
    }
    if (url.startsWith('https://put.test/')) {
      if (options.body !== undefined) bundles.push(options.body);
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body: new Uint8Array() };
  };
  return { transport, bundles };
}

interface ParsedBundle {
  request: { email?: string; context_id?: string; source: { mechanism: string } };
  logs: Array<{ message: string; context_id?: string }>;
}
const parseBundle = (zip: Uint8Array): ParsedBundle => {
  const files = unzipSync(zip) as Record<string, Uint8Array>;
  const logsFile = files['logs.json'];
  return {
    request: JSON.parse(strFromU8(files['request.json'] as Uint8Array)),
    logs: logsFile !== undefined ? JSON.parse(strFromU8(logsFile)) : [],
  };
};

// The active launched client, referenced by the controller (defined before any client exists).
let activeClient: Bugsee | undefined;

// ── Throwers in each NestJS lifecycle phase ──
@Injectable()
class ThrowingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard boom');
  }
}
@Injectable()
class AuthGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('forbidden'); // an EXPECTED 4xx (control flow)
  }
}
@Injectable()
class WorkService {
  fail(): never {
    throw new Error('service boom');
  }
}

@Controller()
class AppController {
  constructor(private readonly svc: WorkService) {}

  @Get('/handler-error')
  handlerError(): string {
    throw new Error('handler boom');
  }
  @Get('/guard-error')
  @UseGuards(ThrowingGuard)
  guardError(): string {
    return 'unreached';
  }
  @Get('/guard-forbidden')
  @UseGuards(AuthGuard)
  guardForbidden(): string {
    return 'unreached';
  }
  @Get('/service-error')
  serviceError(): string {
    return this.svc.fail();
  }
  @Get('/not-found')
  notFound(): string {
    throw new NotFoundException('nope'); // expected 4xx
  }
  @Get('/ok')
  ok(): string {
    return 'ok';
  }
  @Get('/work')
  async work(): Promise<string> {
    // logged INSIDE the request → must carry this request's contextId
    const user = activeClient ? 'logged' : 'no-client';
    activeClient?.log(`processing ${user}`);
    throw new Error('work boom');
  }
  @Post('/post-work')
  async postWork(): Promise<string> {
    // A POST WITH A BODY: on Fastify the body is parsed before the handler — the async boundary that a
    // `run()`-wrapped middleware loses the context across. enterWith must keep the correlation here.
    activeClient?.log('processing post');
    throw new Error('post work boom');
  }
}

@Module({ controllers: [AppController], providers: [WorkService] })
class AppModule {}

const apps: INestApplication[] = [];
const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  activeClient = undefined;
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

async function boot(
  setup: SetupNestOptions,
): Promise<{ url: string; bundles: Uint8Array[]; client: Bugsee }> {
  const { transport, bundles } = recordingTransport();
  const client = launch('tok', {
    endpoint: 'https://api.test',
    transport: transport as never,
    process: fakeProcess(),
    detectHangs: false,
    captureNetwork: false,
    recover: false,
  });
  clients.push(client);
  activeClient = client;
  const app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  setupNest(app, { user: (req) => hdr(req as never, 'x-user'), ...setup });
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { url, bundles, client };
}

describe('@bugsee/nestjs — real Nest app (e2e)', () => {
  it('interceptor (default) reports handler / service errors, skips HttpExceptions', async () => {
    const { url, bundles, client } = await boot({});
    for (const path of ['/handler-error', '/service-error', '/not-found', '/ok']) {
      await fetch(url + path).then((r) => r.text());
    }
    await client.flush(5000);
    // 2 genuine errors reported; the 404 + the ok route produced nothing.
    expect(bundles).toHaveLength(2);
    for (const b of bundles.map(parseBundle)) {
      expect(b.request.source.mechanism).toBe('http-error');
    }
  });

  it('interceptor (default) does NOT see guard-thrown errors (the documented gap)', async () => {
    const { url, bundles, client } = await boot({ errorCapture: 'interceptor' });
    await fetch(`${url}/guard-error`).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(0); // interceptor is subscribed AFTER guards run
  });

  it("the global filter ('filter') DOES capture a guard-thrown error", async () => {
    const { url, bundles, client } = await boot({ errorCapture: 'filter' });
    await fetch(`${url}/guard-error`).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(1);
    expect(parseBundle(bundles[0] as Uint8Array).request.source.mechanism).toBe('http-error');
  });

  it("'both' captures guard + handler errors and reports a handler error ONCE (dedup)", async () => {
    const { url, bundles, client } = await boot({ errorCapture: 'both' });
    await fetch(`${url}/guard-error`).then((r) => r.text());
    await fetch(`${url}/handler-error`).then((r) => r.text());
    await client.flush(5000);
    // guard (filter only) + handler (seen by both, deduped to one) = 2 — NOT 3.
    expect(bundles).toHaveLength(2);
  });

  it("'both' still skips an expected 4xx (NotFound + a guard ForbiddenException)", async () => {
    const { url, bundles, client } = await boot({ errorCapture: 'both' });
    await fetch(`${url}/not-found`).then((r) => r.text());
    await fetch(`${url}/guard-forbidden`).then((r) => r.text());
    await client.flush(5000);
    expect(bundles).toHaveLength(0);
  });

  it('preserves the original HTTP response (status + body) while reporting', async () => {
    const { url, client } = await boot({ errorCapture: 'both' });
    const notFound = await fetch(`${url}/not-found`);
    expect(notFound.status).toBe(404); // Nest still maps the HttpException
    const okRes = await fetch(`${url}/ok`);
    expect(await okRes.text()).toBe('ok'); // success unaffected
    await client.flush(5000);
  });

  it('attributes each CONCURRENT request to its own user + contextId with no bleed', async () => {
    const { url, bundles, client } = await boot({});
    const users = ['alice@x.com', 'bob@x.com', 'carol@x.com'];
    await Promise.all(
      users.map(async (user, i) => {
        // stagger so they finish out of order (real interleaving)
        await sleep(i * 5);
        return fetch(`${url}/work`, { headers: { 'x-user': user } }).then((r) => r.text());
      }),
    );
    await client.flush(5000);

    const parsed = bundles.map(parseBundle);
    expect(parsed).toHaveLength(3);
    // each report has a distinct context_id + its own user
    expect(new Set(parsed.map((p) => p.request.context_id)).size).toBe(3);
    expect([...new Set(parsed.map((p) => p.request.email))].sort()).toEqual([...users].sort());
    // the log line tagged with a report's OWN context_id is THIS request's line (no cross-bleed)
    for (const p of parsed) {
      const own = p.logs.find((l) => l.context_id === p.request.context_id);
      expect(own?.message).toBe('processing logged');
    }
  });
});

// The Fastify platform is where `store.run(() => next())` would silently lose the ALS context for body
// requests (nodejs/node#41285). This proves the enterWith middleware keeps the correlation on Fastify.
describe('@bugsee/nestjs — real Nest app on the FASTIFY platform (e2e)', () => {
  async function bootFastify(): Promise<{ url: string; bundles: Uint8Array[]; client: Bugsee }> {
    const { transport, bundles } = recordingTransport();
    const client = launch('tok', {
      endpoint: 'https://api.test',
      transport: transport as never,
      process: fakeProcess(),
      detectHangs: false,
      captureNetwork: false,
      recover: false,
    });
    clients.push(client);
    activeClient = client;
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    apps.push(app);
    setupNest(app, { user: (req) => hdr(req as never, 'x-user') });
    await app.listen(0, '127.0.0.1');
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    return { url, bundles, client };
  }

  it('correlates a POST-with-body request to its context (enterWith survives body parsing)', async () => {
    const { url, bundles, client } = await bootFastify();
    await fetch(`${url}/post-work`, {
      method: 'POST',
      headers: { 'x-user': 'fast@x.com', 'content-type': 'application/json' },
      body: JSON.stringify({ some: 'payload' }),
    }).then((r) => r.text());
    await client.flush(5000);

    expect(bundles).toHaveLength(1);
    const p = parseBundle(bundles[0] as Uint8Array);
    expect(p.request.email).toBe('fast@x.com');
    expect(p.request.context_id).toBeDefined();
    // THE proof: the log line emitted inside the body request carries this request's contextId — it would
    // be UNcorrelated (no matching log) if run() had been used and the context were lost across body parse.
    const own = p.logs.find((l) => l.context_id === p.request.context_id);
    expect(own?.message).toBe('processing post');
  });

  it('isolates two CONCURRENT body requests with no context bleed', async () => {
    const { url, bundles, client } = await bootFastify();
    const users = ['p1@x.com', 'p2@x.com'];
    await Promise.all(
      users.map(async (user, i) => {
        await sleep(i * 5);
        return fetch(`${url}/post-work`, {
          method: 'POST',
          headers: { 'x-user': user, 'content-type': 'application/json' },
          body: JSON.stringify({ i }),
        }).then((r) => r.text());
      }),
    );
    await client.flush(5000);

    const parsed = bundles.map(parseBundle);
    expect(parsed).toHaveLength(2);
    expect(new Set(parsed.map((p) => p.request.context_id)).size).toBe(2);
    expect([...new Set(parsed.map((p) => p.request.email))].sort()).toEqual([...users].sort());
    for (const p of parsed) {
      const own = p.logs.find((l) => l.context_id === p.request.context_id);
      expect(own?.message).toBe('processing post');
    }
  });
});
