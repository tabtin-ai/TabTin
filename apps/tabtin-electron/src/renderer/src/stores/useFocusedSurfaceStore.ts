/** @store-category ui */

/**
 * 当前工作台表面的瞬时焦点。
 *
 * 这里记录的是“用户此刻正在看什么”，不是资源本身的持久化属性，因此不能写进
 * useSpaceContextTabsStore（后者会落 localStorage，关闭预览或重启后会留下过期文件）。
 * scopeKey + tabKey 与 ChatPanel 解析 active tab 的口径一致，也避免桌面 / 对话画布之间
 * 串焦点。
 */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'

export type FocusedSurfaceAppType = 'tabcode' | 'tabfolder'

export interface FocusedSurface {
  appType: FocusedSurfaceAppType
  rootPath: string
  focusedFilePath: string | null
}

interface FocusedSurfaceEntry {
  ownerId: number
  surface: FocusedSurface
}

interface FocusedSurfaceState {
  byContextKey: Record<string, FocusedSurfaceEntry>
  report: (contextKey: string, ownerId: number, surface: FocusedSurface) => void
  clear: (contextKey: string, ownerId: number) => void
}

let nextOwnerId = 1

export function buildFocusedSurfaceContextKey(
  scopeKey?: string | null,
  tabKey?: string | null,
): string | null {
  if (!scopeKey || !tabKey) return null
  return `${scopeKey}\0${tabKey}`
}

export const useFocusedSurfaceStore = create<FocusedSurfaceState>((set) => ({
  byContextKey: {},

  report: (contextKey, ownerId, surface) => {
    set((state) => {
      const current = state.byContextKey[contextKey]
      if (
        current?.ownerId === ownerId
        && current.surface.appType === surface.appType
        && current.surface.rootPath === surface.rootPath
        && current.surface.focusedFilePath === surface.focusedFilePath
      ) {
        return state
      }
      return {
        byContextKey: {
          ...state.byContextKey,
          [contextKey]: { ownerId, surface },
        },
      }
    })
  },

  clear: (contextKey, ownerId) => {
    set((state) => {
      if (state.byContextKey[contextKey]?.ownerId !== ownerId) return state
      const { [contextKey]: _removed, ...rest } = state.byContextKey
      return { byContextKey: rest }
    })
  },
}))

interface UseFocusedSurfaceReporterOptions {
  scopeKey?: string | null
  tabKey?: string | null
  appType: FocusedSurfaceAppType
  rootPath?: string | null
  focusedFilePath?: string | null
}

export function useFocusedSurfaceReporter({
  scopeKey,
  tabKey,
  appType,
  rootPath,
  focusedFilePath,
}: UseFocusedSurfaceReporterOptions): void {
  const ownerIdRef = useRef<number | null>(null)
  if (ownerIdRef.current == null) {
    ownerIdRef.current = nextOwnerId++
  }

  useEffect(() => {
    const contextKey = buildFocusedSurfaceContextKey(scopeKey, tabKey)
    if (!contextKey || !rootPath) return

    const ownerId = ownerIdRef.current!
    useFocusedSurfaceStore.getState().report(contextKey, ownerId, {
      appType,
      rootPath,
      focusedFilePath: focusedFilePath || null,
    })
    return () => {
      useFocusedSurfaceStore.getState().clear(contextKey, ownerId)
    }
  }, [appType, focusedFilePath, rootPath, scopeKey, tabKey])
}
