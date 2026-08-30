import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { repoRoot, serverRoot, toolRoot } from '../paths.js';

test('toolchain lock pins versions, remote locations, and archive hashes', async () => {
  const lock = JSON.parse(await readFile(path.join(serverRoot, 'toolchain.lock.json'), 'utf8')) as Record<string, any>;
  for (const name of ['cmake', 'node']) {
    assert.match(lock[name].version, /^\d+\.\d+\.\d+$/);
    assert.match(lock[name].url, /^https:\/\//);
    assert.match(lock[name].sha256, /^[a-f0-9]{64}$/);
  }
  assert.match(lock.buildDependencies.openssl.sha256, /^[a-f0-9]{64}$/);
  assert.equal(lock.qt.version, '6.11.0');
  assert.ok(lock.qt.archives.length >= 8);
  for (const archive of lock.qt.archives) {
    assert.match(archive.url, /^https:\/\/download\.qt\.io\//);
    assert.match(archive.sha256, /^[a-f0-9]{64}$/);
  }
});

test('provisioner is repository-local and never invokes global installers or persistent environment writes', async () => {
  const script = await readFile(path.join(serverRoot, 'scripts', 'ensure-toolchain.ps1'), 'utf8');
  assert.match(script, /Assert-LocalPath/);
  assert.match(script, /\.tools|toolRoot/i);
  assert.match(script, /archiveSha256/);
  assert.match(script, /qmakeSha256/);
  assert.doesNotMatch(script, /setx\b|VisualStudio\.Installer|Start-Process|winget\b|choco\b|npm\s+(?:i|install)\s+-g|pip\s+install\s+--user/i);
  assert.equal(path.dirname(toolRoot), repoRoot);
});
