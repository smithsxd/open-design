// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '../../src/components/SettingsDialog';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchCodexPets: vi.fn().mockResolvedValue([]),
    fetchDesignSystems: vi.fn().mockResolvedValue([]),
    fetchSkills: vi.fn().mockResolvedValue([]),
    syncCommunityPets: vi.fn().mockResolvedValue({ pets: [] }),
  };
});

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
}));

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: null,
  skillId: null,
  designSystemId: null,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const availableAgents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.80.0',
    models: [{ id: 'default', label: 'Default' }],
  },
];

function ensureLocalStorage(): Storage {
  const current = window.localStorage as Partial<Storage> | undefined;
  if (
    current
    && typeof current.getItem === 'function'
    && typeof current.setItem === 'function'
    && typeof current.removeItem === 'function'
    && typeof current.clear === 'function'
  ) {
    return current as Storage;
  }
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

function mockCritiqueSettings(overrides: Record<string, boolean | null>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const projectId = decodeURIComponent(url.split('/')[3] ?? '');
    const projectOverride = overrides[projectId] ?? null;
    return new Response(JSON.stringify({
      projectOverride,
      envOverride: null,
      phase: 'M0',
      skillPolicy: null,
      enabled: projectOverride === true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function renderCritiqueSettings(projectId: string | null = null) {
  window.history.replaceState(
    null,
    '',
    projectId ? `/projects/${encodeURIComponent(projectId)}` : '/',
  );
  return render(
    <SettingsDialog
      initial={baseConfig}
      agents={availableAgents}
      daemonLive
      appVersionInfo={null}
      initialSection="critiqueTheater"
      onPersist={vi.fn()}
      onPersistComposioKey={vi.fn()}
      onClose={vi.fn()}
      onRefreshAgents={vi.fn()}
    />,
  );
}

describe('SettingsDialog Critique Theater project toggle', () => {
  beforeEach(() => {
    ensureLocalStorage();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    ensureLocalStorage();
    window.localStorage.clear();
  });

  it('shows independent checked states for different active projects', async () => {
    mockCritiqueSettings({
      'project-a': true,
      'project-b': false,
    });

    const view = renderCritiqueSettings('project-a');
    const checkbox = await screen.findByRole('checkbox', {
      name: /show design jury during agent runs/i,
    });
    await waitFor(() => expect(checkbox).toHaveProperty('checked', true));

    view.unmount();
    renderCritiqueSettings('project-b');
    const projectBCheckbox = await screen.findByRole('checkbox', {
      name: /show design jury during agent runs/i,
    });
    await waitFor(() => expect(projectBCheckbox).toHaveProperty('checked', false));
  });

  it('falls back to browser preference when Settings is opened off-project', async () => {
    window.localStorage.setItem(
      'open-design:config',
      JSON.stringify({ critiqueTheaterEnabled: true }),
    );
    mockCritiqueSettings({});

    renderCritiqueSettings(null);

    const checkbox = await screen.findByRole('checkbox', {
      name: /show design jury during agent runs/i,
    });
    expect(checkbox).toHaveProperty('checked', true);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/critique/settings'),
      expect.anything(),
    );
  });

  it('keeps the project PATCH path when toggling inside a project', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'GET' && url === '/api/projects/project-a') {
        return new Response(JSON.stringify({
          project: { metadata: { kind: 'prototype', critiqueTheaterEnabled: false } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        projectOverride: false,
        envOverride: null,
        phase: 'M0',
        skillPolicy: null,
        enabled: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    renderCritiqueSettings('project-a');
    const checkbox = await screen.findByRole('checkbox', {
      name: /show design jury during agent runs/i,
    });
    fireEvent.click(checkbox);

    await waitFor(() => {
      const patch = calls.find((call) => call.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch?.url).toBe('/api/projects/project-a');
      expect(JSON.parse(String(patch?.init?.body))).toEqual({
        metadata: { kind: 'prototype', critiqueTheaterEnabled: true },
      });
    });
  });
});
