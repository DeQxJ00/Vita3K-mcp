import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { startHttpHost } from '../http-host.js';
import { RuntimeManager } from '../runtime-manager.js';

test('loopback HTTP host validates browser origin and serves the complete MCP workflow without credentials', async () => {
  const errors: Error[] = [];
  const host = await startHttpHost({ port: 0, onerror: (error) => errors.push(error) });
  const baseUrl = new URL(host.url);
  const client = new Client({ name: 'vita3k-http-sidecar-test', version: '1.0.0' });
  try {
    const health = await fetch(new URL('/health', baseUrl));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'vita3k-mcp',
      transport: 'streamable-http',
      endpoint: '/mcp',
    });

    assert.equal((await fetch(baseUrl, {
      headers: { origin: 'https://example.invalid' },
    })).status, 403);

    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'build_start', 'build_status', 'capture_screen', 'control_session', 'get_logs',
      'launch_app', 'list_apps', 'send_input', 'session_status', 'touch',
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await client.close();
    await host.close();
  }
});

test('captures attach JPEG only on request while retaining the PNG artifact', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vita3k-mcp-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'frame.png');
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(255);
  const original = PNG.sync.write(png);
  await writeFile(file, original);
  t.mock.method(RuntimeManager.prototype, 'capture', async () => ({ path: file, width: 16, height: 16 }));

  const host = await startHttpHost({ port: 0 });
  const client = new Client({ name: 'vita3k-capture-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(host.url)));
    const sessionId = '00000000-0000-0000-0000-000000000000';
    const archived = await client.callTool({ name: 'capture_screen', arguments: { sessionId } });
    assert.deepEqual(archived.content.map(({ type }) => type), ['text']);
    const attached = await client.callTool({ name: 'capture_screen', arguments: { sessionId, includeImage: true } });
    const image = attached.content.find((item) => item.type === 'image');
    assert.ok(image);
    assert.equal(image.mimeType, 'image/jpeg');
    const decoded = jpeg.decode(Buffer.from(image.data, 'base64'));
    assert.equal(decoded.width, 16);
    assert.equal(decoded.height, 16);
    assert.deepEqual(attached.structuredContent, { ok: true, path: file, width: 16, height: 16, mimeType: 'image/png' });
    assert.deepEqual(await readFile(file), original);
  } finally {
    await client.close();
    await host.close();
  }
});
