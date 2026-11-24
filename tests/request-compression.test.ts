import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { app } from '../src/rest.js';

let server: http.Server;
let url: string;
beforeAll(async () => {
  vi.stubEnv('OPENCADRE_OAUTH', 'on');
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => { vi.unstubAllEnvs(); server.closeAllConnections(); server.close(() => resolve()); }));

it('sends host-scoped HSTS on HTTPS, and omits it on plain HTTP', async () => {
  for (const host of ['hub.opencadre.example', 'app.opencadre.example', 'opencadre.example']) {
    const response = await fetch(`${url}/health`, { headers: { host, 'x-forwarded-proto': 'https' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  }
  expect((await fetch(`${url}/health`)).headers.get('strict-transport-security')).toBeNull();
});

it.each([
  ['br', brotliCompressSync],
  ['gzip', gzipSync],
  ['deflate', deflateSync],
] as const)('rejects %s JSON before authentication and continues serving plain JSON', async (encoding, compress) => {
  // Benign compressed JSON, not a vulnerability payload. Before the guard this reaches auth (401).
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding },
    body: new Uint8Array(compress(Buffer.from('{}'))),
  });
  expect(response.status).toBe(415);
  const plain = await fetch(`${url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  expect(plain.status).toBe(401);
  expect((await fetch(`${url}/health`)).status).toBe(200);
});

it.each(['/oauth/authorize', '/oauth/token', '/oauth/revoke'])('rejects compressed OAuth forms on %s', async endpoint => {
  const response = await fetch(`${url}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'br' },
    body: new Uint8Array(brotliCompressSync(Buffer.from('grant_type=invalid'))),
  });
  expect(response.status).toBe(415);
  const plain = await fetch(`${url}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=invalid',
    redirect: 'manual',
  });
  expect(plain.status).toBe(endpoint === '/oauth/authorize' ? 401 : 400);
});
