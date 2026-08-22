import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createContextSpaceShortcutController } from '../context-space-shortcuts'

class FakeWebContents extends EventEmitter {
  isDestroyed() {
    return false
  }
}

describe('context-space shortcuts · find', () => {
  it.each([
    ['Cmd+F', { meta: true, control: false }],
    ['Ctrl+F', { meta: false, control: true }],
  ])('forwards %s to the active renderer and consumes the native shortcut', (_label, modifiers) => {
    const emitShortcut = vi.fn()
    const webContents = new FakeWebContents()
    const controller = createContextSpaceShortcutController({ emitShortcut })
    controller.registerGuard(webContents as never)

    const event = { preventDefault: vi.fn() }
    webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'f',
      shift: false,
      alt: false,
      ...modifiers,
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(emitShortcut).toHaveBeenCalledWith('find')
  })
})
