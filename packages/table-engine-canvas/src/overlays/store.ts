/**
 * Grid View Store
 *
 * Zustand store managing overlay UI state for the canvas grid.
 */
import { create } from 'zustand'
import type { IPosition, IRectangle } from '../grid/interface'

// ---------------------------------------------------------------------------
// Menu data interfaces
// ---------------------------------------------------------------------------

export interface IHeaderMenuData {
  ownerId?: string
  /** Column field name(s) */
  fields: string[]
  /** Display names */
  fieldNames: string[]
  /** Original field types */
  fieldTypes: string[]
  /** Whether field is primary */
  isPrimary: boolean[]
  /** Whether field is editable */
  editable: boolean[]
  /** Menu position */
  position: IPosition
  /** Callback to clear selection after menu action */
  onSelectionClear?: () => void
}

export interface IRecordMenuData {
  /** Row data object */
  rowData?: Record<string, unknown>
  /** Row ID */
  rowId?: string
  /** Row index */
  rowIndex?: number
  /** Whether multiple rows are selected */
  isMultipleSelected?: boolean
  /** Menu position */
  position: IPosition
  /** Callbacks */
  deleteRecords?: () => Promise<void>
  insertRecord?: (position: 'before' | 'after', num: number) => void
  insertSubRecord?: () => Promise<void>
  duplicateRecord?: () => Promise<void>
  copyRecordUrl?: () => Promise<void>
  commentRecord?: () => void
  viewRecordHistory?: () => Promise<void>
  /** P1: 发送到对话 */
  sendToChat?: () => void
}

export interface IStatisticMenuData {
  /** Grid instance that opened the menu */
  ownerId?: string
  /** Column field name */
  field: string
  /** Column display name */
  fieldName: string
  /** Original field type */
  fieldType: string
  /** Menu position (rectangle for alignment) */
  position: IRectangle
}

export interface IDescriptionTooltipData {
  columnIndex: number
  position: IPosition
  text: string
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface IGridOverlayState {
  headerMenu?: IHeaderMenuData
  recordMenu?: IRecordMenuData
  statisticMenu?: IStatisticMenuData
  descriptionTooltip?: IDescriptionTooltipData

  openHeaderMenu: (data: IHeaderMenuData) => void
  closeHeaderMenu: () => void
  openRecordMenu: (data: IRecordMenuData) => void
  closeRecordMenu: () => void
  openStatisticMenu: (data: IStatisticMenuData) => void
  closeStatisticMenu: () => void
  openDescriptionTooltip: (data: IDescriptionTooltipData) => void
  closeDescriptionTooltip: () => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGridOverlayStore = create<IGridOverlayState>((set) => ({
  openHeaderMenu: (data) => {
    set((state) => ({
      ...state,
      headerMenu: data,
      recordMenu: undefined,
      statisticMenu: undefined,
    }))
  },
  closeHeaderMenu: () => {
    set((state) => {
      if (!state.headerMenu) return state
      return { ...state, headerMenu: undefined }
    })
  },
  openRecordMenu: (data) => {
    set((state) => ({
      ...state,
      recordMenu: data,
      headerMenu: undefined,
      statisticMenu: undefined,
    }))
  },
  closeRecordMenu: () => {
    set((state) => {
      if (!state.recordMenu) return state
      return { ...state, recordMenu: undefined }
    })
  },
  openStatisticMenu: (data) => {
    set((state) => ({
      ...state,
      statisticMenu: data,
      headerMenu: undefined,
      recordMenu: undefined,
    }))
  },
  closeStatisticMenu: () => {
    set((state) => {
      if (!state.statisticMenu) return state
      return { ...state, statisticMenu: undefined }
    })
  },
  openDescriptionTooltip: (data) => {
    set((state) => ({ ...state, descriptionTooltip: data }))
  },
  closeDescriptionTooltip: () => {
    set((state) => {
      if (!state.descriptionTooltip) return state
      return { ...state, descriptionTooltip: undefined }
    })
  },
}))
