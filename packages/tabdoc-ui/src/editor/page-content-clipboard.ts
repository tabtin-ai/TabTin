import { pmJsonToHtml } from '@tabtin/doc-editor';

export interface PageContentClipboard {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText: (text: string) => Promise<void>;
}

export interface PageContentClipboardPayload {
  pmJson: Record<string, unknown>;
  markdown: string;
}

export async function writePageContentToClipboard(
  payload: PageContentClipboardPayload,
  clipboard: PageContentClipboard = navigator.clipboard,
): Promise<void> {
  if (
    typeof ClipboardItem !== 'undefined' &&
    typeof clipboard.write === 'function'
  ) {
    try {
      const html = pmJsonToHtml(payload.pmJson);
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([payload.markdown], { type: 'text/plain' }),
      });
      await clipboard.write([item]);
      return;
    } catch {
      // Some Chromium/platform combinations expose write() but reject HTML payloads.
      // Keep copying useful by falling back to the Markdown representation below.
    }
  }

  await clipboard.writeText(payload.markdown);
}
