import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';
const LOCAL_CLI_LABEL = /Local CLI|本机 CLI|本地 CLI/i;
const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定/i;

test.describe.configure({ timeout: 30_000 });

async function waitForLoadingToClear(page: Page) {
  await expect(page.getByText('Loading Open Design…')).toHaveCount(0, { timeout: 15_000 });
}

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Open Design' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /not now/i }).click();
  }
  await expect(page.getByRole('button', { name: OPEN_SETTINGS_LABEL })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'amr',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: { amr: { model: 'default', reasoning: 'default' } },
        privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);

  await page.route('https://api.github.com/repos/nexu-io/open-design', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ stargazers_count: 51600 }),
    });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'amr',
            name: 'AMR (vela)',
            bin: 'vela',
            available: true,
            version: '0.1.0',
            path: '/usr/local/bin/vela',
            models: [{ id: 'default', label: 'Default' }],
          },
          {
            id: 'codex',
            name: 'Codex CLI',
            bin: 'codex',
            available: true,
            version: '0.80.0',
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    });
  });

  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'amr',
          skillId: null,
          designSystemId: null,
          mode: 'daemon',
          agentModels: { amr: { model: 'default', reasoning: 'default' } },
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });

  await page.route('**/api/integrations/vela/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        loggedIn: true,
        profile: 'local',
        configPath: '/tmp/.amr/config.json',
        user: {
          id: 'topbar-user',
          email: 'topbar@example.com',
          name: 'Topbar User',
          plan: 'free',
        },
      }),
    });
  });
});

test('home topbar shows the new entry chips and links', async ({ page }) => {
  await gotoEntryHome(page);

  const topbar = page.locator('.entry-main__topbar');
  await expect(topbar).toBeVisible();

  const star = page.getByTestId('entry-star-badge');
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('href', 'https://github.com/nexu-io/open-design');
  await expect(star).toContainText('Star');
  await expect(star).toContainText('51.6K');

  const discord = page.getByTestId('entry-discord-badge');
  await expect(discord).toBeVisible();
  await expect(discord).toHaveAttribute('href', 'https://discord.gg/mHAjSMV6gz');
  await expect(discord).toContainText('Join Discord');

  await expect(page.getByTestId('inline-model-switcher-chip')).toBeVisible();
  await expect(page.getByTestId('entry-use-everywhere-button')).toBeVisible();
  await expect(page.getByRole('button', { name: OPEN_SETTINGS_LABEL })).toBeVisible();
});

test('home topbar execution pill reflects Local CLI AMR default and opens the switcher', async ({ page }) => {
  await gotoEntryHome(page);

  const pill = page.getByTestId('inline-model-switcher-chip');
  await expect(pill).toContainText(LOCAL_CLI_LABEL);
  await expect(pill).toContainText(/AMR/i);
  await expect(pill).toContainText(/default/i);

  await pill.click();

  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-mode-daemon')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('inline-model-switcher-agent-amr')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-agent-codex')).toBeVisible();
  await expect(popover.getByRole('radio', { name: /^AMR\s+Signed in$/i })).toBeVisible();
});
