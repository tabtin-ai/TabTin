/**
 * 集中式快捷键系统
 *
 * 所有快捷键在此统一定义，自动适配 macOS / Windows / Linux。
 * 组件通过 useHotkey(def, handler) 注册，多窗口不冲突。
 */

import { useEffect, useRef } from 'react'

const IS_MAC =
  typeof process !== 'undefined' && process.platform === 'darwin'

export interface HotkeyDef {
  key: string
  mod?: boolean
  shift?: boolean
  alt?: boolean
}

export const HOTKEYS = {
  quickOpen: { key: 'p', mod: true } as HotkeyDef,
  keywordSearch: { key: 'f', mod: true, shift: true } as HotkeyDef,
  toggleSideBySide: { key: '\\', mod: true } as HotkeyDef,
  recentFiles: { key: 'e', mod: true } as HotkeyDef,
  reopenClosed: { key: 't', mod: true, shift: true } as HotkeyDef,
  closePanel: { key: 'Escape' } as HotkeyDef,
  cycleAgentMode: { key: '.', mod: true, shift: true } as HotkeyDef,
} as const

function matchesHotkey(e: KeyboardEvent, def: HotkeyDef): boolean {
  if (e.key.toLowerCase() !== def.key.toLowerCase()) return false
  const needMod = def.mod ?? false
  const hasMod = IS_MAC ? e.metaKey : e.ctrlKey
  if (needMod !== hasMod) return false
  if ((def.shift ?? false) !== e.shiftKey) return false
  if ((def.alt ?? false) !== e.altKey) return false
  return true
}

export function hotkeyLabel(def: HotkeyDef): string {
  const parts: string[] = []
  if (def.mod) parts.push(IS_MAC ? '⌘' : 'Ctrl')
  if (def.shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (def.alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  parts.push(def.key.length === 1 ? def.key.toUpperCase() : def.key)
  return parts.join(IS_MAC ? '' : '+')
}

/**
 * 注册一个全局快捷键，在 capture 阶段拦截以避免被子元素阻断。
 * handler 通过 ref 持有，依赖数组无需包含回调。
 */
export function useHotkey(
  def: HotkeyDef,
  handler: () => void,
  enabled = true,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    const listener = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        if (def.mod) {
          // Cmd+P / Cmd+Shift+F 等组合键仍然拦截
        } else {
          return
        }
      }
      if (matchesHotkey(e, def)) {
        e.preventDefault()
        e.stopPropagation()
        handlerRef.current()
      }
    }
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [def.key, def.mod, def.shift, def.alt, enabled])
}
