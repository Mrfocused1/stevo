import puppeteer from '/Users/paulbridges/.npm-global/lib/node_modules/puppeteer/lib/cjs/puppeteer/puppeteer.js';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLONE_DIR = join(__dirname, 'xox-clone');
const PORT = 3099;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer((req, res) => {
  let filePath = join(CLONE_DIR, req.url === '/' ? 'index.html' : req.url);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
});

server.listen(PORT, async () => {
  console.log(`Server on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });

  const page = await browser.newPage();
  const consoleMessages = [];
  const errors = [];

  page.on('console', (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    errors.push(err.toString());
  });
  page.on('requestfailed', (req) => {
    consoleMessages.push(`[NET_FAIL] ${req.url()}`);
  });

  try {
    await page.goto(`http://localhost:${PORT}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });
    console.log('Page loaded');
    console.log('Title:', await page.title());

    await new Promise(r => setTimeout(r, 8000));

    console.log('\n--- CONSOLE MESSAGES ---');
    for (const msg of consoleMessages) {
      console.log(msg);
    }

    console.log('\n--- ERRORS ---');
    for (const err of errors) {
      console.log(err);
    }

    await page.screenshot({ path: join(__dirname, 'screenshot.png'), fullPage: false });
    console.log('\nScreenshot saved to screenshot.png');

    const html = await page.content();
    console.log('\nRendered HTML length:', html.length);
    console.log('Has canvas:', html.includes('<canvas'));

  } catch (err) {
    console.error('Navigation failed:', err);
  } finally {
    await browser.close();
    server.close();
    process.exit(0);
  }
});
