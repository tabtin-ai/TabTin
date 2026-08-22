import type { ClipboardStoreState } from './clipboard-store-types'

export const initialClipboardStoreState = {
  items: [],
  pasteOffset: 0,
  isCutting: false,
} satisfies Pick<ClipboardStoreState, 'items' | 'pasteOffset' | 'isCutting'>
