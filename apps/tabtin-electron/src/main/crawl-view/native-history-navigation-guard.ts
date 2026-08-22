import type { WebContents } from 'electron'

import { getEffectiveNavigationState, isInternalHistoryUrl } from './navigation-state'

type PreventableEvent = {
  preventDefault: () => void
}

type NativeHistoryDirection = 'back' | 'forward'

function normalizedKey(input: Electron.Input): string {
  return String(input.key || input.code || '').toLowerCase()
}

function getNativeHistoryDirection(input: Electron.Input): NativeHistoryDirection | null {
  if (input.type !== 'keyDown') return null

  const key = normalizedKey(input)
  if (key === 'browserback') return 'back'
  if (key === 'browserforward') return 'forward'

  if (input.alt && !input.control && !input.meta && !input.shift) {
    if (key === 'arrowleft' || key === 'left') return 'back'
    if (key === 'arrowright' || key === 'right') return 'forward'
  }

  if (input.meta && !input.control && !input.alt && !input.shift) {
    if (key === '[' || key === 'bracketleft') return 'back'
    if (key === ']' || key === 'bracketright') return 'forward'
  }

  return null
}

export function handleNativeHistoryNavigationInput(
  event: PreventableEvent,
  input: Electron.Input,
  webContents: WebContents,
  emitNavigationState: () => void,
): boolean {
  const direction = getNativeHistoryDirection(input)
  if (!direction || webContents.isDestroyed()) return false

  event.preventDefault()
  const navigation = getEffectiveNavigationState(webContents)
  if (direction === 'back' && navigation.canGoBack) {
    webContents.navigationHistory.goBack()
  }
  if (direction === 'forward' && navigation.canGoForward) {
    webContents.navigationHistory.goForward()
  }
  emitNavigationState()
  return true
}

export function bindNativeHistoryNavigationGuard(
  webContents: WebContents,
  emitNavigationState: () => void,
): () => void {
  const handler = (event: Electron.Event, input: Electron.Input) => {
    handleNativeHistoryNavigationInput(event, input, webContents, emitNavigationState)
  }

  webContents.on('before-input-event', handler)
  return () => {
    if (!webContents.isDestroyed()) {
      webContents.removeListener('before-input-event', handler)
    }
  }
}

export function handleNativeHistoryAppCommand(
  event: PreventableEvent,
  command: string,
  actions: {
    goBack: () => boolean
    goForward: () => boolean
    emitNavigationState: () => void
  },
): boolean {
  if (command !== 'browser-backward' && command !== 'browser-forward') return false

  event.preventDefault()
  const success = command === 'browser-backward' ? actions.goBack() : actions.goForward()
  if (!success) {
    actions.emitNavigationState()
  }
  return true
}

export function repairUnsafeInternalHistoryNavigation(
  url: string | undefined,
  webContents: WebContents,
  emitNavigationState: () => void,
): boolean {
  if (!isInternalHistoryUrl(url) || webContents.isDestroyed()) return false

  const { navigationHistory } = webContents
  if (!navigationHistory.canGoForward()) return false

  navigationHistory.goForward()
  emitNavigationState()
  return true
}
