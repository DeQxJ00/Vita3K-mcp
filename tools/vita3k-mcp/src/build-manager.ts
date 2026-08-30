import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Vita3kError } from './errors.js';
import { repoRoot, serverRoot, toolRoot } from './paths.js';

export type BuildConfiguration = 'Debug' | 'RelWithDebInfo' | 'Release';
export type BuildPhase = 'provisioning' | 'configuring' | 'building' | 'succeeded' | 'failed';

interface BuildJob {
  id: string;
  configuration: BuildConfiguration;
  phase: BuildPhase;
  logs: string[];
  exitCode?: number;
  binaryPath?: string;
  error?: { code: string; message: string };
  changed: Array<() => void>;
}

export interface BuildSnapshot {
  buildId: string;
  configuration: BuildConfiguration;
  phase: BuildPhase;
  cursor: number;
  lines: string[];
  exitCode?: number;
  binaryPath?: string;
  error?: { code: string; message: string };
}

export class BuildManager {
  private readonly jobs = new Map<string, BuildJob>();
  private latestBinary?: string;
  private readonly powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  start(configuration: BuildConfiguration, reconfigure: boolean): string {
    const id = randomUUID();
    const job: BuildJob = {
      id,
      configuration,
      phase: 'provisioning',
      logs: [],
      changed: [],
    };
    this.jobs.set(id, job);
    void this.run(job, reconfigure);
    return id;
  }

  getLatestBinary(): string | undefined {
    return this.latestBinary;
  }

  async status(id: string, cursor = 0, waitMs = 0): Promise<BuildSnapshot> {
    const job = this.jobs.get(id);
    if (!job) throw new Vita3kError('BUILD_NOT_FOUND', `Unknown build id: ${id}`);
    const safeCursor = Math.max(0, Math.min(cursor, job.logs.length));
    if (waitMs > 0 && safeCursor === job.logs.length && !this.isTerminal(job.phase)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, 30_000));
        job.changed.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return {
      buildId: job.id,
      configuration: job.configuration,
      phase: job.phase,
      cursor: job.logs.length,
      lines: job.logs.slice(safeCursor),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.binaryPath ? { binaryPath: job.binaryPath } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  private isTerminal(phase: BuildPhase): boolean {
    return phase === 'succeeded' || phase === 'failed';
  }

  private update(job: BuildJob, phase?: BuildPhase, line?: string): void {
    if (phase) job.phase = phase;
    if (line) job.logs.push(line);
    const waiters = job.changed.splice(0);
    for (const wake of waiters) wake();
  }

  private async run(job: BuildJob, reconfigure: boolean): Promise<void> {
    try {
      const msvcEnv = await this.requireMsvc(job);
      await this.requireDiskSpace();
      const ensureScript = path.join(serverRoot, 'scripts', 'ensure-toolchain.ps1');
      await this.runProcess(job, this.powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureScript,
        '-RepoRoot', repoRoot, '-Components', 'CMake,Qt,BuildDeps',
      ]);

      const cmake = path.join(toolRoot, 'cmake', 'bin', 'cmake.exe');
      const qtRoot = path.join(toolRoot, 'qt', '6.11.0', 'msvc2022_64');
      if (!existsSync(cmake)) throw new Vita3kError('MISSING_CMAKE', 'Repository-local CMake provisioning did not complete.');
      if (!existsSync(path.join(qtRoot, 'bin', 'qmake.exe'))) throw new Vita3kError('MISSING_QT', 'Repository-local Qt provisioning did not complete.');
      const env = {
        ...msvcEnv,
        Qt6_ROOT: qtRoot,
        PATH: `${path.join(qtRoot, 'bin')};${path.join(toolRoot, 'cmake', 'bin')};${msvcEnv.PATH ?? ''}`,
      };

      this.update(job, 'configuring', `Configuring windows-vs2022${reconfigure ? ' (forced)' : ''}`);
      await this.runProcess(job, cmake, [
        '--preset', 'windows-vs2022',
        '-DUSE_DISCORD_RICH_PRESENCE=OFF',
        `-DCMAKE_GENERATOR_INSTANCE=${msvcEnv.VITA3K_MSVC_INSTALLATION}`,
      ], env);

      this.update(job, 'building', `Building vita3k (${job.configuration})`);
      const preset = `windows-vs2022-${job.configuration.toLowerCase()}`;
      await this.runProcess(job, cmake, ['--build', '--preset', preset, '--target', 'vita3k'], env);

      this.update(job, undefined, 'Building and running MCP automation protocol tests');
      await this.runProcess(job, cmake, ['--build', '--preset', preset, '--target', 'gui-qt-automation-tests'], env);
      await this.runProcess(job, path.join(toolRoot, 'cmake', 'bin', 'ctest.exe'), [
        '--test-dir', path.join(repoRoot, 'build', 'windows-vs2022'),
        '-C', job.configuration,
        '--output-on-failure',
        '-R', '^gui-qt-automation$',
      ], env);

      const binaryPath = await this.findBinary(path.join(repoRoot, 'build', 'windows-vs2022'), job.configuration);
      if (!binaryPath) throw new Vita3kError('BINARY_NOT_FOUND', 'Build succeeded but Vita3K.exe was not found.');
      job.binaryPath = binaryPath;
      job.exitCode = 0;
      this.latestBinary = binaryPath;
      this.update(job, 'succeeded', `Built ${binaryPath}`);
    } catch (error) {
      const failure = error instanceof Vita3kError ? error : new Vita3kError('BUILD_FAILED', error instanceof Error ? error.message : String(error));
      job.exitCode ??= 1;
      job.error = { code: failure.code, message: failure.message };
      this.update(job, 'failed', `${failure.code}: ${failure.message}`);
    }
  }

