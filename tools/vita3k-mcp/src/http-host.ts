import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer, shutdownRuntime } from './server.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpHostOptions {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  onerror?: (error: Error) => void;
}

export interface HttpHostHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function isAllowedHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function isAllowedOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function writeJson(response: ServerResponse, status: number, value: Record<string, unknown>, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('HTTP_BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new Error('HTTP_BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function toWebRequest(request: IncomingMessage, host: string, port: number, maxBodyBytes: number): Promise<Request> {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (Array.isArray(raw)) for (const value of raw) headers.append(name, value);
    else if (raw !== undefined) headers.set(name, raw);
  }
  const body = await readBody(request, maxBodyBytes);
  return new Request(new URL(request.url ?? '/', `http://${host}:${port}`), {
    method: request.method ?? 'GET',
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

async function sendWebResponse(source: Response, target: ServerResponse): Promise<void> {
  source.headers.forEach((value, name) => target.setHeader(name, value));
  target.statusCode = source.status;
  target.statusMessage = source.statusText;
  if (!source.body) {
    target.end();
    return;
  }
  const reader = source.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!target.write(Buffer.from(value))) await new Promise<void>((resolve) => target.once('drain', resolve));
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

export async function startHttpHost(options: HttpHostOptions): Promise<HttpHostHandle> {
  const host = options.host ?? LOOPBACK_HOST;
  const requestedPort = options.port ?? 32_560;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (host !== LOOPBACK_HOST) throw new Error('HTTP_HOST_MUST_BE_LOOPBACK');
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new Error('INVALID_HTTP_PORT');
  const handler = createMcpHandler(() => createServer(), {
    responseMode: 'auto',
    ...(options.onerror ? { onerror: options.onerror } : {}),
  });
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;
  let actualPort = requestedPort;

  const nodeServer = createNodeServer(async (request, response) => {
    try {
      const remoteAddress = request.socket.remoteAddress;
      if (!isLoopbackAddress(remoteAddress)) {
        writeJson(response, 403, { ok: false, error: 'LOOPBACK_ONLY' });
        return;
      }
      if (!isAllowedHostHeader(request.headers.host)) {
        writeJson(response, 421, { ok: false, error: 'INVALID_HOST' });
        return;
      }
      const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
      if (!isAllowedOrigin(origin)) {
        writeJson(response, 403, { ok: false, error: 'INVALID_ORIGIN' });
        return;
      }
      const pathname = new URL(request.url ?? '/', `http://${host}:${actualPort}`).pathname;
      if (pathname === '/health' && request.method === 'GET') {
        writeJson(response, 200, { ok: true, service: 'vita3k-mcp', transport: 'streamable-http', endpoint: '/mcp' });
        return;
      }
      if (pathname !== '/mcp' && pathname !== '/shutdown') {
        writeJson(response, 404, { ok: false, error: 'NOT_FOUND' });
        return;
      }
      if (pathname === '/shutdown') {
        if (request.method !== 'POST') {
          writeJson(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
          return;
        }
        writeJson(response, 202, { ok: true, shuttingDown: true });
        setTimeout(() => { void close(); }, 10);
        return;
      }
      const webRequest = await toWebRequest(request, host, actualPort, maxBodyBytes);
      await sendWebResponse(await handler.fetch(webRequest), response);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      options.onerror?.(failure);
      if (!response.headersSent) {
        const status = failure.message === 'HTTP_BODY_TOO_LARGE' ? 413 : 500;
        writeJson(response, status, { ok: false, error: failure.message });
      } else {
        response.destroy(failure);
      }
    }
  });

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closeRequested = true;
    closePromise = (async () => {
      await handler.close();
      await shutdownRuntime();
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => error ? reject(error) : resolve());
        nodeServer.closeIdleConnections();
      });
    })();
    return closePromise;
  };

  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(requestedPort, host, () => resolve());
  });
  const address = nodeServer.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('HTTP_LISTEN_FAILED');
  }
  actualPort = address.port;
  nodeServer.once('error', (error) => { if (!closeRequested) options.onerror?.(error); });

  return { host, port: actualPort, url: `http://${host}:${actualPort}/mcp`, close };
}
