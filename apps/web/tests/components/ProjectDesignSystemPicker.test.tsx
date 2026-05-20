// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesignSystemSummary } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  fetchDesignSystemPreview: vi.fn(),
}));

import { ProjectDesignSystemPicker } from '../../src/components/ProjectDesignSystemPicker';
import { fetchDesignSystemPreview } from '../../src/providers/registry';

const fetchDesignSystemPreviewMock = vi.mocked(fetchDesignSystemPreview);

const designSystems: DesignSystemSummary[] = [
  {
    id: 'clay',
    title: 'Clay',
    summary: 'Friendly tactile product UI.',
    category: 'Product',
    swatches: ['#f4efe7', '#25211d'],
  },
  {
    id: 'noir',
    title: 'Editorial Noir',
    summary: 'High-contrast editorial system.',
    category: 'Editorial',
    swatches: ['#111111', '#f7f0e8'],
  },
];

beforeEach(() => {
  fetchDesignSystemPreviewMock.mockResolvedValue('<html><body><h1>Preview</h1></body></html>');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectDesignSystemPicker', () => {
  it('checks the active project design system and previews it by default', async () => {
    render(
      <ProjectDesignSystemPicker
        designSystems={designSystems}
        selectedId="noir"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));

    const activeOption = await screen.findByTestId('project-ds-picker-option-noir');
    expect(activeOption.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('project-ds-picker-option-noir-check')).toBeTruthy();

    await waitFor(() => {
      expect(fetchDesignSystemPreviewMock).toHaveBeenCalledWith('noir');
    });
    expect(await screen.findByTestId('project-ds-picker-preview-frame')).toBeTruthy();
  });

  it('updates the preview target on hover and opens the fullscreen preview', async () => {
    render(
      <ProjectDesignSystemPicker
        designSystems={designSystems}
        selectedId="noir"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('project-ds-picker-trigger'));
    await screen.findByTestId('project-ds-picker-preview-frame');

    fireEvent.mouseEnter(screen.getByTestId('project-ds-picker-option-clay'));
    await waitFor(() => {
      expect(fetchDesignSystemPreviewMock).toHaveBeenCalledWith('clay');
    });

    fireEvent.click(await screen.findByTestId('project-ds-picker-preview-expand'));
    expect(screen.getByRole('dialog', { name: 'Clay 全屏预览' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('关闭全屏预览'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
