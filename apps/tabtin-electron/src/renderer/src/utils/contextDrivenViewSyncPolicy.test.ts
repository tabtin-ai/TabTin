import { describe, expect, it } from 'vitest'

import {
  shouldMirrorShellEventToLocalStore,
  shouldMirrorViewManagerEventToLocalStore,
} from '../../../../../../packages/crawlspace-core/src/utils/context-driven-view-sync'

describe('context-driven-view-sync', () => {
  it('context-driven 时会跳过 ViewManager 的主进程权威事件回流', () => {
    expect(shouldMirrorViewManagerEventToLocalStore('title:changed', true)).toBe(false)
    expect(shouldMirrorViewManagerEventToLocalStore('favicon:changed', true)).toBe(false)
    expect(shouldMirrorViewManagerEventToLocalStore('custom:event', true)).toBe(true)
  })

  it('context-driven 时会跳过 Shell 的主进程导航事件回流', () => {
    expect(shouldMirrorShellEventToLocalStore('page:loading', true)).toBe(false)
    expect(shouldMirrorShellEventToLocalStore('navigation:state', true)).toBe(false)
    expect(shouldMirrorShellEventToLocalStore('theme-color:changed', true)).toBe(false)
    expect(shouldMirrorShellEventToLocalStore('custom:event', true)).toBe(true)
  })

  it('非 context-driven 模式保持原行为', () => {
    expect(shouldMirrorViewManagerEventToLocalStore('title:changed', false)).toBe(true)
    expect(shouldMirrorShellEventToLocalStore('page:loading', false)).toBe(true)
  })
})
