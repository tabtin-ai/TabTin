export const TABLE_RICH_TEXT_COMMAND_EVENT = 'tabslide:table-richtext-command'
export const TABLE_RICH_TEXT_SELECTION_EVENT = 'tabslide:table-richtext-selection-change'

export type TableRichTextAlign = 'left' | 'center' | 'right' | 'justify'

export type TableRichTextCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'unorderedList'
  | 'orderedList'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignJustify'
  | 'fontColor'
  | 'fontSize'
  | 'fontFamily'
  | 'createLink'
  | 'removeLink'
  | 'removeFormat'
  | 'cellBgColor'
  | 'cellVerticalAlign'

export interface TableRichTextCommandEventDetail {
  elementId: string
  command: TableRichTextCommand
  value?: string
}

export interface TableRichTextSelectionState {
  bold: boolean
  italic: boolean
  underline: boolean
  align: TableRichTextAlign
  color?: string
  fontSizePt?: number
  fontFamily?: string
  link?: string
  cellBgColor?: string
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

export interface TableRichTextSelectionEventDetail {
  elementId: string
  state: TableRichTextSelectionState
}

export const DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE: TableRichTextSelectionState = {
  bold: false,
  italic: false,
  underline: false,
  align: 'left',
}

export function emitTableRichTextCommand(detail: TableRichTextCommandEventDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TableRichTextCommandEventDetail>(TABLE_RICH_TEXT_COMMAND_EVENT, { detail }))
}

export function emitTableRichTextSelection(detail: TableRichTextSelectionEventDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TableRichTextSelectionEventDetail>(TABLE_RICH_TEXT_SELECTION_EVENT, { detail }))
}
