import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createStaticServer } from './static-server.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'xox-clone');
const server = createStaticServer({ root, cacheControl: 'no-store' });
server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /<div id="app"><\/div>/);

  const asset = await fetch(`${origin}/assets/connect4.js`, { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'application/javascript; charset=utf-8');

  const traversalStatus = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/../serve.mjs' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(traversalStatus, 403);
  console.log('Static-server smoke test passed.');
} finally {
  server.close();
  await once(server, 'close');
}
