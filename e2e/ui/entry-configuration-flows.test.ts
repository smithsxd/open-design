import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const STORAGE_KEY = 'open-design:config';

const CONNECTORS = [
  {
    id: 'github',
    name: 'GitHub',
    provider: 'composio',
    category: 'Developer tools',
    description: 'Read repository issues and pull requests.',
    status: 'available',
    auth: { provider: 'composio', configured: true },
    tools: [
      {
        name: 'list_issues',
        title: 'List issues',
        description: 'List recent issues from a repository.',
        safety: {
          sideEffect: 'read',
          approval: 'auto',
          reason: 'Read-only issue lookup.',
        },
        refreshEligible: true,
      },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    provider: 'composio',
    category: 'Communication',
    description: 'Search channels and messages.',
    status: 'connected',
    accountLabel: 'design-team',
    auth: { provider: 'composio', configured: true },
    tools: [],
  },
];

const IMAGE_TEMPLATE = {
  id: 'editorial-poster',
  surface: 'image',
  title: 'Editorial Poster',
  summary: 'A punchy launch poster for a product announcement.',
  category: 'Marketing',
  tags: ['poster', 'launch'],
  model: 'gpt-image-1',
  aspect: '4:5',
  source: {
    repo: 'open-design/test-prompts',
    license: 'MIT',
    author: 'Open Design QA',
  },
};

async function readSavedConfig(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
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
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  }, STORAGE_KEY);

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'mock',
            name: 'Mock Agent',
            bin: 'mock-agent',
            available: true,
            version: 'test',
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
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });
});

test('prompt template retry restores the body and preserves local edits', async ({ page }) => {
  let detailRequests = 0;
  await page.route('**/api/prompt-templates', async (route) => {
    await route.fulfill({ json: { promptTemplates: [IMAGE_TEMPLATE] } });
  });
  await page.route('**/api/prompt-templates/image/editorial-poster', async (route) => {
    detailRequests += 1;
    if (detailRequests === 1) {
      await route.fulfill({ status: 500, body: 'template unavailable' });
      return;
    }
    await route.fulfill({
      json: {
        promptTemplate: {
          ...IMAGE_TEMPLATE,
          prompt: 'Original poster prompt with dramatic type and product photography.',
        },
      },
    });
  });

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-tab-media').click();
  await page.getByTestId('new-project-media-surface-image').click();
  await page.getByTestId('new-project-name').fill('Prompt template retry metadata');

  await page.getByTestId('prompt-template-trigger').click();
  await page.getByTestId('prompt-template-search').fill('poster');
  await page.getByRole('option', { name: /Editorial Poster/i }).click();

  await expect(page.getByTestId('prompt-template-error')).toBeVisible();
  await page.getByTestId('prompt-template-retry').click();
  await expect(page.getByTestId('prompt-template-error')).toHaveCount(0);
  await expect(page.getByTestId('prompt-template-body')).toContainText('Original poster prompt');

  await page.getByTestId('prompt-template-body').fill('');
  await expect(page.getByTestId('prompt-template-empty-hint')).toBeVisible();
  await page.getByTestId('prompt-template-body').fill(
    'Edited QA prompt: bold poster, one hero product, crisp headline.',
  );
  await expect(page.getByTestId('prompt-template-body')).toHaveValue(
    'Edited QA prompt: bold poster, one hero product, crisp headline.',
  );
  await expect(page.getByTestId('create-project')).toBeEnabled();
});

test('live artifact empty connector CTA routes to Integrations → Connectors', async ({ page }) => {
  await routeConnectors(page, []);
  await routeComposioConfig(page, { configured: false, apiKeyTail: '' });

  await gotoEntryHome(page);
  await openNewProjectModal(page);
  await page.getByTestId('new-project-tab-live-artifact').click();
  await expect(page.getByTestId('new-project-connectors')).toBeVisible();

  // The empty CTA now opens Settings → Connectors directly. The Composio API
  // key field sits at the top of the section; the catalog (and its gate)
  // sits below it. In the latest entry shell this navigation happens by
  // switching the background view to Integrations while the modal stays open.
  await page.getByTestId('new-project-connectors-empty').click();
  await expect(page.getByTestId('entry-nav-integrations')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await expect(page.getByText('Composio API Key', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save key', exact: true })).toBeVisible();
});

test('connectors search supports empty results and keyboard-closeable details', async ({ page }) => {
  await routeConnectors(page, CONNECTORS);
  await routeComposioConfig(page, { configured: true, apiKeyTail: '1234' });
  await page.addInitScript((key) => {
    const next = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      agentId: 'mock',
      skillId: null,
      designSystemId: null,
      onboardingCompleted: true,
      agentModels: {},
      composio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
      },
    };
    window.localStorage.setItem(key, JSON.stringify(next));
  }, STORAGE_KEY);

  await gotoEntryHome(page);
  const settingsDialog = await openSettingsDialog(page);
  await settingsDialog.getByRole('button', { name: /^Connectors\b/ }).click();
  await expect(settingsDialog.getByTestId('connector-grid-wrap')).toBeVisible();

  const search = settingsDialog.getByTestId('connectors-search-input');
  await search.fill('git');
  await expect(connectorCard(settingsDialog, 'github')).toBeVisible();
  await expect(connectorCard(settingsDialog, 'slack')).toHaveCount(0);

  await search.fill('missing connector');
  await expect(settingsDialog.getByTestId('connectors-empty')).toBeVisible();
  await settingsDialog.getByTestId('connectors-search-clear').click();
  await expect(settingsDialog.getByTestId('connectors-empty')).toHaveCount(0);
  await expect(connectorCard(settingsDialog, 'github')).toBeVisible();
  await expect(connectorCard(settingsDialog, 'slack')).toBeVisible();

  await connectorCard(settingsDialog, 'github').focus();
  await connectorCard(settingsDialog, 'github').press('Enter');
  await expect(page.getByTestId('connector-drawer')).toBeVisible();
  await expect(page.getByTestId('connector-drawer')).toContainText('List issues');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('connector-drawer')).toHaveCount(0);
});

