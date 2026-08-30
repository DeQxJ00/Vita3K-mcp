import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../runtime-manager.js';

const fakeExecutable = fileURLToPath(new URL('./fake-vita3k.js', import.meta.url));
const fakeBuilds = { getLatestBinary: (): undefined => undefined };

test('fake Vita3K supports launch, status, screen, input, logs and shutdown', async () => {
  const runtime = new RuntimeManager(fakeBuilds as never, {
    executable: process.execPath,
    args: [fakeExecutable],
    bridgeConnectTimeoutMs: 5_000,
  });
  try {
    const apps = await runtime.listApps();
    assert.equal(apps[0]?.titleId, 'FAKE00001');
    const session = await runtime.launch({ titleId: 'FAKE00001', appArgs: [], replace: false });
    const status = await runtime.status(session.id, undefined, 1_000);
    assert.equal(status.phase, 'running');
    await runtime.sendInput(session.id, { buttons: ['cross'] }, 1);
    await runtime.touch(session.id, 'front', [{ x: 0.5, y: 0.5 }], 1);
    const capture = await runtime.capture(session.id);
    assert.equal(capture.width, 1);
    assert.ok(existsSync(capture.path));
    assert.ok(path.isAbsolute(capture.path));
    assert.equal((await runtime.control('pause', session.id)).accepted, true);
    assert.equal((await runtime.status(session.id)).phase, 'paused');
    const logs = runtime.getLogs(0, 'warn', 200, session.id);
    assert.equal(logs.lines.some((line) => line.text.includes('fake warning')), true);
    assert.equal(logs.lines.some((line) => line.text.includes('\u001b')), false);
    assert.equal(runtime.getLogs(logs.cursor, 'warn', 200, session.id).lines.length, 0);
  } finally {
    await runtime.shutdown();
  }
});

test('a crashed fake process is recorded and the bridge can restart', async () => {
  const runtime = new RuntimeManager(fakeBuilds as never, {
    executable: process.execPath,
    args: [fakeExecutable],
    bridgeConnectTimeoutMs: 5_000,
  });
  try {
    const session = await runtime.launch({ titleId: 'FAKE00001', appArgs: ['--crash'], replace: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await runtime.status(session.id);
    assert.equal(status.phase, 'crashed');
    assert.equal(status.exitCode, 9);
    assert.equal((await runtime.listApps())[0]?.titleId, 'FAKE00001');
  } finally {
    await runtime.shutdown();
  }
});

test('an asynchronous Vita3K launch failure is returned as structured session state', async () => {
  const runtime = new RuntimeManager(fakeBuilds as never, {
    executable: process.execPath,
    args: [fakeExecutable],
    bridgeConnectTimeoutMs: 5_000,
  });
  try {
    const session = await runtime.launch({ titleId: 'FAKE00001', appArgs: ['--fail'], replace: false });
    const status = await runtime.status(session.id);
    assert.equal(status.phase, 'failed');
    assert.deepEqual(status.error, { code: 'VITA3K_SESSION_FAILED', message: 'synthetic launch failure' });
  } finally {
    await runtime.shutdown();
  }
});
