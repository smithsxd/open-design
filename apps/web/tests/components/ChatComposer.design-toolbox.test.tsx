// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { composerText, flushMounts } from '../helpers/lexical-composer';

const DESIGN_TASTE_SKILL = {
  id: 'design-taste-frontend',
  name: 'design-taste-frontend',
  description: 'Anti-slop frontend polish for non-generic web design.',
  triggers: ['design taste', 'anti slop frontend', '反 AI 味'],
  mode: 'prototype' as const,
  surface: 'web' as const,
  category: 'creative-direction',
  previewType: 'html',
  designSystemRequired: true,
  defaultFor: [],
  upstream: 'https://github.com/Leonxlnx/taste-skill',
  hasBody: true,
  examplePrompt: 'Polish the current page.',
  aggregatesExamples: false,
};

const GSAP_SKILL = {
  ...DESIGN_TASTE_SKILL,
  id: 'gsap-core',
  name: 'gsap-core',
  description: 'Core GSAP animation primitives.',
  triggers: ['gsap', 'animation'],
  category: 'animation-motion',
  upstream: 'https://github.com/greensock/gsap-skills',
};

let fetchMock: ReturnType<typeof vi.fn>;

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
) {
  return render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[
        {
          name: 'index.html',
          path: 'index.html',
          type: 'file',
          size: 1024,
          mtime: 0,
          kind: 'html',
          mime: 'text/html',
        },
      ]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onOpenMcpSettings={vi.fn()}
      skills={[DESIGN_TASTE_SKILL, GSAP_SKILL]}
      activeWorkspaceContext={{
        id: 'file:index.html',
        kind: 'file',
        label: 'index.html',
        path: 'index.html',
      }}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/mcp/servers') {
      return new Response(JSON.stringify({ servers: [], templates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/connectors') {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('ChatComposer design toolbox', () => {
  it('stages a one-turn follow-up skill without patching the project skill', async () => {
    const onSend = vi.fn();
    renderComposer({ onSend });
    await flushMounts();

    const trigger = screen.getByLabelText('打开设计百宝箱');
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByText('设计百宝箱')).toBeTruthy());
    fireEvent.click(screen.getByText('反 AI 味美化'));

    await waitFor(() => {
      expect(composerText()).toContain('@design-taste-frontend');
      expect(composerText()).toContain('反 AI 味美化');
    });

    fireEvent.click(screen.getByTestId('chat-send'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[3]?.skillIds).toEqual(['design-taste-frontend']);
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/projects/project-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
