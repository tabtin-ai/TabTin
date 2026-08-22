import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  writePageContentToClipboard,
  type PageContentClipboard,
} from './page-content-clipboard';

const originalClipboardItem = globalThis.ClipboardItem;

class TestClipboardItem {
  readonly types: string[];

  constructor(private readonly data: Record<string, Blob>) {
    this.types = Object.keys(data);
  }

  async getType(type: string): Promise<Blob> {
    const blob = this.data[type];
    if (!blob) throw new Error(`Missing clipboard type: ${type}`);
    return blob;
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: originalClipboardItem,
  });
  vi.restoreAllMocks();
});

describe('writePageContentToClipboard', () => {
  it('copies semantic HTML for rich-text targets and Markdown for plain-text targets', async () => {
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    });
    const write = vi
      .fn<(items: ClipboardItem[]) => Promise<void>>()
      .mockResolvedValue();
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue();
    const clipboard: PageContentClipboard = { write, writeText };

    await writePageContentToClipboard(
      {
        pmJson: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: '进展' }],
            },
            {
              type: 'taskList',
              content: [
                {
                  type: 'taskItem',
                  attrs: { checked: true },
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: '完成复制' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'blockquote',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: '保留结构' }],
                },
              ],
            },
          ],
        },
        markdown: '## 进展\n\n- [x] 完成复制\n\n> 保留结构',
      },
      clipboard,
    );

    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    const [item] = write.mock.calls[0][0];
    expect(item.types).toEqual(
      expect.arrayContaining(['text/html', 'text/plain']),
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      '<h2>进展</h2>',
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      'data-type="taskList"',
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      'data-type="taskItem"',
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      'data-checked="true"',
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      'type="checkbox" checked',
    );
    await expect((await item.getType('text/html')).text()).resolves.toContain(
      '<blockquote>',
    );
    await expect((await item.getType('text/plain')).text()).resolves.toBe(
      '## 进展\n\n- [x] 完成复制\n\n> 保留结构',
    );
  });

  it('falls back to Markdown when the rich clipboard write is rejected', async () => {
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    });
    const write = vi
      .fn<(items: ClipboardItem[]) => Promise<void>>()
      .mockRejectedValue(
        new DOMException('HTML clipboard is unavailable', 'NotAllowedError'),
      );
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      writePageContentToClipboard(
        {
          pmJson: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { level: 1 },
                content: [{ type: 'text', text: '标题' }],
              },
            ],
          },
          markdown: '# 标题',
        },
        { write, writeText },
      ),
    ).resolves.toBeUndefined();

    expect(write).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('# 标题');
  });
});
