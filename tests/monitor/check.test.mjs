import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkTarget, checkTargets, createRuntime, RunnerError } from '../../scripts/monitor/check.mjs';

const CANARY = 'canary-token-7f3a9c';
const servers = [];

test('body checks match across UTF-8 chunks and cancel after matching', async () => {
  let cancelled = false;
  const bytes = new TextEncoder().encode('prefix用户标记suffix');
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    },
    cancel() { cancelled = true; },
  });
  const sample = await checkTarget(target('a', 'https://example.test', { requiredBodyText: '用户标记' }),
    runtime({ fetch: async () => new Response(stream) }));
  assert.equal(sample.status, 'up');
  assert.equal(cancelled, true);
});

test('missing body text retries and returns a safe failure without storing the body', async () => {
  const { base, seen } = await startServer((req, res) => res.end(CANARY));
  const sample = await checkTarget(target('a', base, { requiredBodyText: '<rss' }), runtime());
  assert.equal(sample.failureCategory, 'missing-body-text');
  assert.equal(sample.httpStatus, 200);
  assert.equal(seen.length, 2);
  assert.equal(JSON.stringify(sample).includes(CANARY), false);
});

test('body reading stays within the attempt timeout', async () => {
  const { base } = await startServer((req, res) => res.write('partial'));
  const sample = await checkTarget(target('a', base, { requiredBodyText: '<rss', timeoutMs: 100, maxAttempts: 1 }), runtime());
  assert.equal(sample.failureCategory, 'timeout');
});

async function startServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    handler(req, res, seen);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, port, seen, server };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

function target(id, url, request = {}) {
  return {
    id,
    name: id,
    publicUrl: url,
    definitionRevision: 'rev-a',
    request: {
      method: 'GET',
      url,
      headers: [],
      acceptedStatuses: null,
      timeoutMs: 1000,
      maxAttempts: 2,
      ...request,
    },
  };
}

function runtime(overrides = {}) {
  return createRuntime({ env: { TOKEN: CANARY }, runKey: 'run-1', ...overrides });
}

test('an accepted 200 response is up with status and measured time', async () => {
  const { base } = await startServer((req, res) => res.end('ok'));
  const sample = await checkTarget(target('a', `${base}/`), runtime());
  assert.equal(sample.status, 'up');
  assert.equal(sample.httpStatus, 200);
  assert.equal(sample.attempts, 1);
  assert.equal(sample.failureCategory, null);
  assert.ok(Number.isInteger(sample.responseTimeMs) && sample.responseTimeMs >= 0);
});

test('an unexpected status is down with its status code after the default two attempts', async () => {
  const { base, seen } = await startServer((req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  const sample = await checkTarget(target('a', `${base}/`), runtime());
  assert.equal(sample.status, 'down');
  assert.equal(sample.httpStatus, 500);
  assert.equal(sample.failureCategory, 'unexpected-status');
  assert.equal(sample.attempts, 2);
  assert.equal(seen.length, 2);
});

test('explicitly configured accepted statuses replace the 2xx default', async () => {
  const { base } = await startServer((req, res) => {
    res.statusCode = 204;
    res.end();
  });
  const accepted = await checkTarget(target('a', `${base}/`, { acceptedStatuses: [204] }), runtime());
  assert.equal(accepted.status, 'up');
  assert.equal(accepted.httpStatus, 204);
  const rejected = await checkTarget(target('b', `${base}/`, { acceptedStatuses: [200] }), runtime());
  assert.equal(rejected.status, 'down');
});

test('a bounded redirect to an accepted final response is up', async () => {
  const { base } = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(301, { location: '/final' });
      res.end();
      return;
    }
    res.end('final');
  });
  const sample = await checkTarget(target('a', `${base}/start`), runtime());
  assert.equal(sample.status, 'up');
  assert.equal(sample.httpStatus, 200);
});

test('a redirect loop is down with the redirect category', async () => {
  const { base, seen } = await startServer((req, res) => {
    res.writeHead(302, { location: '/loop' });
    res.end();
  });
  const sample = await checkTarget(target('a', `${base}/loop`, { maxAttempts: 1 }), runtime());
  assert.equal(sample.status, 'down');
  assert.equal(sample.failureCategory, 'redirect');
  assert.equal(seen.length, 11);
});

test('a redirect to a non-HTTP scheme is a redirect failure', async () => {
  const { base } = await startServer((req, res) => {
    res.writeHead(302, { location: 'file:///etc/passwd' });
    res.end();
  });
  const sample = await checkTarget(target('a', `${base}/`, { maxAttempts: 1 }), runtime());
  assert.equal(sample.failureCategory, 'redirect');
});