test('saving a Composio key from Settings unlocks the connectors gate immediately', async ({ page }) => {
  const { accountLabel: _unusedAccountLabel, ...slackConnector } = CONNECTORS[1]!;
  await routeConnectors(page, [
    {
      ...CONNECTORS[0]!,
      status: 'available',
      auth: { provider: 'composio', configured: false },
    },
    {
      ...slackConnector,
      status: 'available',
      auth: { provider: 'composio', configured: false },
    },
  ]);

  let savedComposioBody: unknown = null;
  await page.route('**/api/connectors/composio/config', async (route) => {
    savedComposioBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, json: { config: null } });
      return;
    }
    await route.fulfill({ status: 200, body: '{}' });
  });

  await gotoEntryHome(page);
  const settingsDialog = await openSettingsDialog(page);
  await settingsDialog.getByRole('button', { name: /^Connectors\b/ }).click();
  await expect(settingsDialog.getByTestId('connectors-search-input')).toBeDisabled();

  await settingsDialog.getByPlaceholder('Paste Composio API key').fill('cmp-secret-1234');
  await settingsDialog.getByRole('button', { name: 'Save key', exact: true }).click();

  expect(savedComposioBody).toEqual({ apiKey: 'cmp-secret-1234' });
  await expect(settingsDialog.getByTestId('connectors-search-input')).toBeEnabled();
  await expect(connectorCard(settingsDialog, 'github')).toBeVisible();

  await expect.poll(async () => readSavedConfig(page)).toMatchObject({
    composio: {
      apiKey: '',
      apiKeyConfigured: true,
      apiKeyTail: '1234',
    },
  });
  const savedConfig = await readSavedConfig(page);
  expect(savedConfig?.composio).toMatchObject({
    apiKey: '',
    apiKeyConfigured: true,
    apiKeyTail: '1234',
  });
});

test('typing a draft replacement Composio key does not trigger global autosave', async ({ page }) => {
  await routeConnectors(page, CONNECTORS);
  await routeComposioConfig(page, { configured: true, apiKeyTail: '1234' });
  await page.addInitScript((key) => {
    const next = {
      mode: 'daemon',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      agentId: 'mock',
      skillId: null,
      designSystemId: null,
      onboardingCompleted: true,
      agentModels: {},
      privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
      composio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '1234',
      },
    };
    window.localStorage.setItem(key, JSON.stringify(next));
  }, STORAGE_KEY);

  const appConfigPersistBodies: unknown[] = [];
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, json: { config: null } });
      return;
    }
    appConfigPersistBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, body: '{}' });
  });

  await gotoEntryHome(page);
  const settingsDialog = await openSettingsDialog(page);
  await settingsDialog.getByRole('button', { name: /^Connectors\b/ }).click();
  await expect(settingsDialog.getByTestId('connector-grid-wrap')).toBeVisible();
  await expect(settingsDialog.getByText('Saved · ••••1234')).toBeVisible();

  const appConfigPersistCountBeforeDraftEdit = appConfigPersistBodies.length;

  const replacementInput = settingsDialog.getByPlaceholder('Paste a new key to replace the saved one');
  await replacementInput.fill('cmp-draft-secret-9999');
  await expect(settingsDialog.getByRole('button', { name: 'Save key', exact: true })).toBeEnabled();

  await page.waitForTimeout(900);
  expect(appConfigPersistBodies).toHaveLength(appConfigPersistCountBeforeDraftEdit);
  await expect(settingsDialog.locator('.settings-autosave')).not.toContainText(/Saving|All changes saved/);
});

async function routeConnectors(page: Page, connectors: typeof CONNECTORS) {
  await page.route('**/api/connectors', async (route) => {
    await route.fulfill({ json: { connectors } });
  });
  await page.route('**/api/connectors/status', async (route) => {
    const statuses = Object.fromEntries(
      connectors.map((connector) => [
        connector.id,
        {
          status: connector.status,
          accountLabel: connector.accountLabel,
        },
      ]),
    );
    await route.fulfill({ json: { statuses } });
  });
  await page.route('**/api/connectors/discovery*', async (route) => {
    await route.fulfill({
      json: {
        connectors,
        meta: { provider: 'composio' },
      },
    });
  });
}

async function gotoEntryHome(page: Page) {
  await page.goto('/');
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Open Design' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /not now/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function openNewProjectModal(page: Page) {
  await page.getByTestId('entry-nav-new-project').click();
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
}

async function openSettingsDialog(page: Page) {
  await page.locator('.avatar-menu .settings-icon-btn').click();
  const settingsMenu = page.locator('.avatar-popover[role="menu"]');
  await expect(settingsMenu).toBeVisible();
  await settingsMenu.getByRole('button', { name: /^settings$/i }).click();
  const settingsDialog = page.getByRole('dialog');
  await expect(settingsDialog).toBeVisible();
  return settingsDialog;
}

async function routeComposioConfig(
  page: Page,
  config: { configured: boolean; apiKeyTail?: string },
) {
  await page.route('**/api/connectors/composio/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: config });
      return;
    }

    await route.fulfill({ json: { ok: true } });
  });
}

function connectorCard(scope: Page | Locator, id: string) {
  return scope.locator(`article.connector-card[data-connector-id="${id}"]`);
}
