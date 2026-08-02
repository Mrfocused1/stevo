import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

export const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; connect-src 'self' https: wss:; font-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

export function resolveStaticPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent((requestUrl || '/').split('?')[0].split('#')[0]);
  } catch {
    return null;
  }

  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.split('/').includes('..')) return null;
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, `.${pathname === '/' ? '/index.html' : pathname}`);
  const pathFromRoot = relative(rootPath, filePath);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '') return null;
  return filePath;
}

export function createStaticServer({ root, cacheControl = 'no-store' }) {
  return createServer(async (req, res) => {
    const filePath = resolveStaticPath(root, req.url || '/');
    if (!filePath) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end('Forbidden');
      return;
    }

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not-a-file');
      const headers = {
        ...SECURITY_HEADERS,
        'Cache-Control': cacheControl,
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      res.end(await readFile(filePath));
    } catch {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not found');
    }
  });
}
