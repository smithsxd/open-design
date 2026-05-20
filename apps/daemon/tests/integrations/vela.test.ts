/**
 * Coverage for `apps/daemon/src/integrations/vela.ts` — the read-side of
 * the AMR (vela) login integration. The spawn path is exercised by
 * `tests/amr-acp-integration.test.ts` (which uses the fake-vela stub); here
 * we focus on the status reader that drives the Settings UI.
 *
 * `~/.vela/config.json` is the source of truth — vela CLI writes it on
 * successful `vela login` and Open Design just surfaces a small projection.
 * Tests redirect HOME via env so we never touch the real user file.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activeVelaProfileName,
  forgetVelaLogin,
  readVelaLoginStatus,
  velaConfigPath,
} from '../../src/integrations/vela.js';

let originalHome: string | undefined;
let tmpHome: string;

function writeConfig(payload: unknown): string {
  const dir = path.join(tmpHome, '.vela');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(path.join(tmpdir(), 'od-vela-test-'));
  process.env.HOME = tmpHome;
  delete process.env.VELA_PROFILE;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('activeVelaProfileName', () => {
  it('defaults to "prod" when VELA_PROFILE is unset', () => {
    expect(activeVelaProfileName({})).toBe('prod');
  });

  it('honors VELA_PROFILE when set to a known profile', () => {
    expect(activeVelaProfileName({ VELA_PROFILE: 'local' })).toBe('local');
    expect(activeVelaProfileName({ VELA_PROFILE: 'test' })).toBe('test');
  });

  it('rejects unknown profile names and falls back to prod (guard against env tampering)', () => {
    expect(activeVelaProfileName({ VELA_PROFILE: 'evil' })).toBe('prod');
    expect(activeVelaProfileName({ VELA_PROFILE: '   ' })).toBe('prod');
  });
});

describe('readVelaLoginStatus', () => {
  it('returns loggedIn=false when ~/.vela/config.json is absent', () => {
    const status = readVelaLoginStatus({ VELA_PROFILE: 'local' });
    expect(status.loggedIn).toBe(false);
    expect(status.user).toBeNull();
    expect(status.profile).toBe('local');
    expect(status.configPath).toBe(velaConfigPath());
  });

  it('returns loggedIn=true with user info when the active profile has a runtimeKey', () => {
    writeConfig({
      profiles: {
        local: {
          runtimeKey: 'rt-secret-abc',
          controlKey: 'ck-secret',
          apiUrl: 'http://localhost:18080',
          linkUrl: 'http://localhost:18081',
          user: {
            id: 'user_1',
            email: 'leaf@example.com',
            name: '杨瑾龙',
            image: 'https://example.com/avatar.png',
            plan: 'free',
          },
        },
      },
    });
    const status = readVelaLoginStatus({ VELA_PROFILE: 'local' });
    expect(status.loggedIn).toBe(true);
    expect(status.profile).toBe('local');
    expect(status.user?.email).toBe('leaf@example.com');
    expect(status.user?.plan).toBe('free');
    // The secrets in the file are intentionally NOT surfaced through the
    // status projection — the UI never needs them and we don't want them
    // showing up in HTTP responses to the local web.
    expect(JSON.stringify(status)).not.toContain('rt-secret-abc');
    expect(JSON.stringify(status)).not.toContain('ck-secret');
  });

  it('returns loggedIn=false when the active profile is present but lacks runtimeKey', () => {
    writeConfig({
      profiles: {
        local: { apiUrl: 'http://localhost:18080', user: { id: 'u', email: 'e' } },
      },
    });
    const status = readVelaLoginStatus({ VELA_PROFILE: 'local' });
    expect(status.loggedIn).toBe(false);
  });

  it('isolates profiles — a logged-in "local" does not imply logged-in "prod"', () => {
    writeConfig({
      profiles: {
        local: { runtimeKey: 'rt-local', user: { id: 'u', email: 'leaf@example.com' } },
      },
    });
    expect(readVelaLoginStatus({ VELA_PROFILE: 'local' }).loggedIn).toBe(true);
    expect(readVelaLoginStatus({ VELA_PROFILE: 'prod' }).loggedIn).toBe(false);
  });

  it('treats malformed JSON as logged-out rather than crashing', () => {
    const file = path.join(tmpHome, '.vela', 'config.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{not json', 'utf8');
    expect(readVelaLoginStatus({ VELA_PROFILE: 'local' }).loggedIn).toBe(false);
  });
});

describe('forgetVelaLogin', () => {
  it('removes ~/.vela/config.json so a subsequent status read returns logged-out', () => {
    writeConfig({
      profiles: {
        local: { runtimeKey: 'rt', user: { id: 'u', email: 'e' } },
      },
    });
    expect(readVelaLoginStatus({ VELA_PROFILE: 'local' }).loggedIn).toBe(true);
    forgetVelaLogin();
    expect(readVelaLoginStatus({ VELA_PROFILE: 'local' }).loggedIn).toBe(false);
  });

  it('is a no-op when the config file does not exist (idempotent)', () => {
    expect(() => forgetVelaLogin()).not.toThrow();
  });
});
