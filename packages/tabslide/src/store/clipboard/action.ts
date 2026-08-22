import type {
  ClipboardStoreGet,
  ClipboardStoreSet,
  ClipboardStoreState,
} from './clipboard-store-types'

export type ClipboardAction = Pick<
  ClipboardStoreState,
  'setItems' | 'incrementPasteOffset' | 'resetPasteOffset' | 'setNotCutting' | 'clear'
>

export const createClipboardSlice = (
  set: ClipboardStoreSet,
  get: ClipboardStoreGet,
  _api?: unknown,
): ClipboardAction => new ClipboardActionImpl(set, get, _api)

export class ClipboardActionImpl {
  readonly #set: ClipboardStoreSet

  constructor(set: ClipboardStoreSet, _get: ClipboardStoreGet, _api?: unknown) {
    void _get
    void _api
    this.#set = set
  }

  setItems: ClipboardStoreState['setItems'] = (items, cutting = false) =>
    this.#set({ items, pasteOffset: 0, isCutting: cutting })

  incrementPasteOffset: ClipboardStoreState['incrementPasteOffset'] = (amount) =>
    this.#set((s) => ({ pasteOffset: s.pasteOffset + amount }))

  resetPasteOffset = () => this.#set({ pasteOffset: 0 })

  setNotCutting = () => this.#set({ isCutting: false })

  clear = () => this.#set({ items: [], pasteOffset: 0, isCutting: false })
}
