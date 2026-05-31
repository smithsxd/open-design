// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockOpenDesignHost } from '@open-design/host/testing';

import { DesignBrowserPanel } from '../../src/components/DesignBrowserPanel';

// The panel imports these writers from the registry at module load; stub them so
// rendering never reaches the network.
vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    openExternalUrl: vi.fn(async () => true),
    writeProjectTextFile: vi.fn(async () => null),
    writeProjectBase64File: vi.fn(async () => null),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let restoreHost: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  // Makes isOpenDesignHostAvailable() true so the panel renders the desktop
  // <webview> branch (rather than the iframe fallback).
  restoreHost = installMockOpenDesignHost();
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = null;
  window.localStorage.clear();
});

function dispatchWebviewNavigate(webview: HTMLElement, url: string) {
  act(() => {
    const event = new Event('did-navigate') as Event & { url?: string; isMainFrame?: boolean };
    event.url = url;
    event.isMainFrame = true;
    webview.dispatchEvent(event);
  });
}

describe('DesignBrowserPanel <webview> navigation', () => {
  it('pins the webview src to the load target when the guest commits a redirected URL', () => {
    // Regression guard for the blank-page bug: the embedded <webview> rendered
    // but never painted because did-navigate fed the committed (trailing-slash)
    // URL straight back into the src prop, so Electron re-navigated and aborted
    // the in-flight load (ERR_ABORTED -3). The load target (src) must stay put
    // while only the address bar follows the committed URL.
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement | null;
    expect(webview).not.toBeNull();
    // The bare domain is normalized to https and becomes the load target.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
    expect(input.value).toBe('https://example.com');

    // The guest commits a redirect that appends a trailing slash.
    dispatchWebviewNavigate(webview!, 'https://example.com/');

    // The address bar follows the committed URL...
    expect(input.value).toBe('https://example.com/');
    // ...but the src remains the original target, so no abort/reload loop.
    expect(webview!.getAttribute('src')).toBe('https://example.com');
  });

  it('changes the src only when the user navigates to a new target', () => {
    const { container } = render(
      <DesignBrowserPanel projectId="proj-webview-2" onOpenFile={() => {}} onRefreshFiles={() => {}} />,
    );

    const input = screen.getByLabelText('Browser address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://gsap.com' } });
    fireEvent.submit(input.closest('form')!);

    const webview = container.querySelector('webview.db-webview') as HTMLElement;
    expect(webview.getAttribute('src')).toBe('https://gsap.com');

    // An in-page navigation event must not move the load target.
    dispatchWebviewNavigate(webview, 'https://gsap.com/docs/');
    expect(webview.getAttribute('src')).toBe('https://gsap.com');
    expect(input.value).toBe('https://gsap.com/docs/');

    // A fresh user navigation does move it.
    fireEvent.change(input, { target: { value: 'unsplash.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(webview.getAttribute('src')).toBe('https://unsplash.com');
  });
});
