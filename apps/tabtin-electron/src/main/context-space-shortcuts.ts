import type { WebContents } from 'electron'

import {
  getNumericTabAction,
  type ContextSpaceShortcutAction,
  type ContextSpaceShortcutGuardOptions,
} from './types/runtime'

const SHORTCUT_DEDUPE_WINDOW_MS = 120

export interface ContextSpaceShortcutController {
  emitShortcut: (action: ContextSpaceShortcutAction) => void
  registerGuard: (
    webContents: WebContents,
    options?: ContextSpaceShortcutGuardOptions,
  ) => void
  cleanupGuard: (webContents: WebContents) => void
}

export interface ContextSpaceShortcutControllerOptions {
  emitShortcut: (action: ContextSpaceShortcutAction) => void
}

export function createContextSpaceShortcutController(
  options: ContextSpaceShortcutControllerOptions,
): ContextSpaceShortcutController {
  const shortcutGuardHandlers = new WeakMap<
    WebContents,
    (_event: Electron.Event, input: Electron.Input) => void
  >()
  const shortcutGuardedWebContents = new WeakSet<WebContents>()
  const lastShortcutRef: { action: ContextSpaceShortcutAction | null; timestamp: number } = {
    action: null,
    timestamp: 0,
  }

  const emitShortcut = (action: ContextSpaceShortcutAction) => {
    const now = Date.now()
    if (lastShortcutRef.action === action && now - lastShortcutRef.timestamp < SHORTCUT_DEDUPE_WINDOW_MS) {
      return
    }
    lastShortcutRef.action = action
    lastShortcutRef.timestamp = now
    options.emitShortcut(action)
  }

  const registerGuard = (
    webContents: WebContents,
    options: ContextSpaceShortcutGuardOptions = {},
  ) => {
    if (!webContents || webContents.isDestroyed()) {
      return
    }
    if (shortcutGuardedWebContents.has(webContents)) {
      return
    }
    shortcutGuardedWebContents.add(webContents)

    const { interceptZoomShortcuts = true } = options

    const handler = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== 'keyDown') {
        return
      }

      const key = input.key?.toLowerCase?.() ?? ''
      const hasPrimaryModifier = input.control || input.meta

      if (hasPrimaryModifier && !input.shift && !input.alt) {
        if (key === 'r') {
          event.preventDefault()
          emitShortcut('refresh')
          return
        }
        if (key === 'w') {
          event.preventDefault()
          emitShortcut('close')
          return
        }
        if (key === 't') {
          event.preventDefault()
          emitShortcut('new-tab')
          return
        }
        if (key === 'f') {
          event.preventDefault()
          emitShortcut('find')
          return
        }
        const numericAction = getNumericTabAction(key)
        if (numericAction) {
          event.preventDefault()
          emitShortcut(numericAction)
          return
        }
      }

      if (hasPrimaryModifier && input.shift && !input.alt) {
        if (key === 't') {
          event.preventDefault()
          emitShortcut('reopen-closed-tab')
          return
        }
        if (key === '[') {
          event.preventDefault()
          emitShortcut('back')
          return
        }
        if (key === ']') {
          event.preventDefault()
          emitShortcut('forward')
          return
        }
        if (key === 'l') {
          event.preventDefault()
          emitShortcut('focus-url')
          return
        }
        if (interceptZoomShortcuts && (key === '=' || key === '+')) {
          event.preventDefault()
          emitShortcut('zoom-in')
          return
        }
        if (interceptZoomShortcuts && key === '-') {
          event.preventDefault()
          emitShortcut('zoom-out')
          return
        }
        if (interceptZoomShortcuts && key === '0') {
          event.preventDefault()
          emitShortcut('zoom-reset')
          return
        }
      }

      if (interceptZoomShortcuts && hasPrimaryModifier && input.shift && !input.alt && (key === '=' || key === '+')) {
        event.preventDefault()
        emitShortcut('zoom-in')
        return
      }

      if (key === 'f5' && !hasPrimaryModifier && !input.shift && !input.alt) {
        event.preventDefault()
        emitShortcut('refresh')
        return
      }

      if (input.control && input.key === 'Tab') {
        event.preventDefault()
        emitShortcut(input.shift ? 'prev-tab' : 'next-tab')
      }
    }

    shortcutGuardHandlers.set(webContents, handler)
    webContents.on('before-input-event', handler)
  }

  const cleanupGuard = (webContents: WebContents) => {
    if (!webContents) {
      return
    }
    const handler = shortcutGuardHandlers.get(webContents)
    if (handler && !webContents.isDestroyed()) {
      webContents.removeListener('before-input-event', handler)
    }
    shortcutGuardHandlers.delete(webContents)
    shortcutGuardedWebContents.delete(webContents)
  }

  return {
    emitShortcut,
    registerGuard,
    cleanupGuard,
  }
}
