import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../artifact-store.js';
import { isWithin, requireWithin, runsRoot, toolRoot } from '../paths.js';

test('repository path guard rejects traversal', () => {
  assert.equal(isWithin(toolRoot, path.join(toolRoot, 'cmake')), true);
  assert.equal(isWithin(toolRoot, path.join(toolRoot, '..', 'outside')), false);
  assert.throws(() => requireWithin(toolRoot, path.join(toolRoot, '..', 'outside')), /escapes allowed root/);
});

test('artifact store creates the required run manifest without credentials', async () => {
  const store = new ArtifactStore();
  const record = await store.create({
    titleId: 'TEST00001',
    buildVersion: 'test-revision',
    executable: 'C:\\repo\\build\\Vita3K.exe',
    appArgs: ['--example'],
  });
  try {
    assert.equal(isWithin(runsRoot, record.directory), true);
    await store.setPhase(record, 'running');
    const screenshot = store.nextScreenshot(record);
    await store.recordScreenshot(record);
    assert.match(screenshot.absolute, /screenshots[\\/]0001\.png$/);
    assert.equal((await readFile(path.join(record.directory, 'vita3k.log'), 'utf8')), '');
    assert.equal((await readFile(path.join(record.directory, 'stderr.log'), 'utf8')), '');
    const manifestText = await readFile(path.join(record.directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    assert.equal(manifest.phase, 'running');
    assert.equal(manifest.screenshotCount, 1);
    assert.deepEqual(manifest.build, { version: 'test-revision', executable: 'C:\\repo\\build\\Vita3K.exe' });
    assert.equal(manifestText.includes('token'), false);
  } finally {
    await rm(record.directory, { recursive: true, force: true });
  }
});
