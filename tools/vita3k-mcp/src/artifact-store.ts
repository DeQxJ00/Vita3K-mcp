import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireWithin, runsRoot } from './paths.js';

export type SessionPhase = 'starting' | 'idle' | 'installing' | 'launching' | 'running' | 'paused' | 'stopping' | 'stopped' | 'exited' | 'crashed' | 'failed';

export interface SessionRecord {
  id: string;
  directory: string;
  relativeDirectory: string;
  phase: SessionPhase;
  revision: number;
  createdAt: string;
  updatedAt: string;
  titleId?: string;
  contentPath?: string;
  buildVersion: string;
  executable: string;
  appArgs: string[];
  screenshotCount: number;
  exitCode?: number | null;
  error?: { code: string; message: string };
  timeline: Array<{ at: string; phase: SessionPhase; message?: string }>;
}
function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class ArtifactStore {
  async create(input: { titleId?: string; contentPath?: string; buildVersion: string; executable: string; appArgs: string[] }): Promise<SessionRecord> {
    const id = randomUUID();
    const relativeDirectory = `${safeTimestamp()}-${id}`;
    const directory = requireWithin(runsRoot, path.join(runsRoot, relativeDirectory));
    await mkdir(path.join(directory, 'screenshots'), { recursive: true });
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id,
      directory,
      relativeDirectory,
      phase: 'starting',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.titleId ? { titleId: input.titleId } : {}),
      ...(input.contentPath ? { contentPath: input.contentPath } : {}),
      buildVersion: input.buildVersion,
      executable: input.executable,
      appArgs: input.appArgs,
      screenshotCount: 0,
      timeline: [{ at: now, phase: 'starting' }],
    };
    await this.persist(session);
    return session;
  }

  async setPhase(session: SessionRecord, phase: SessionPhase, message?: string): Promise<void> {
    if (session.phase === phase && !message) return;
    const now = new Date().toISOString();
    session.phase = phase;
    session.revision += 1;
    session.updatedAt = now;
    session.timeline.push({ at: now, phase, ...(message ? { message } : {}) });
    await this.persist(session);
  }

  async setFailure(session: SessionRecord, code: string, message: string): Promise<void> {
    session.error = { code, message };
    await this.setPhase(session, 'failed', `${code}: ${message}`);
  }

  async setExit(session: SessionRecord, phase: 'exited' | 'crashed', exitCode: number | null): Promise<void> {
    session.exitCode = exitCode;
    await this.setPhase(session, phase, `Vita3K exited with code ${exitCode ?? 'unknown'}`);
  }

  async appendStdout(session: SessionRecord | undefined, line: string): Promise<void> {
    if (!session) return;
    await appendFile(path.join(session.directory, 'vita3k.log'), line + '\n', 'utf8');
  }

  async appendStderr(session: SessionRecord | undefined, line: string): Promise<void> {
    if (!session) return;
    await appendFile(path.join(session.directory, 'stderr.log'), line + '\n', 'utf8');
  }

  nextScreenshot(session: SessionRecord): { absolute: string; relativeToRuns: string } {
    session.screenshotCount += 1;
    const name = `${String(session.screenshotCount).padStart(4, '0')}.png`;
    return {
      absolute: requireWithin(session.directory, path.join(session.directory, 'screenshots', name)),
      relativeToRuns: path.join(session.relativeDirectory, 'screenshots', name),
    };
  }

  async persist(session: SessionRecord): Promise<void> {
    const manifest = {
      schemaVersion: 1,
      sessionId: session.id,
      phase: session.phase,
      revision: session.revision,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      build: {
        version: session.buildVersion,
        executable: session.executable,
      },
      app: {
        ...(session.titleId ? { titleId: session.titleId } : {}),
        ...(session.contentPath ? { contentPath: session.contentPath } : {}),
        appArgs: session.appArgs,
      },
      screenshotCount: session.screenshotCount,
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.error ? { error: session.error } : {}),
      timeline: session.timeline,
    };
    await writeFile(path.join(session.directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
}