test('authentication headers stay on the original origin across redirects', async () => {
  const other = await startServer((req, res) => res.end('other'));
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${other.base}/landing` });
    res.end();
  });
  const sample = await checkTarget(
    target('a', `${origin.base}/start`, { headers: [{ name: 'authorization', secret: 'TOKEN' }] }),
    runtime(),
  );
  assert.equal(sample.status, 'up');
  assert.equal(origin.seen[0].authorization, `${CANARY}`);
  assert.equal(other.seen[0].authorization, undefined);
});

test('authentication headers are kept for same-origin redirects', async () => {
  const { base, seen } = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.end('final');
  });
  const sample = await checkTarget(
    target('a', `${base}/start`, { headers: [{ name: 'authorization', secret: 'TOKEN' }] }),
    runtime(),
  );
  assert.equal(sample.status, 'up');
  assert.equal(seen[1].authorization, CANARY);
});

test('a hung target times out within its attempt budget', async () => {
  const { base } = await startServer(() => {
    // Never responds.
  });
  const started = Date.now();
  const sample = await checkTarget(target('a', `${base}/`, { timeoutMs: 150 }), runtime());
  assert.equal(sample.status, 'down');
  assert.equal(sample.failureCategory, 'timeout');
  assert.equal(sample.httpStatus, null);
  assert.equal(sample.responseTimeMs, null);
  assert.equal(sample.attempts, 2);
  assert.ok(Date.now() - started < 2000);
});

test('a refused connection is a network failure', async () => {
  const { base, server } = await startServer((req, res) => res.end());
  await new Promise((resolve) => server.close(resolve));
  const sample = await checkTarget(target('a', `${base}/`, { maxAttempts: 1 }), runtime());
  assert.equal(sample.status, 'down');
  assert.equal(sample.failureCategory, 'network');
});

test('a transient failure followed by success yields one successful sample', async () => {
  let calls = 0;
  const { base } = await startServer((req, res) => {
    calls += 1;
    res.statusCode = calls === 1 ? 503 : 200;
    res.end();
  });
  const sample = await checkTarget(target('a', `${base}/`), runtime());
  assert.equal(sample.status, 'up');
  assert.equal(sample.attempts, 2);
  assert.equal(sample.failureCategory, null);
});

test('controlled DNS and TLS transport errors map to their safe categories', async () => {
  const dnsFetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  };
  const tlsFetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    });
  };
  const dns = await checkTarget(target('a', 'https://dns.example.test/', { maxAttempts: 1 }), runtime({ fetch: dnsFetch }));
  const tls = await checkTarget(target('b', 'https://tls.example.test/', { maxAttempts: 1 }), runtime({ fetch: tlsFetch }));
  assert.equal(dns.failureCategory, 'dns');
  assert.equal(tls.failureCategory, 'tls');
});

test('response bodies are cancelled, never read', async () => {
  let cancelled = 0;
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers(),
    body: {
      cancel: async () => {
        cancelled += 1;
      },
    },
  });
  const sample = await checkTarget(target('a', 'https://body.example.test/', { maxAttempts: 1 }), runtime({ fetch: fetchImpl }));
  assert.equal(sample.status, 'up');
  assert.equal(cancelled, 1);
});

test('a missing secret is a runner error before any request is sent', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not run');
  };
  await assert.rejects(
    checkTarget(
      target('a', 'https://secret.example.test/', { headers: [{ name: 'authorization', secret: 'MISSING' }] }),
      runtime({ fetch: fetchImpl, env: {} }),
    ),
    RunnerError,
  );
  assert.equal(called, false);
});

test('an exhausted run budget stops the batch as a runner error', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async (url, init) => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal });
  };
  await assert.rejects(
    checkTargets([target('a', 'https://budget.example.test/')], runtime({ fetch: fetchImpl, signal: controller.signal })),
    RunnerError,
  );
});

test('a slow target does not prevent other targets from completing', async () => {
  const { base: fastBase } = await startServer((req, res) => res.end('fast'));
  const { base: hungBase } = await startServer(() => {
    // Never responds.
  });
  const targets = [
    target('slow', `${hungBase}/`, { timeoutMs: 300, maxAttempts: 1 }),
    target('fast-1', `${fastBase}/`),
    target('fast-2', `${fastBase}/`),
    target('fast-3', `${fastBase}/`),
  ];
  const samples = await checkTargets(targets, runtime(), { concurrency: 4 });
  assert.deepEqual(samples.map((sample) => sample.siteId), ['slow', 'fast-1', 'fast-2', 'fast-3']);
  assert.deepEqual(samples.map((sample) => sample.status), ['down', 'up', 'up', 'up']);
  assert.equal(new Set(samples.map((sample) => sample.runKey)).size, 1);
});

test('secret canaries never appear in serialized samples, including failed and redirected requests', async () => {
  const other = await startServer((req, res) => {
    res.statusCode = 500;
    res.end(`echo ${req.headers.authorization ?? 'none'}`);
  });
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${other.base}/?token=${CANARY}` });
    res.end();
  });
  const samples = await checkTargets(
    [
      target('redirected', `${origin.base}/start?key=${CANARY}`, { headers: [{ name: 'authorization', secret: 'TOKEN' }] }),
      target('refused', 'http://127.0.0.1:1/', { maxAttempts: 1, headers: [{ name: 'authorization', secret: 'TOKEN' }] }),
    ],
    runtime(),
  );
  const serialized = JSON.stringify(samples);
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(samples[0].failureCategory, 'unexpected-status');
});
