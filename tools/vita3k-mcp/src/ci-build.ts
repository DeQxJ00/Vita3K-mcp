import { BuildManager } from './build-manager.js';

const manager = new BuildManager();
const buildId = manager.start('RelWithDebInfo', true);
let cursor = 0;

while (true) {
  const status = await manager.status(buildId, cursor, 30_000);
  for (const line of status.lines) process.stdout.write(`${line}\n`);
  cursor = status.cursor;
  if (status.phase === 'succeeded') {
    process.stdout.write(`Vita3K executable: ${status.binaryPath}\n`);
    break;
  }
  if (status.phase === 'failed') {
    process.stderr.write(`${status.error?.code ?? 'BUILD_FAILED'}: ${status.error?.message ?? 'Build failed'}\n`);
    process.exitCode = 1;
    break;
  }
}
