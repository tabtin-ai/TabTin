import { produce } from 'immer'
import { applySaveState } from '../../store-helpers'
import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

export type AnimationAction = Pick<
  SlideStoreState,
  'addAnimation' | 'updateAnimation' | 'removeAnimation' | 'reorderAnimations'
>

export const createAnimationSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): AnimationAction => new AnimationActionImpl(set, get, _api)

export class AnimationActionImpl {
  readonly #set: SlideStoreSet

  constructor(set: SlideStoreSet, _get: SlideStoreGet, _api?: unknown) {
    void _get
    void _api
    this.#set = set
  }

  addAnimation: SlideStoreState['addAnimation'] = (anim) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        if (!page.animations) page.animations = []
        page.animations.push(anim)
        applySaveState(s, 'unsaved')
      }),
    )

  updateAnimation: SlideStoreState['updateAnimation'] = (animId, updates) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page?.animations) return
        const anim = page.animations.find((a) => a.id === animId)
        if (anim) Object.assign(anim, updates)
        applySaveState(s, 'unsaved')
      }),
    )

  removeAnimation: SlideStoreState['removeAnimation'] = (animId) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page?.animations) return
        page.animations = page.animations.filter((a) => a.id !== animId)
        applySaveState(s, 'unsaved')
      }),
    )

  // E1-08: 修复正向移动时 insertAt = to - 1 的 off-by-one 错误。
  // splice(from, 1) 移除元素后，目标位置 `to` 即为新数组中的正确插入索引。
  reorderAnimations: SlideStoreState['reorderAnimations'] = (from, to) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page?.animations) return
        const arr = page.animations
        if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return
        if (from === to) return
        const [item] = arr.splice(from, 1)
        const insertIdx = from < to ? to - 1 : to
        arr.splice(insertIdx, 0, item)
        applySaveState(s, 'unsaved')
      }),
    )
}
