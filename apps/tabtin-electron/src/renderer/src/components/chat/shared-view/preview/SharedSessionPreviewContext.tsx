/**
 * SharedSessionPreviewContext — 共享会话内本地文件按需预览入口。
 *
 * 仅 SharedSessionPane 提供；主工作台写入当前标签 scope，独立 IM 窗口没有标签
 * 画布时由 Drawer 适配器承载。普通 ChatPanel 无此 context 时走原本地/遥控链路。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { useResourcePreviewStore } from '@/components/chat/preview/useResourcePreviewStore'
import { useOptionalSpaceContextState } from '@/components/context-space/SpaceContextAreaContext'
import { useSharedSessionPreviewStore } from './useSharedSessionPreviewStore'
import { openSharedSessionFileTab } from './openSharedSessionFileTab'

export interface SharedSessionPreviewRequest {
  relativePath: string
  title?: string
}

export interface SharedSessionPreviewContextValue {
  sessionId: string
  shareId: string
  organizationId: string | null
  /** 打开会话结构化引用的远端文件预览。 */
  openSharedLocalFilePreview: (request: SharedSessionPreviewRequest) => void
}

const SharedSessionPreviewContext = createContext<SharedSessionPreviewContextValue | null>(null)

export function SharedSessionPreviewProvider({
  sessionId,
  shareId,
  organizationId,
  tabScopeKey,
  children,
}: {
  sessionId: string | null
  shareId: string | null
  organizationId: string | null
  tabScopeKey?: string | null
  children: React.ReactNode
}) {
  const spaceContext = useOptionalSpaceContextState()
  const openSharedLocalFilePreview = useCallback((next: SharedSessionPreviewRequest) => {
    if (!sessionId || !shareId) return
    // 与全屏 Lightbox 互斥，避免 z-index 叠层
    useResourcePreviewStore.getState().close()
    const targetTabScopeKey = tabScopeKey || spaceContext?.tabScopeKey
    if (targetTabScopeKey) {
      openSharedSessionFileTab({
        tabScopeKey: targetTabScopeKey,
        sessionId,
        shareId,
        relativePath: next.relativePath,
        title: next.title,
      })
      return
    }
    // 独立 IM 窗口没有工作台标签画布，使用同一预览 Pane 的 Drawer 适配器。
    useSharedSessionPreviewStore.getState().open({
      sessionId,
      shareId,
      relativePath: next.relativePath,
      title: next.title,
    })
  }, [sessionId, shareId, spaceContext?.tabScopeKey, tabScopeKey])

  useEffect(() => {
    return () => {
      const { target, close } = useSharedSessionPreviewStore.getState()
      if (sessionId && shareId && target?.sessionId === sessionId && target.shareId === shareId) close()
    }
  }, [sessionId, shareId])

  const value = useMemo<SharedSessionPreviewContextValue | null>(
    () => sessionId && shareId
      ? {
          sessionId,
          shareId,
          organizationId,
          openSharedLocalFilePreview,
        }
      : null,
    [
      sessionId,
      shareId,
      organizationId,
      openSharedLocalFilePreview,
    ],
  )

  return (
    <SharedSessionPreviewContext.Provider value={value}>
      {children}
    </SharedSessionPreviewContext.Provider>
  )
}

export function useSharedSessionPreview(): SharedSessionPreviewContextValue | null {
  return useContext(SharedSessionPreviewContext)
}
