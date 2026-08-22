import { DEFAULT_EDITOR_CONFIG } from '../../types/slides'
import type { SlideStoreState } from './slide-store-types'

export const initialSlideStoreState = {
  presentation: null,
  currentPageIndex: 0,
  selectedElementIds: [],
  zoom: 1,
  panX: 0,
  panY: 0,
  isEditing: false,
  editingElementId: null,
  isDirty: false,
  saveStatus: 'idle',
  saveError: null,
  editorConfig: { ...DEFAULT_EDITOR_CONFIG },
  _projectSaveState: {},
  pageClipboard: null,
  version: 0,
} satisfies Pick<
  SlideStoreState,
  | 'presentation'
  | 'currentPageIndex'
  | 'selectedElementIds'
  | 'zoom'
  | 'panX'
  | 'panY'
  | 'isEditing'
  | 'editingElementId'
  | 'isDirty'
  | 'saveStatus'
  | 'saveError'
  | 'editorConfig'
  | '_projectSaveState'
  | 'pageClipboard'
  | 'version'
>
