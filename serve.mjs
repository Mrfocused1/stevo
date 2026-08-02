import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createStaticServer } from './static-server.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'xox-clone');
const port = Number.parseInt(process.env.PORT || '3099', 10);
const server = createStaticServer({ root });

server.on('error', (error) => {
  console.error(`Unable to start local server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving xox-clone on http://127.0.0.1:${port}`);
});
