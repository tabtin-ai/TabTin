import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

import { BrowserToolbarWideActions } from '../BrowserToolbarWideActions';

const defaultProps = {
  viewId: 'view-1',
  browserAnnotationPicking: false,
  browserScreenshotPicking: false,
  currentUrlForBookmark: 'https://example.com',
  isCurrentBookmarked: false,
  onToggleAnnotation: vi.fn(),
  onCaptureScreenshot: vi.fn(),
  onToggleBookmark: vi.fn(),
};

describe('BrowserToolbarWideActions', () => {
  it('explains non-zoom actions on hover', async () => {
    render(<BrowserToolbarWideActions {...defaultProps} />);

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /选择页面元素添加到对话|网页注释/i }),
      { pointerType: 'mouse' },
    );
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '网页注释｜选择页面内容添加到对话',
      );
    });

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /截取当前网页可视区域|截图到对话/i }),
      { pointerType: 'mouse' },
    );
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '截图到对话｜截取当前网页可视区域添加到对话',
      );
    });

    fireEvent.pointerMove(screen.getByRole('button', { name: /收藏/i }), {
      pointerType: 'mouse',
    });
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '收藏当前网页｜稍后可从浏览器收藏中打开',
      );
    });
  });

  it('explains the remove action for a bookmarked page', async () => {
    render(<BrowserToolbarWideActions {...defaultProps} isCurrentBookmarked />);

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /取消收藏|remove bookmark/i }),
      { pointerType: 'mouse' },
    );
    await waitFor(() => {
      expect(screen.getByRole('tooltip').textContent).toBe(
        '取消收藏｜从浏览器收藏中移除当前网页',
      );
    });
  });

  it('does not add product tooltips to zoom controls', async () => {
    render(<BrowserToolbarWideActions {...defaultProps} />);

    fireEvent.pointerMove(
      screen.getByRole('button', { name: /缩小网页|zoom out/i }),
      { pointerType: 'mouse' },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
