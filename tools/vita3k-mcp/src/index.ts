import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ensureStateDirectories } from './paths.js';
import { createServer, shutdownRuntime } from './server.js';

await ensureStateDirectories();
const handle = serveStdio(createServer, { onerror: (error) => console.error(error) });

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await shutdownRuntime();
  await handle.close();
};
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.stdin.once('end', () => { void close().finally(() => process.exit(0)); });
process.stdin.once('close', () => { void close().finally(() => process.exit(0)); });
