import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { gotoEntryHome, seedBrowserConfig } from '../lib/playwright/amr.js';

test.describe.configure({ timeout: 30_000 });

const HOME_CONFIG = {
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
};

const HOME_PLUGINS = [
  {
    id: 'example-web-prototype',
    title: 'Web Prototype',
    version: '0.1.0',
    trust: 'bundled',
    sourceKind: 'bundled',
    source: '/tmp/web-prototype',
    fsPath: '/tmp/web-prototype',
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: 'example-web-prototype',
      title: 'Web Prototype',
      version: '0.1.0',
      description: 'General-purpose desktop web prototype.',
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        useCase: {
          query:
            'Build a {{fidelity}} {{artifactKind}} for {{audience}} using {{designSystem}} from {{template}}.',
        },
        inputs: [
          { name: 'artifactKind', type: 'string', required: true, default: 'web prototype', label: 'Artifact kind' },
          { name: 'fidelity', type: 'select', required: true, options: ['wireframe', 'high-fidelity'], default: 'high-fidelity', label: 'Fidelity' },
          { name: 'audience', type: 'string', required: true, default: 'product evaluators', label: 'Audience' },
          { name: 'designSystem', type: 'string', default: 'the active project design system', label: 'Design system' },
          { name: 'template', type: 'string', default: 'the bundled web prototype seed', label: 'Template' },
        ],
      },
    },
  },
  {
    id: 'example-simple-deck',
    title: 'Simple Deck',
    version: '0.1.0',
    trust: 'bundled',
    sourceKind: 'bundled',
    source: '/tmp/simple-deck',
    fsPath: '/tmp/simple-deck',
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: 'example-simple-deck',
      title: 'Simple Deck',
      version: '0.1.0',
      description: 'Single-file horizontal-swipe HTML deck.',
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        useCase: {
          query:
            'Create a {{deckType}} for {{audience}} about {{topic}} with {{slideCount}}. Speaker notes: {{speakerNotes}}. Use {{designSystem}}.',
        },
        inputs: [
          { name: 'deckType', type: 'select', required: true, options: ['pitch deck', 'product overview', 'study deck'], default: 'pitch deck', label: 'Deck type' },
          { name: 'topic', type: 'string', required: true, default: 'quarterly review', label: 'Topic' },
          { name: 'audience', type: 'string', required: true, default: 'decision makers', label: 'Audience' },
          { name: 'slideCount', type: 'select', required: true, options: ['5-10 pages', '10-15 pages', '15-20 pages'], default: '10-15 pages', label: 'Pages' },
          { name: 'speakerNotes', type: 'select', options: ['include speaker notes', 'no speaker notes'], default: 'include speaker notes', label: 'Speaker notes' },
          { name: 'designSystem', type: 'string', default: 'the active project design system', label: 'Design system' },
        ],
      },
    },
  },
  {
    id: 'example-live-artifact',
    title: 'Live Artifact',
    version: '0.1.0',
    trust: 'bundled',
    sourceKind: 'bundled',
    source: '/tmp/live-artifact',
    fsPath: '/tmp/live-artifact',
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: 'example-live-artifact',
      title: 'Live Artifact',
      version: '0.1.0',
      description: 'Create refreshable, auditable Open Design artifacts.',
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        mode: 'prototype',
        scenario: 'live',
        useCase: {
          query:
            'Create refreshable, auditable Open Design artifacts backed by connector or local data.',
        },
      },
    },
  },
  {
    id: 'image-template-notion-team-dashboard-live-artifact',
    title: 'Notion live artifact',
    version: '0.1.0',
    trust: 'bundled',
    sourceKind: 'bundled',
    source: '/tmp/notion-live-artifact',
    fsPath: '/tmp/notion-live-artifact',
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: 'image-template-notion-team-dashboard-live-artifact',
      title: 'Notion live artifact',
      version: '0.1.0',
      description: 'Create a live Notion dashboard artifact.',
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        mode: 'image',
        surface: 'image',
        useCase: {
          query: 'Create a refreshable Notion dashboard live artifact.',
        },
      },
    },
  },
];

const APPLY_RESPONSES: Record<string, unknown> = {
  'example-simple-deck': {
    query: 'Draft a quarterly review deck.',
    contextItems: [],
    inputs: [],
    assets: [],
    mcpServers: [],
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    appliedPlugin: {
      snapshotId: 'snap-simple-deck',
      pluginId: 'example-simple-deck',
      pluginVersion: '0.1.0',
      manifestSourceDigest: 'b'.repeat(64),
      inputs: { topic: 'quarterly review' },
      resolvedContext: { items: [] },
      capabilitiesGranted: ['prompt:inject'],
      capabilitiesRequired: ['prompt:inject'],
      assetsStaged: [],
      taskKind: 'new-generation',
      appliedAt: 0,
      connectorsRequired: [],
      connectorsResolved: [],
      mcpServers: [],
      status: 'fresh',
    },
    projectMetadata: {},
  },
};
test.beforeEach(async ({ page }) => {
  await seedBrowserConfig(page, HOME_CONFIG);

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
        config: HOME_CONFIG,
      },
    });
  });

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    await route.continue();
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
          id: 'hero-user',
          email: 'hero@example.com',
          name: 'Hero User',
          plan: 'free',
        },
      }),
    });
  });

  await page.route('**/api/plugins', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ plugins: HOME_PLUGINS }),
    });
  });

  await page.route('**/api/plugins/*/apply', async (route) => {
    const pluginId = route.request().url().split('/api/plugins/')[1]?.split('/apply')[0];
    const body = pluginId ? APPLY_RESPONSES[pluginId] : null;
    await route.fulfill({
      status: body ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: 'Unknown plugin apply route' }),
    });
  });
});

