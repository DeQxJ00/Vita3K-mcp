import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverRoot = path.resolve(import.meta.dirname, '..');
const titleIndex = process.argv.indexOf('--title-id');
const titleId = titleIndex >= 0 ? process.argv[titleIndex + 1] : undefined;

if (titleIndex >= 0 && !titleId) {
  throw new Error('--title-id requires a value.');
}

const transport = new StdioClientTransport({
  command: 'powershell.exe',
  args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(serverRoot, 'launch.ps1')],
  cwd: serverRoot,
  env: process.env,
  stderr: 'pipe',
});
const client = new Client({ name: 'vita3k-real-smoke', version: '1.0.0' });
let serverStderr = '';
let connected = false;
transport.stderr?.setEncoding('utf8');
transport.stderr?.on('data', (chunk) => {
  serverStderr += chunk;
  process.stderr.write(chunk);
});

async function call(name, args) {
  const result = await callRaw(name, args);
  return result.structuredContent ?? {};
}

async function callRaw(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const detail = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    throw new Error(`${name} failed: ${detail}`);
  }
  return result;
}

try {
  await client.connect(transport);
  connected = true;
  const advertised = await client.listTools();
  console.log(JSON.stringify({ tools: advertised.tools.map((tool) => tool.name) }, null, 2));

  const apps = await call('list_apps', { refresh: true });
  console.log(JSON.stringify(apps, null, 2));

  const logs = await call('get_logs', { cursor: 0, minLevel: 'trace', limit: 200 });
  console.log(JSON.stringify(logs, null, 2));

  if (titleId) {
    const launched = await call('launch_app', { titleId, appArgs: [], replace: false });
    console.log(JSON.stringify(launched, null, 2));
    const sessionId = launched.sessionId;
    let status;
    let revision = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      status = await call('session_status', { sessionId, afterRevision: revision, waitMs: 1_000 });
      revision = Number(status.revision ?? revision);
      if (status.phase === 'running' && status.frameReady === true) break;
      if (['failed', 'crashed', 'exited'].includes(status.phase)) break;
    }
    console.log(JSON.stringify(status, null, 2));
    if (status?.phase !== 'running' || status.frameReady !== true) throw new Error(`Application did not reach a capturable running state: ${status?.phase ?? 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await call('control_session', { sessionId, action: 'pause' });
    const captureResult = await callRaw('capture_screen', { sessionId });
    const capture = captureResult.structuredContent ?? {};
    if (!captureResult.content.some((item) => item.type === 'image')) throw new Error('capture_screen did not return MCP image content.');
    console.log(JSON.stringify(capture, null, 2));
    await call('touch', { sessionId, port: 'front', points: [{ x: 0.5, y: 0.5 }], durationMs: 50 });
    await call('send_input', { sessionId, buttons: ['start'], durationMs: 100 });
    await call('control_session', { sessionId, action: 'restart' });
    revision = Number(status.revision ?? revision);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      status = await call('session_status', { sessionId, afterRevision: revision, waitMs: 1_000 });
      revision = Number(status.revision ?? revision);
      if (status.phase === 'running') break;
      if (['failed', 'crashed', 'exited'].includes(status.phase)) throw new Error(`Restart failed: ${status.phase}`);
    }
    await call('control_session', { sessionId, action: 'pause' });
    await call('control_session', { sessionId, action: 'resume' });
    await call('control_session', { sessionId, action: 'stop' });
  }

  console.log(JSON.stringify(await call('control_session', { action: 'shutdown' }), null, 2));
} finally {
  if (connected) await call('control_session', { action: 'shutdown' }).catch(() => {});
  await client.close().catch(() => {});
  if (serverStderr) process.stderr.write(`\n[MCP server stderr captured: ${serverStderr.length} bytes]\n`);
}
