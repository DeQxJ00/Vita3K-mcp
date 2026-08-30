import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { BuildManager, type BuildConfiguration } from './build-manager.js';
import { errorPayload } from './errors.js';
import { ensureStateDirectories } from './paths.js';
import { RuntimeManager } from './runtime-manager.js';

const builds = new BuildManager();
const runtime = new RuntimeManager(builds);

const buttonSchema = z.enum([
  'select', 'start', 'up', 'right', 'down', 'left',
  'triangle', 'circle', 'cross', 'square', 'ps',
  'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
]);
const stickSchema = z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) });

function success(value: Record<string, unknown>, summary?: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary ?? JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown): CallToolResult {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function registerTools(server: McpServer): void {
  server.registerTool('build_start', {
    title: 'Build Vita3K',
    description: 'Start a repository-local Vita3K configure and incremental build. Missing CMake and Qt are provisioned only under .tools; Visual Studio is never installed.',
    inputSchema: z.object({
      configuration: z.enum(['Debug', 'RelWithDebInfo', 'Release']).default('RelWithDebInfo'),
      reconfigure: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ configuration, reconfigure }) => {
    try {
      const buildId = builds.start(configuration as BuildConfiguration, reconfigure);
      return success({ ok: true, buildId, phase: 'provisioning' });
    } catch (error) { return failure(error); }
  });

  server.registerTool('build_status', {
    title: 'Get Vita3K build status',
    description: 'Read incremental output from a build. waitMs can wait up to 30 seconds for new output or completion.',
    inputSchema: z.object({
      buildId: z.string().uuid(),
      cursor: z.number().int().nonnegative().default(0),
      waitMs: z.number().int().min(0).max(30_000).default(0),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ buildId, cursor, waitMs }) => {
    try { return success({ ok: true, ...(await builds.status(buildId, cursor, waitMs)) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool('list_apps', {
    title: 'List installed Vita applications',
    description: 'List applications from the existing Vita3K data profile. Starts an idle visible Vita3K process when needed.',
    inputSchema: z.object({ refresh: z.boolean().default(false) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ refresh }) => {
    try {
      const apps = await runtime.listApps(refresh);
      return success({ ok: true, apps, count: apps.length });
    } catch (error) { return failure(error); }
  });

  server.registerTool('launch_app', {
    title: 'Launch a Vita application',
    description: 'Launch an installed Title ID, or install and launch a local VPK, ZIP, or unpacked directory. Exactly one of titleId/contentPath is required.',
    inputSchema: z.object({
      titleId: z.string().min(1).optional(),
      contentPath: z.string().min(1).optional(),
      appArgs: z.array(z.string()).default([]),
      replace: z.boolean().default(false),
    }).refine((value) => Boolean(value.titleId) !== Boolean(value.contentPath), { message: 'Exactly one of titleId or contentPath is required.' }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ titleId, contentPath, appArgs, replace }) => {
    try {
      const session = await runtime.launch({ ...(titleId ? { titleId } : {}), ...(contentPath ? { contentPath } : {}), appArgs, replace });
      return success({ ok: true, sessionId: session.id, phase: session.phase, artifactDirectory: session.directory });
    } catch (error) { return failure(error); }
  });

  server.registerTool('session_status', {
    title: 'Get Vita3K session status',
    description: 'Get application phase and runtime state. afterRevision plus waitMs waits for a state change without busy polling.',
    inputSchema: z.object({
      sessionId: z.string().uuid().optional(),
      afterRevision: z.number().int().nonnegative().optional(),
      waitMs: z.number().int().min(0).max(30_000).default(0),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ sessionId, afterRevision, waitMs }) => {
    try { return success({ ok: true, ...(await runtime.status(sessionId, afterRevision, waitMs)) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool('capture_screen', {
    title: 'Capture the Vita display',
    description: 'Capture the current emulated frame as PNG, archive it in the session directory, and return it as image content.',
    inputSchema: z.object({ sessionId: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sessionId }) => {
    try {
      const capture = await runtime.capture(sessionId);
      const metadata = { ok: true, path: capture.path, width: capture.width, height: capture.height, mimeType: 'image/png' };
      return {
        content: [
          { type: 'text', text: JSON.stringify(metadata, null, 2) },
          { type: 'image', data: capture.data, mimeType: 'image/png' },
        ],
        structuredContent: metadata,
      };
    } catch (error) { return failure(error); }
  });

  server.registerTool('send_input', {
    title: 'Send Vita controller input',
    description: 'Hold buttons and/or analog sticks for a bounded duration, then always release and recenter them.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      buttons: z.array(buttonSchema).default([]),
      leftStick: stickSchema.optional(),
      rightStick: stickSchema.optional(),
      durationMs: z.number().int().min(1).max(10_000).default(100),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sessionId, buttons, leftStick, rightStick, durationMs }) => {
    try {
      await runtime.sendInput(sessionId, { buttons, ...(leftStick ? { leftStick } : {}), ...(rightStick ? { rightStick } : {}) }, durationMs);
      return success({ ok: true, sessionId, released: true, durationMs });
    } catch (error) { return failure(error); }
  });

  server.registerTool('touch', {
    title: 'Send Vita touch input',
    description: 'Tap or drag on the front or rear Vita touch surface using normalized 0..1 coordinates, then always release.',
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      port: z.enum(['front', 'rear']),
      points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1).max(32),
      durationMs: z.number().int().min(1).max(10_000).default(100),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sessionId, port, points, durationMs }) => {
    try {
      await runtime.touch(sessionId, port, points, durationMs);
      return success({ ok: true, sessionId, released: true, durationMs });
    } catch (error) { return failure(error); }
  });

  server.registerTool('get_logs', {
    title: 'Read Vita3K logs',
    description: 'Read ANSI-free incremental stdout/stderr logs. Pass the returned cursor to avoid duplicate lines.',
    inputSchema: z.object({
      sessionId: z.string().uuid().optional(),
      cursor: z.number().int().nonnegative().default(0),
      minLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'critical']).default('trace'),
      limit: z.number().int().min(1).max(1_000).default(200),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ sessionId, cursor, minLevel, limit }) => {
    try { return success({ ok: true, ...runtime.getLogs(cursor, minLevel, limit, sessionId) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool('control_session', {
    title: 'Control a Vita3K session',
    description: 'Pause, resume, restart, stop the current app, or shut down the emulator. Restart/stop/shutdown may lose unsaved game progress.',
    inputSchema: z.object({
      sessionId: z.string().uuid().optional(),
      action: z.enum(['pause', 'resume', 'restart', 'stop', 'shutdown']),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ sessionId, action }) => {
    try { return success({ ok: true, ...(await runtime.control(action, sessionId)) }); }
    catch (error) { return failure(error); }
  });
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'vita3k-codex', version: '0.1.0' },
    {
      instructions: 'Use build_start/build_status after C++ changes. Call list_apps before choosing a Title ID. For interactive tests: launch_app, wait with session_status until running, capture_screen, send one bounded input/touch action, then capture again and inspect get_logs. Stop or shut down when finished. Only launch content the user placed in scope; tests may modify game saves.',
    },
  );
  registerTools(server);
  return server;
}

await ensureStateDirectories();
const handle = serveStdio(createServer, { onerror: (error) => console.error(error) });

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await runtime.shutdown();
  await handle.close();
};
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.stdin.once('end', () => { void close().finally(() => process.exit(0)); });
process.stdin.once('close', () => { void close().finally(() => process.exit(0)); });
