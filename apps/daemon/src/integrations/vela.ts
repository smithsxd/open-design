import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveAgentLaunch } from '../runtimes/launch.js';
import { spawnEnvForAgent } from '../runtimes/env.js';
import { getAgentDef } from '../runtimes/registry.js';

const ACTIVE_PROFILE_ENV = 'VELA_PROFILE';
const DEFAULT_PROFILE = 'prod';
const ALLOWED_PROFILES = new Set(['prod', 'test', 'local']);

export interface VelaUser {
  id: string;
  email: string;
  name?: string;
  image?: string | null;
  plan?: string;
}

export interface VelaLoginStatus {
  loggedIn: boolean;
  profile: string;
  user: VelaUser | null;
  configPath: string;
}

interface VelaProfileShape {
  controlKey?: string;
  runtimeKey?: string;
  apiUrl?: string;
  linkUrl?: string;
  user?: VelaUser | null;
}

interface VelaConfigFileShape {
  profiles?: Record<string, VelaProfileShape>;
}

function configDir(): string {
  return path.join(homedir(), '.vela');
}

export function velaConfigPath(): string {
  return path.join(configDir(), 'config.json');
}

export function activeVelaProfileName(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[ACTIVE_PROFILE_ENV] || '').trim();
  if (!raw) return DEFAULT_PROFILE;
  return ALLOWED_PROFILES.has(raw) ? raw : DEFAULT_PROFILE;
}

function readConfigFile(): VelaConfigFileShape | null {
  const file = velaConfigPath();
  if (!existsSync(file)) return null;
  try {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as VelaConfigFileShape;
  } catch {
    return null;
  }
}

export function readVelaLoginStatus(
  env: NodeJS.ProcessEnv = process.env,
): VelaLoginStatus {
  const profile = activeVelaProfileName(env);
  const configPath = velaConfigPath();
  const file = readConfigFile();
  const stored = file?.profiles?.[profile];
  const runtimeKey = stored?.runtimeKey?.trim() ?? '';
  if (!runtimeKey) {
    return { loggedIn: false, profile, user: null, configPath };
  }
  const rawUser = stored?.user ?? null;
  const user: VelaUser | null = rawUser
    ? {
        id: typeof rawUser.id === 'string' ? rawUser.id : '',
        email: typeof rawUser.email === 'string' ? rawUser.email : '',
        ...(typeof rawUser.name === 'string' ? { name: rawUser.name } : {}),
        ...(typeof rawUser.image === 'string' ? { image: rawUser.image } : {}),
        ...(typeof rawUser.plan === 'string' ? { plan: rawUser.plan } : {}),
      }
    : null;
  return { loggedIn: true, profile, user, configPath };
}

export function forgetVelaLogin(): void {
  // Delete the entire config file. The vela CLI rewrites it from scratch on
  // the next successful `vela login`, so we don't need to preserve other
  // profiles or top-level keys.
  const file = velaConfigPath();
  if (!existsSync(file)) return;
  rmSync(file, { force: true });
}

export interface SpawnedVelaLogin {
  pid: number;
  startedAt: string;
  profile: string;
}

const activeLoginProcs = new Map<number, ChildProcess>();

export function isVelaLoginInFlight(): boolean {
  for (const [pid, child] of activeLoginProcs) {
    if (child.exitCode === null && child.signalCode === null) return true;
    activeLoginProcs.delete(pid);
  }
  return false;
}

export interface SpawnVelaLoginDeps {
  configuredEnv?: Record<string, string>;
  baseEnv?: NodeJS.ProcessEnv;
}

export function spawnVelaLogin(deps: SpawnVelaLoginDeps = {}): SpawnedVelaLogin {
  if (isVelaLoginInFlight()) {
    throw new Error('vela login already running');
  }
  const def = getAgentDef('amr');
  if (!def) throw new Error('AMR runtime def not registered');
  const baseEnv = deps.baseEnv ?? process.env;
  const configuredEnv = deps.configuredEnv ?? {};
  const launch = resolveAgentLaunch(def, configuredEnv);
  const bin = launch.selectedPath;
  if (!bin) {
    throw new Error('vela binary not found; install vela or configure VELA_BIN');
  }
  const env = spawnEnvForAgent('amr', baseEnv, configuredEnv);
  const child = spawn(bin, ['login'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: false,
  });
  if (typeof child.pid !== 'number') {
    throw new Error('failed to spawn vela login');
  }
  activeLoginProcs.set(child.pid, child);
  const cleanup = () => {
    if (typeof child.pid === 'number') activeLoginProcs.delete(child.pid);
  };
  child.once('exit', cleanup);
  child.once('error', cleanup);
  // We don't surface URL/code in this API — vela CLI opens the browser itself
  // (via OpenBrowser in apps/cli/internal/commands/login.go). Callers poll
  // readVelaLoginStatus() to detect completion.
  return {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    profile: activeVelaProfileName(baseEnv),
  };
}
