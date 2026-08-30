import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { BridgeClient } from '../bridge-client.js';

test('private bridge authenticates and exchanges bounded NDJSON messages', async () => {
  const name = `vita3k-mcp-test-${process.pid}-${Date.now()}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
  const token = 'test-token';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: number; token: string; method: string; version: number };
        assert.equal(request.version, 1);
        const authorized = request.token === token;
        socket.write(JSON.stringify(authorized
          ? { id: request.id, ok: true, result: { method: request.method } }
          : { id: request.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(endpoint, resolve).once('error', reject));
  const client = new BridgeClient(name, token);
  try {
    await client.connect(2_000);
    assert.deepEqual(await client.request('session.status'), { method: 'session.status' });
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
