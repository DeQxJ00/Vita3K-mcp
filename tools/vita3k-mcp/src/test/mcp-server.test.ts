import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serverRoot } from '../paths.js';

test('stdio MCP server advertises the complete Vita3K test workflow', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(serverRoot, 'dist', 'index.js')],
    cwd: serverRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'vita3k-sidecar-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'build_start', 'build_status', 'capture_screen', 'control_session', 'get_logs',
      'launch_app', 'list_apps', 'send_input', 'session_status', 'touch',
    ]);
    for (const name of ['send_input', 'touch']) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      const duration = (tool?.inputSchema as { properties?: { durationMs?: { maximum?: number } } }).properties?.durationMs;
      assert.equal(duration?.maximum, 60_000);
    }
    const invalid = await client.callTool({ name: 'build_status', arguments: { buildId: '00000000-0000-0000-0000-000000000000' } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
