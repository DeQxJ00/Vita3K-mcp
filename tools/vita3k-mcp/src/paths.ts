import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(moduleDir, '..');
export const repoRoot = path.resolve(process.env.VITA3K_MCP_REPO_ROOT ?? path.resolve(serverRoot, '..', '..'));
export const toolRoot = path.resolve(process.env.VITA3K_MCP_TOOL_ROOT ?? path.join(repoRoot, '.tools'));
export const stateRoot = path.resolve(process.env.VITA3K_MCP_STATE_ROOT ?? path.join(repoRoot, '.vita3k-mcp'));
export const runsRoot = path.join(stateRoot, 'runs');

export function isWithin(parent: string, child: string): boolean {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function requireWithin(parent: string, child: string): string {
  const resolved = path.resolve(child);
  if (!isWithin(parent, resolved)) {
    throw new Error(`Path escapes allowed root: ${resolved}`);
  }
  return resolved;
}

export async function ensureStateDirectories(): Promise<void> {
  await mkdir(toolRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
}

export async function canonicalIfPresent(value: string): Promise<string> {
  return existsSync(value) ? realpath(value) : path.resolve(value);
}
