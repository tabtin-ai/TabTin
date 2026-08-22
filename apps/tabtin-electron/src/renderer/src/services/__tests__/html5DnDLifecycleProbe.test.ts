/**
 * Html5DnDLifecycleProbe 契约：无 React setState、无 sync toast shield IPC、生命周期日志。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetHtml5DnDLifecycleProbeForTests,
  installHtml5DnDLifecycleProbe,
} from '../html5DnDLifecycleProbe'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/services/html5DnDLifecycleProbe.ts'),
  'utf8',
)

describe('html5DnDLifecycleProbe source contract ', () => {
  it('installs capture-phase listeners and logs session lifecycle', () => {
    expect(source).toContain("createLogger('Html5DnDProbe')")
    expect(source).toContain("addEventListener('dragstart'")
    expect(source).toContain("addEventListener('drag'")
    expect(source).toContain("addEventListener('dragover'")
    expect(source).toContain("addEventListener('drop'")
    expect(source).toContain("addEventListener('dragend'")
    expect(source).toContain("log.info('session start'")
    expect(source).toContain("log.info('session end'")
    expect(source).toContain("shieldMode: 'main-process-hwnd-retire'")
  })

  it('does not call toast shield sync IPC (pointerdown/dragstart)', () => {
    expect(source).not.toMatch(/tabtin\?\.overlay\?\.setHtml5DragShieldSync/)
    expect(source).not.toContain('setShield(')
    expect(source).not.toContain("addEventListener('pointerdown'")
  })

  it('does not import React or use React state APIs', () => {
    expect(source).not.toMatch(/from ['"]react['"]/)
    expect(source).not.toMatch(/\buseState\b|\buseReducer\b/)
  })
})

describe('installHtml5DnDLifecycleProbe runtime', () => {
  afterEach(() => {
    __resetHtml5DnDLifecycleProbeForTests()
    vi.unstubAllGlobals()
  })

  it('is idempotent and uninstalls cleanly', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const dispose1 = installHtml5DnDLifecycleProbe()
    const dispose2 = installHtml5DnDLifecycleProbe()
    expect(add.mock.calls.filter((c) => c[0] === 'dragstart').length).toBe(1)
    dispose2()
    dispose1()
    expect(remove).toHaveBeenCalledWith('dragstart', expect.any(Function), true)
  })
})