test('home hero rail shows the current creation chips and More shortcuts', async ({ page }) => {
  await gotoEntryHome(page);

  await expect(page.getByTestId('home-hero-type-tabs')).toBeVisible();
  for (const id of ['prototype', 'live-artifact', 'deck', 'image', 'video', 'hyperframes', 'audio']) {
    await expect(page.getByTestId(`home-hero-rail-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId('home-hero-shortcuts-trigger')).toBeVisible();

  await page.getByTestId('home-hero-shortcuts-trigger').click();
  const menu = page.getByTestId('home-hero-shortcuts-menu');
  await expect(menu).toBeVisible();
  for (const id of ['create-plugin', 'figma', 'template']) {
    await expect(menu.getByTestId(`home-hero-rail-${id}`)).toBeVisible();
  }
});

test('home hero rail switches modes and updates the footer options for media surfaces', async ({ page }) => {
  await gotoEntryHome(page);

  await expect(page.getByTestId('home-hero-active-type-chip')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-footer-option-duration')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-footer-option-audioType')).toHaveCount(0);

  await expectChipSelection(page, 'prototype', 'Prototype');
  await expect(page.getByTestId('home-hero-footer-option-designSystem')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-footer-option-audioType')).toHaveCount(0);
  await clearActiveChip(page);

  await expectChipSelection(page, 'live-artifact', 'Live artifact');
  await expect(page.getByTestId('home-hero-footer-option-duration')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-footer-option-audioType')).toHaveCount(0);
  await clearActiveChip(page);

  await expectChipSelection(page, 'deck', 'Slide deck');
  await expect(page.getByTestId('home-hero-footer-option-designSystem')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-footer-option-audioType')).toHaveCount(0);
  await clearActiveChip(page);

  await expectChipSelection(page, 'image', 'Image');
  await expect(page.getByTestId('home-hero-footer-option-model')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-designSystem')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-ratio')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-resolution')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toHaveCount(0);
  await clearActiveChip(page);

  await expectChipSelection(page, 'video', 'Video');
  await expect(page.getByTestId('home-hero-footer-option-model')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-designSystem')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-ratio')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-resolution')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toBeVisible();
  await clearActiveChip(page);

  await expectChipSelection(page, 'hyperframes', 'HyperFrames');
  await expect(page.getByTestId('home-hero-footer-option-ratio')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-model')).toHaveCount(0);
  await clearActiveChip(page);

  await expectChipSelection(page, 'audio', 'Audio');
  await expect(page.getByTestId('home-hero-footer-option-audioType')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-model')).toBeVisible();
  await expect(page.getByTestId('home-hero-footer-option-duration')).toBeVisible();
});

test('home hero example presets update the composer input for supported modes', async ({ page }) => {
  await gotoEntryHome(page);

  const input = page.getByTestId('chat-composer-input');
  await expect(input).toHaveValue('');

  await page.getByTestId('home-hero-rail-prototype').click();
  await expect(page.getByTestId('home-hero-plugin-presets')).toBeVisible();
  await page.getByTestId('home-hero-plugin-preset').first().click();
  await expect(input).toHaveValue(
    'Build a high-fidelity web prototype for product evaluators using the active project design system from the bundled web prototype seed.',
  );

  await clearActiveChip(page);
  await page.getByTestId('home-hero-rail-live-artifact').click();
  await expect(page.getByTestId('home-hero-plugin-presets')).toBeVisible();
  await page
    .locator('[data-testid="home-hero-plugin-preset"][data-plugin-id="image-template-notion-team-dashboard-live-artifact"]')
    .click();
  await expect(input).toHaveValue('Create a refreshable Notion dashboard live artifact.');

  await clearActiveChip(page);
  await page.getByTestId('home-hero-rail-deck').click();
  await expect(page.getByTestId('home-hero-plugin-presets')).toBeVisible();
  await page.getByTestId('home-hero-plugin-preset').first().click();
  await expect(input).toHaveValue('Draft a quarterly review deck.');
});

async function expectChipSelection(page: Page, chipId: string, label: string) {
  await page.getByTestId(`home-hero-rail-${chipId}`).click();
  const activeChip = page.getByTestId('home-hero-active-type-chip');
  await expect(activeChip).toBeVisible();
  await expect(activeChip).toHaveAttribute('data-chip-id', chipId);
  await expect(activeChip).toContainText(label);
  await expect(page.getByTestId('home-hero-type-tabs')).toHaveCount(0);
}

async function clearActiveChip(page: Page) {
  await page.getByTestId('home-hero-active-type-chip').click();
  await expect(page.getByTestId('home-hero-active-type-chip')).toHaveCount(0);
  await expect(page.getByTestId('home-hero-type-tabs')).toBeVisible();
}