  private async requireMsvc(job: BuildJob): Promise<NodeJS.ProcessEnv> {
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const vswhere = programFilesX86 ? path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe') : '';
    if (!vswhere || !existsSync(vswhere)) throw new Vita3kError('MISSING_MSVC', 'Existing Visual Studio 2022 C++ tools were not found. No installer was started.');
    const output = await this.captureProcess(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
    if (!output.trim()) throw new Vita3kError('MISSING_MSVC', 'Existing Visual Studio 2022 C++ tools were not found. No installer was started.');
    const installationPath = output.trim();
    const environmentScript = path.join(serverRoot, 'scripts', 'get-msvc-env.ps1');
    const environmentText = await this.captureProcess(this.powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', environmentScript,
      '-InstallationPath', installationPath,
    ]);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const line of environmentText.split(/\r?\n/)) {
      const equals = line.indexOf('=');
      if (equals > 0) {
        const name = line.slice(0, equals).toUpperCase() === 'PATH' ? 'PATH' : line.slice(0, equals);
        for (const existing of Object.keys(environment)) {
          if (existing.toUpperCase() === name.toUpperCase()) delete environment[existing];
        }
        environment[name] = line.slice(equals + 1);
      }
    }
    environment.VITA3K_MSVC_INSTALLATION = installationPath;
    this.update(job, undefined, `Using existing MSVC at ${installationPath}`);
    return environment;
  }

  private runProcess(job: BuildJob, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(command, args, {
        cwd: repoRoot,
        env,
        windowsHide: true,
        stdio: 'pipe',
      });
      child.stdin.end();
      const consume = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) this.update(job, undefined, line);
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else {
          const recentOutput = job.logs.slice(-120).join('\n');
          if (/error code 112|错误代码\s*112|no space left on device|not enough space/i.test(recentOutput)) {
            reject(new Vita3kError('DISK_SPACE_LOW', 'The repository drive does not have enough free space to finish the build.', true));
          } else if (/SHA-256 mismatch/i.test(recentOutput)) {
            reject(new Vita3kError('HASH_MISMATCH', 'A downloaded tool archive failed SHA-256 verification.'));
          } else if (/Download failed|Could not resolve host|connection.*failed/i.test(recentOutput)) {
            reject(new Vita3kError('DOWNLOAD_FAILED', 'A repository-local tool download failed.', true));
          } else if (/access.*denied|permission denied|not writable/i.test(recentOutput)) {
            reject(new Vita3kError('TOOLS_NOT_WRITABLE', 'The repository .tools directory is not writable.'));
          } else {
            reject(new Vita3kError('BUILD_COMMAND_FAILED', `${path.basename(command)} exited with code ${code ?? -1}.`, false, { command, args }));
          }
        }
      });
    });
  }

  private async requireDiskSpace(): Promise<void> {
    const stats = await statfs(repoRoot);
    const freeBytes = stats.bavail * stats.bsize;
    const minimumBytes = 4 * 1024 * 1024 * 1024;
    if (freeBytes < minimumBytes) {
      const freeGiB = (freeBytes / 1024 / 1024 / 1024).toFixed(2);
      throw new Vita3kError('DISK_SPACE_LOW', `The repository drive has ${freeGiB} GiB free; at least 4 GiB is required to build safely.`, true);
    }
  }

  private captureProcess(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} failed`)));
    });
  }

  private async findBinary(root: string, configuration: BuildConfiguration): Promise<string | undefined> {
    if (!existsSync(root)) return undefined;
    const matches: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.toLowerCase() === 'vita3k.exe' && full.toLowerCase().includes(configuration.toLowerCase())) matches.push(full);
      }
    };
    await walk(root);
    return matches[0];
  }
}
