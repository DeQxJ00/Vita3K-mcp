import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const pipeName = process.env.VITA3K_MCP_PIPE;
const token = process.env.VITA3K_MCP_TOKEN;
const artifactRoot = process.env.VITA3K_MCP_ARTIFACT_ROOT;
if (!pipeName || !token || !artifactRoot) throw new Error('fake Vita3K requires the private MCP environment');
const artifactDirectory = artifactRoot;

const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : pipeName;
let phase = 'idle';
let titleId = '';

// A valid 1x1 transparent PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xx8WAAAAAElFTkSuQmCC', 'base64');

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    void drain();
  });

  async function drain(): Promise<void> {
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as { id: number; version: number; token: string; method: string; params?: Record<string, unknown> };
      if (request.version !== 1 || request.token !== token) {
        socket.write(JSON.stringify({ id: request.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'bad handshake' } }) + '\n');
        continue;
      }
      const params = request.params ?? {};
      let result: Record<string, unknown> = {};
      if (request.method === 'hello') result = { protocolVersion: 1 };
      else if (request.method === 'apps.list') result = { apps: [{ titleId: 'FAKE00001', title: 'Fake Homebrew', shortTitle: 'Fake', version: '1.00', category: 'gd', contentId: 'FAKE-CONTENT' }] };
      else if (request.method === 'app.launch') {
        titleId = String(params.titleId ?? 'FAKE00001');
        phase = 'running';
        const appArgs = params.appArgs as string[] | undefined;
        if (appArgs?.includes('--crash')) setTimeout(() => process.exit(9), 80);
      } else if (request.method === 'session.status') result = { phase, titleId, title: 'Fake Homebrew', fps: 60, resolution: { width: 960, height: 544 } };
      else if (request.method === 'session.pause') phase = params.paused ? 'paused' : 'running';
      else if (request.method === 'session.restart') phase = 'running';
      else if (request.method === 'session.stop') phase = 'stopped';
      else if (request.method === 'screen.capture') {
        const relative = String(params.relativePath ?? '');
        const target = path.resolve(artifactDirectory, relative);
        if (!target.startsWith(path.resolve(artifactDirectory) + path.sep)) throw new Error('path escaped artifact root');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, png);
        result = { width: 1, height: 1 };
      } else if (request.method === 'emulator.shutdown') setTimeout(() => process.exit(0), 20);
      socket.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
    }
  }
});

server.listen(endpoint);
