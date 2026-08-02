import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { resolveStaticPath } from '../static-server.mjs';

const root = resolve('/tmp/xoxo-static-root');

test('resolves paths inside the static root', () => {
  assert.equal(resolveStaticPath(root, '/'), resolve(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/assets/game.js?build=1'), resolve(root, 'assets/game.js'));
});

test('rejects encoded and plain directory traversal', () => {
  assert.equal(resolveStaticPath(root, '/../serve.mjs'), null);
  assert.equal(resolveStaticPath(root, '/%2e%2e/serve.mjs'), null);
  assert.equal(resolveStaticPath(root, '/assets/%2e%2e/%2e%2e/serve.mjs'), null);
});
