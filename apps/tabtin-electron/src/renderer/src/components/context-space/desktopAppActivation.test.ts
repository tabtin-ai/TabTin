import { describe, it, expect, vi } from 'vitest'
import { activateDesktopAppEntry } from './desktopAppActivation'
import type { DesktopAppEntry } from './desktopAppsModel'

function entry(over: Partial<DesktopAppEntry> & { id: string; mode: DesktopAppEntry['mode'] }): DesktopAppEntry {
  return {
    label: over.id,
    icon: null,
    groupId: 'other',
    ...over,
  }
}

describe('activateDesktopAppEntry', () => {
  it("mode='create' 走对应的 createHandlers，不打开应用主页", () => {
    const tabdata = vi.fn()
    const onOpenAppHome = vi.fn()
    activateDesktopAppEntry(entry({ id: 'tabdata', mode: 'create' }), {
      createHandlers: { tabdata },
      onOpenAppHome,
    })
    expect(tabdata).toHaveBeenCalledTimes(1)
    expect(onOpenAppHome).not.toHaveBeenCalled()
  })

  it("mode='home' 走 onOpenAppHome，不触发 createHandlers", () => {
    const tabweb = vi.fn()
    const onOpenAppHome = vi.fn()
    activateDesktopAppEntry(entry({ id: 'tabweb', mode: 'home' }), {
      createHandlers: { tabweb },
      onOpenAppHome,
    })
    expect(onOpenAppHome).toHaveBeenCalledTimes(1)
    expect(onOpenAppHome).toHaveBeenCalledWith('tabweb')
    expect(tabweb).not.toHaveBeenCalled()
  })

  it("mode='create' 但 create handler 缺失时静默跳过，不抛错", () => {
    const onOpenAppHome = vi.fn()
    expect(() =>
      activateDesktopAppEntry(entry({ id: 'ghost', mode: 'create' }), {
        createHandlers: {},
        onOpenAppHome,
      }),
    ).not.toThrow()
    expect(onOpenAppHome).not.toHaveBeenCalled()
  })
})
