// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  fetchLiveArtifacts,
  fetchPreviewComments,
  fetchProjectFiles,
} from '../../src/providers/registry';

const theaterHarness = vi.hoisted(() => ({
  resolvedEnabled: false,
}));

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn().mockResolvedValue([]),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  const conversation: Conversation = {
    id: 'conv-1',
    projectId: 'project-1',
    title: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    ...actual,
    createConversation: vi.fn().mockResolvedValue(conversation),
    deleteConversation: vi.fn(),
    getTemplate: vi.fn().mockResolvedValue(null),
    listConversations: vi.fn().mockResolvedValue([conversation]),
    listMessages: vi.fn().mockResolvedValue([]),
    loadTabs: vi.fn().mockResolvedValue({ tabs: [], active: null }),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/Theater', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/Theater')>(
    '../../src/components/Theater',
  );
  return {
    ...actual,
    CritiqueTheaterMount: ({ enabled }: { enabled: boolean }) => (
      enabled ? <div data-testid="critique-theater-mount" /> : null
    ),
    useResolvedCritiqueTheaterEnabled: vi.fn(() => theaterHarness.resolvedEnabled),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  FileWorkspace: () => <div data-testid="file-workspace" />,
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}));

const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedFetchLiveArtifacts = vi.mocked(fetchLiveArtifacts);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);

const config: AppConfig = {
  mode: 'api',
  apiProtocol: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  model: 'model',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

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

function renderProjectView() {
  return render(
    <ProjectView
      project={project}
      routeFileName={null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={[] as DesignSystemSummary[]}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
    />,
  );
}

describe('ProjectView Critique Theater resolved mount gating', () => {
  beforeEach(() => {
    ensureLocalStorage();
    window.localStorage.setItem(
      'open-design:config',
      JSON.stringify({ critiqueTheaterEnabled: false }),
    );
    theaterHarness.resolvedEnabled = false;
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchLiveArtifacts.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    ensureLocalStorage();
    window.localStorage.clear();
  });

  it('mounts Theater when daemon-resolved critique is enabled even if localStorage is false', async () => {
    theaterHarness.resolvedEnabled = true;

    renderProjectView();

    await waitFor(() => {
      expect(screen.getByTestId('critique-theater-mount')).toBeTruthy();
    });
  });

  it('keeps Theater disabled when the project resolved setting is disabled', async () => {
    renderProjectView();

    expect(screen.queryByTestId('critique-theater-mount')).toBeNull();
  });
});
