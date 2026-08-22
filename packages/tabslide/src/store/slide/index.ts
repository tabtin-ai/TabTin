import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { initialSlideStoreState } from './initial-state'
import { flattenActions } from './flatten-actions'
import { createAnimationSlice } from './slices/animation/action'
import { createEditorSlice } from './slices/editor/action'
import { createElementSlice } from './slices/element/action'
import { createLayerSlice } from './slices/layer/action'
import { createPageSlice } from './slices/page/action'
import { createProjectSlice } from './slices/project/action'
import { createSelectionSlice } from './slices/selection/action'
import type { SlideStoreState } from './slide-store-types'

export type {
  ProjectSaveEntry,
  SaveStatusType,
  SlideStoreGet,
  SlideStoreSet,
  SlideStoreState,
} from './slide-store-types'
export { resolveMovableLayerIds } from './layer-operations'

const createSlideStore: StateCreator<SlideStoreState> = (...params) => ({
  ...initialSlideStoreState,
  ...flattenActions<SlideStoreState>([
    createProjectSlice(...params),
    createPageSlice(...params),
    createSelectionSlice(...params),
    createElementSlice(...params),
    createLayerSlice(...params),
    createAnimationSlice(...params),
    createEditorSlice(...params),
  ]),
})

export const useSlideStore = create<SlideStoreState>(createSlideStore)
