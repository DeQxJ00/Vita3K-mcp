import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ArtifactStore, type SessionPhase, type SessionRecord } from './artifact-store.js';
import { BridgeClient } from './bridge-client.js';
import type { BuildManager } from './build-manager.js';
import { Vita3kError } from './errors.js';
import { repoRoot, runsRoot } from './paths.js';

export interface AppInfo {
  titleId: string;
  title: string;
  shortTitle: string;
  version: string;
  category: string;
  contentId: string;
}

export interface RuntimeOptions {
  executable?: string;
  args?: string[];
  bridgeConnectTimeoutMs?: number;
}

interface LogEntry {
  index: number;
  stream: 'stdout' | 'stderr';
  level: string;
  text: string;
}

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function repositoryRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return 'unknown';
  }
}

export class RuntimeManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private bridge: BridgeClient | undefined;
  private session: SessionRecord | undefined;
  private readonly artifacts = new ArtifactStore();
  private logs: LogEntry[] = [];
  private logIndex = 0;
  private executableOverride: string | undefined;
  private activeExecutable: string | undefined;
  private readonly buildVersion = process.env.VITA3K_BUILD_VERSION ?? repositoryRevision();

  constructor(private readonly builds: BuildManager, private readonly options: RuntimeOptions = {}) {
    this.executableOverride = options.executable ?? process.env.VITA3K_EXECUTABLE;
  }

  async listApps(refresh = false): Promise<AppInfo[]> {
    await this.ensureRuntime();
    const result = await this.bridge!.request('apps.list', { refresh });
    return (result.apps as AppInfo[] | undefined) ?? [];
  }

  async launch(input: { titleId?: string; contentPath?: string; appArgs: string[]; replace: boolean }): Promise<SessionRecord> {
    await this.ensureRuntime();
    if (this.session && ['installing', 'launching', 'running', 'paused'].includes(this.session.phase) && !input.replace) {
      throw new Vita3kError('SESSION_ACTIVE', 'An application is already active. Stop it or pass replace=true.');
    }
    if (input.contentPath) {
      const resolved = path.resolve(input.contentPath);
      if (!existsSync(resolved)) throw new Vita3kError('INVALID_CONTENT', `Content path does not exist: ${resolved}`);
      const info = await stat(resolved);
      const extension = path.extname(resolved).toLowerCase();
      if (!info.isDirectory() && extension !== '.vpk' && extension !== '.zip') throw new Vita3kError('INVALID_CONTENT', 'Content must be a VPK, ZIP, or directory.');
      input.contentPath = resolved;
    }
    const previous = this.session;
    if (previous && input.replace) await this.stopCurrent('stopped');
    this.session = await this.artifacts.create({
      ...input,
      buildVersion: this.buildVersion,
      executable: this.activeExecutable ?? 'unknown',
    });
    await this.artifacts.setPhase(this.session, input.contentPath ? 'installing' : 'launching');
    try {
      await this.bridge!.request('app.launch', {
        sessionId: this.session.id,
        ...(input.titleId ? { titleId: input.titleId } : {}),
        ...(input.contentPath ? { contentPath: input.contentPath } : {}),
        appArgs: input.appArgs,
        replace: input.replace,
      });
      return this.session;
    } catch (error) {
      const failure = error instanceof Vita3kError ? error : new Vita3kError('LAUNCH_FAILED', error instanceof Error ? error.message : String(error));
      await this.artifacts.setFailure(this.session, failure.code, failure.message);
      throw failure;
    }
  }

  async status(sessionId?: string, afterRevision?: number, waitMs = 0): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    const deadline = Date.now() + Math.min(waitMs, 30_000);
    do {
      if (this.bridge) {
        try {
          const state = await this.bridge.request('session.status');
          const phase = this.normalizePhase(String(state.phase ?? 'idle'));
          if (phase !== session.phase) await this.artifacts.setPhase(session, phase);
          if (typeof state.titleId === 'string' && state.titleId) session.titleId = state.titleId;
          await this.artifacts.persist(session);
          if (afterRevision === undefined || session.revision > afterRevision || waitMs === 0) return this.snapshot(session, state);
        } catch (error) {
          if (!this.child) break;
          if (error instanceof Vita3kError && error.code !== 'PIPE_TIMEOUT') throw error;
        }
      }
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return this.snapshot(session, {});
  }

  async capture(sessionId: string): Promise<{ data: string; path: string; width: number; height: number }> {
    const session = this.requireSession(sessionId);
    if (!this.bridge || !['running', 'paused'].includes(session.phase)) throw new Vita3kError('NO_ACTIVE_SESSION', 'A running or paused application is required for capture.');
    const target = this.artifacts.nextScreenshot(session);
    const result = await this.bridge.request('screen.capture', { relativePath: target.relativeToRuns }, 30_000);
    await this.artifacts.persist(session);
    const data = await readFile(target.absolute);
    return { data: data.toString('base64'), path: target.absolute, width: Number(result.width ?? 0), height: Number(result.height ?? 0) };
  }

  async sendInput(sessionId: string, input: Record<string, unknown>, durationMs: number): Promise<void> {
    this.requireRunningSession(sessionId);
    try {
      await this.bridge!.request('input.set', input);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } finally {
      await this.bridge?.request('input.clear').catch(() => {});
    }
  }

  async touch(sessionId: string, port: 'front' | 'rear', points: Array<{ x: number; y: number }>, durationMs: number): Promise<void> {
    this.requireRunningSession(sessionId);
    const step = points.length > 1 ? Math.max(1, Math.floor(durationMs / (points.length - 1))) : durationMs;
    try {
      await this.bridge!.request('touch.event', { action: 'down', port, ...points[0] });
      if (points.length === 1) await new Promise((resolve) => setTimeout(resolve, durationMs));
      for (let index = 1; index < points.length; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, step));
        await this.bridge!.request('touch.event', { action: 'move', port, ...points[index] });
      }
    } finally {
      await this.bridge?.request('touch.event', { action: 'up', port }).catch(() => {});
    }
  }

  getLogs(cursor = 0, minLevel = 'trace', limit = 200, sessionId?: string): { cursor: number; lines: LogEntry[] } {
    if (sessionId) this.requireSession(sessionId);
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'critical'];
    const threshold = Math.max(0, levels.indexOf(minLevel));
    const start = Math.max(0, cursor);
    const lines = this.logs.filter((entry) => entry.index >= start && levels.indexOf(entry.level) >= threshold).slice(0, limit);
    return { cursor: lines.length ? lines[lines.length - 1]!.index + 1 : this.logIndex, lines };
  }

  async control(action: 'pause' | 'resume' | 'restart' | 'stop' | 'shutdown', sessionId?: string): Promise<Record<string, unknown>> {
    if (action === 'shutdown') {
      if (this.bridge) await this.bridge.request('emulator.shutdown').catch(() => {});
      return { action, accepted: true };
    }
    const session = this.requireSession(sessionId);
    if (!this.bridge) throw new Vita3kError('PIPE_DISCONNECTED', 'Vita3K control pipe is disconnected.', true);
    if (action === 'pause' || action === 'resume') {
      await this.bridge.request('session.pause', { paused: action === 'pause' });
      await this.artifacts.setPhase(session, action === 'pause' ? 'paused' : 'running');
    } else if (action === 'restart') {
      await this.bridge.request('session.restart');
      await this.artifacts.setPhase(session, 'launching', 'Restart requested');
    } else {
      await this.bridge.request('session.stop');
      await this.artifacts.setPhase(session, 'stopped');
    }
    return { action, accepted: true, sessionId: session.id };
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    try {
      await this.bridge?.request('input.clear', {}, 1_000).catch(() => {});
      await this.bridge?.request('touch.clear', {}, 1_000).catch(() => {});
      await this.bridge?.request('emulator.shutdown', {}, 2_000).catch(() => {});
      if (child && child.exitCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    } finally {
      this.bridge?.close();
      this.bridge = undefined;
      if (child && child.exitCode === null && !child.killed) child.kill();
      this.child = undefined;
    }
  }

  private async ensureRuntime(): Promise<void> {
    if (this.child && this.bridge) return;
    const executable = await this.resolveExecutable();
    this.activeExecutable = executable;
    const pipeName = `vita3k-mcp-${process.pid}-${randomBytes(8).toString('hex')}`;
    const token = randomBytes(32).toString('hex');
    const env = {
      ...process.env,
      VITA3K_MCP_PIPE: pipeName,
      VITA3K_MCP_TOKEN: token,
      VITA3K_MCP_ARTIFACT_ROOT: runsRoot,
    };
    const child: ChildProcessWithoutNullStreams = spawn(executable, this.options.args ?? [], { cwd: path.dirname(executable), env, windowsHide: false, stdio: 'pipe' });
    child.stdin.end();
    this.child = child;
    this.consumeStream(child.stdout, 'stdout');
    this.consumeStream(child.stderr, 'stderr');
    child.once('exit', (code) => {
      const active = this.session;
      this.child = undefined;
      this.bridge?.close();
      this.bridge = undefined;
      if (active) void this.artifacts.setExit(active, code === 0 ? 'exited' : 'crashed', code);
    });
    child.once('error', (error) => this.addLog('stderr', `Failed to start Vita3K: ${error.message}`));
    const bridge = new BridgeClient(pipeName, token);
    this.bridge = bridge;
    try {
      await bridge.connect(this.options.bridgeConnectTimeoutMs);
    } catch (error) {
      child.kill();
      this.child = undefined;
      this.bridge = undefined;
      throw error;
    }
  }

  private async resolveExecutable(): Promise<string> {
    const candidates = [this.executableOverride, this.builds.getLatestBinary()].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) if (existsSync(candidate)) return path.resolve(candidate);
    const root = path.join(repoRoot, 'build');
    if (existsSync(root)) {
      const matches: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.name.toLowerCase() === 'vita3k.exe') matches.push(full);
        }
      };
      await walk(root);
      if (matches.length) return matches[0]!;
    }
    throw new Vita3kError('BINARY_NOT_FOUND', 'No Vita3K.exe was found. Run build_start first or set VITA3K_EXECUTABLE.');
  }

  private consumeStream(stream: NodeJS.ReadableStream, source: 'stdout' | 'stderr'): void {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line) this.addLog(source, line);
    });
    stream.on('end', () => { if (buffer) this.addLog(source, buffer); });
  }

  private addLog(stream: 'stdout' | 'stderr', value: string): void {
    const text = value.replace(ANSI_PATTERN, '');
    const levelMatch = text.match(/\|([TDIWEC])\|/);
    const level = ({ T: 'trace', D: 'debug', I: 'info', W: 'warn', E: 'error', C: 'critical' } as Record<string, string>)[levelMatch?.[1] ?? ''] ?? (stream === 'stderr' ? 'error' : 'info');
    const entry: LogEntry = { index: this.logIndex++, stream, level, text };
    this.logs.push(entry);
    if (this.logs.length > 50_000) this.logs = this.logs.slice(-40_000);
    if (stream === 'stdout') void this.artifacts.appendStdout(this.session, text);
    else void this.artifacts.appendStderr(this.session, text);
  }

  private requireSession(sessionId?: string): SessionRecord {
    if (!this.session) throw new Vita3kError('NO_ACTIVE_SESSION', 'No Vita3K application session exists.');
    if (sessionId && sessionId !== this.session.id) throw new Vita3kError('SESSION_NOT_FOUND', `Session is not active: ${sessionId}`);
    return this.session;
  }

  private requireRunningSession(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (!['running', 'paused'].includes(session.phase)) throw new Vita3kError('NO_ACTIVE_SESSION', `Session is not running (phase: ${session.phase}).`);
    return session;
  }

  private async stopCurrent(phase: SessionPhase): Promise<void> {
    if (this.bridge) await this.bridge.request('session.stop').catch(() => {});
    if (this.session) await this.artifacts.setPhase(this.session, phase);
  }

  private normalizePhase(value: string): SessionPhase {
    const supported: SessionPhase[] = ['starting', 'idle', 'installing', 'launching', 'running', 'paused', 'stopping', 'stopped', 'exited', 'crashed', 'failed'];
    return supported.includes(value as SessionPhase) ? value as SessionPhase : 'failed';
  }

  private snapshot(session: SessionRecord, bridge: Record<string, unknown>): Record<string, unknown> {
    return {
      sessionId: session.id,
      phase: session.phase,
      revision: session.revision,
      titleId: session.titleId ?? bridge.titleId ?? null,
      title: bridge.title ?? null,
      paused: session.phase === 'paused',
      fps: bridge.fps ?? 0,
      resolution: bridge.resolution ?? null,
      processId: this.child?.pid ?? null,
      artifactDirectory: session.directory,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(session.createdAt)),
      exitCode: session.exitCode ?? null,
      crash: session.phase === 'crashed' ? { exitCode: session.exitCode ?? null } : null,
      error: session.error ?? null,
    };
  }
}
