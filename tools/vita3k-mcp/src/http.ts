import process from 'node:process';
import { ensureStateDirectories } from './paths.js';
import { startHttpHost } from './http-host.js';

const host = process.env.VITA3K_MCP_HTTP_HOST ?? '127.0.0.1';
const portText = process.env.VITA3K_MCP_HTTP_PORT ?? '32560';
const port = Number(portText);

await ensureStateDirectories();
const handle = await startHttpHost({
  host,
  port,
  onerror: (error) => console.error(`[vita3k-mcp-http] ${error.stack ?? error.message}`),
});
console.log(JSON.stringify({ ok: true, service: 'vita3k-mcp', transport: 'streamable-http', host: handle.host, port: handle.port, url: handle.url }));

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await handle.close();
};
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
