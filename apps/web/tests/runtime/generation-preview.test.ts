import { describe, expect, it } from 'vitest';
import {
  buildGenerationPreviewState,
  derivePrototypeGenerationSteps,
  formatGenerationElapsed,
  workspaceHasPreviewSurface,
} from '../../src/runtime/generation-preview';
import type { AgentEvent, ChatMessage } from '../../src/types';

describe('generation preview helpers', () => {
  it('detects when the workspace already has a preview surface', () => {
    expect(
      workspaceHasPreviewSurface({
        activeTab: 'index.html',
        projectFiles: [{ name: 'index.html', size: 1, mtime: 1, kind: 'html', mime: 'text/html' }],
        liveArtifacts: [],
      }),
    ).toBe(true);
    expect(
      workspaceHasPreviewSurface({
        activeTab: null,
        projectFiles: [],
        liveArtifacts: [],
        streamingArtifactHtml: '<html><body>hi</body></html>',
      }),
    ).toBe(true);
  });

  it('advances the three prototype steps from streamed events', () => {
    const events: AgentEvent[] = [
      { kind: 'status', label: 'thinking' },
      { kind: 'text', text: 'Planning the page.' },
      { kind: 'tool_use', id: '1', name: 'Write', input: { file_path: 'index.html' } },
    ];
    expect(
      derivePrototypeGenerationSteps({
        events,
        hasArtifactHtml: false,
        hasPreviewSurface: false,
        failed: false,
      }),
    ).toEqual([
      { id: 'understand', status: 'succeeded' },
      { id: 'generate', status: 'succeeded' },
      { id: 'prepare', status: 'running' },
    ]);
  });

  it('builds preview state for an active assistant run without an open preview tab', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      startedAt: Date.now() - 5_000,
      events: [{ kind: 'status', label: 'thinking' }],
    };
    const state = buildGenerationPreviewState({
      designSystemProject: false,
      messages: [{ id: 'u1', role: 'user', content: 'Build a landing page' }, assistant],
      streaming: true,
      activeTab: null,
      projectFiles: [],
      liveArtifacts: [],
    });
    expect(state).not.toBeNull();
    expect(state?.steps[0]?.status).toBe('running');
    expect(state?.retryTarget).toBeNull();
  });

  it('hides preview state once a preview tab is active', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      startedAt: Date.now(),
      events: [{ kind: 'tool_use', id: '1', name: 'Write', input: {} }],
    };
    expect(
      buildGenerationPreviewState({
        designSystemProject: false,
        messages: [assistant],
        streaming: true,
        activeTab: 'index.html',
        projectFiles: [{ name: 'index.html', size: 1, mtime: 1, kind: 'html', mime: 'text/html' }],
        liveArtifacts: [],
      }),
    ).toBeNull();
  });

  it('formats elapsed durations for the meta row', () => {
    expect(formatGenerationElapsed(42)).toBe('42s');
    expect(formatGenerationElapsed(125)).toBe('2m 5s');
  });
});
