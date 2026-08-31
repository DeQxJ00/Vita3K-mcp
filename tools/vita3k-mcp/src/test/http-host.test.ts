import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpHost } from '../http-host.js';

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
