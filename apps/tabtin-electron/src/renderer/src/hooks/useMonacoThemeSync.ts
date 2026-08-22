/**
 * Shared hook: watches <html> class changes and syncs Monaco editor theme.
 *
 * Uses a single MutationObserver across all consumer instances via
 * a module-level ref-count pattern to avoid redundant observers.
 */

import { useEffect } from 'react'
// 必须与 CodeEditor / Diff 同一 monaco 实例（editor.api），否则 defineTheme 注册不到。
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { getMonacoIdeThemeName, registerMonacoIdeThemes } from '@/utils/monaco-ide-theme'

let refCount = 0
let observer: MutationObserver | null = null

function syncTheme(): void {
  registerMonacoIdeThemes(monaco)
  monaco.editor.setTheme(getMonacoIdeThemeName())
}

function subscribe(): void {
  refCount++
  if (refCount === 1) {
    syncTheme()
    observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
}

function unsubscribe(): void {
  refCount--
  if (refCount <= 0) {
    observer?.disconnect()
    observer = null
    refCount = 0
  }
}

export function useMonacoThemeSync(): void {
  useEffect(() => {
    subscribe()
    return unsubscribe
  }, [])
}
