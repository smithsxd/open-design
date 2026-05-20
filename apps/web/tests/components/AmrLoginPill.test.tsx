// @vitest-environment jsdom

/**
 * Coverage for the AMR Settings login pill. The pill is a sibling of the
 * Test button inside the installed-agent card and intentionally stops
 * click/key event propagation so a Sign-in / Sign-out click does NOT
 * also re-select the agent card.
 *
 * The component polls `/api/integrations/vela/status` to keep up with
 * subprocess-driven login completion — vela CLI owns the
 * device-authorization UX, so we just kick `vela login` off and wait.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmrLoginPill } from '../../src/components/AmrLoginPill';
import { I18nProvider } from '../../src/i18n';

interface StubbedResponse {
  status?: number;
  body: unknown;
}

function jsonResponse({ status = 200, body }: StubbedResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

function renderPill() {
  return render(
    <I18nProvider initial="en">
      <AmrLoginPill />
    </I18nProvider>,
  );
}

describe('AmrLoginPill', () => {
  it('renders a Sign-in button when /status reports loggedIn=false', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    renderPill();

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('renders a "Signed in" pill (with the Sign-out aria-label) when /status reports a logged-in user', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        body: {
          loggedIn: true,
          profile: 'local',
          configPath: '/x',
          user: { id: 'u', email: 'leaf@example.com', plan: 'free' },
        },
      }),
    ) as typeof fetch;

    renderPill();

    // The visible label is "Signed in"; the button is identified by its
    // aria-label (Sign out) so logout-by-keyboard / screen reader users can
    // act on it without hovering for the alternate label.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    });
    expect(screen.getByText('Signed in')).toBeTruthy();
  });

  it('stops click propagation so the Sign-in button never bubbles up to the agent-card-select sibling', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      if (
        url.endsWith('/api/integrations/vela/login') &&
        init?.method === 'POST'
      ) {
        return jsonResponse({ status: 202, body: { pid: 4242 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const cardSelect = vi.fn();
    // Mimics the SettingsDialog layout: an outer card whose select button
    // captures clicks; the pill is a sibling and must not let its own click
    // reach this handler.
    render(
      <I18nProvider initial="en">
        <div
          role="group"
          onClick={cardSelect}
          onKeyDown={cardSelect}
        >
          <AmrLoginPill />
        </div>
      </I18nProvider>,
    );

    const signInBtn = await screen.findByRole('button', { name: 'Sign in' });
    fireEvent.click(signInBtn);
    expect(cardSelect).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/api/integrations/vela/login') &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
  });

  it('logout POSTs /logout and flips the pill back to Sign-in', async () => {
    let loggedIn = true;
    const fetchMock = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/api/integrations/vela/status')) {
        return jsonResponse({
          body: loggedIn
            ? {
                loggedIn: true,
                profile: 'local',
                configPath: '/x',
                user: { id: 'u', email: 'leaf@example.com', plan: 'free' },
              }
            : { loggedIn: false, profile: 'local', user: null, configPath: '/x' },
        });
      }
      if (
        url.endsWith('/api/integrations/vela/logout') &&
        init?.method === 'POST'
      ) {
        loggedIn = false;
        return jsonResponse({ body: { ok: true } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    renderPill();
    const logoutBtn = await screen.findByRole('button', { name: 'Sign out' });
    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    });
  });
});
