import { useSlideStore } from '../store/slide'

let mountedSlideEditorCount = 0

export function attachSlideEditorStoreLifecycle(): () => void {
  mountedSlideEditorCount += 1

  return () => {
    mountedSlideEditorCount = Math.max(0, mountedSlideEditorCount - 1)
    if (mountedSlideEditorCount === 0) {
      useSlideStore.getState().resetStore()
    }
  }
}

export function resetSlideEditorStoreLifecycleForTest(): void {
  mountedSlideEditorCount = 0
}
