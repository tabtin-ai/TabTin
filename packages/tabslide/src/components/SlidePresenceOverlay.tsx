/**
 * SlidePresenceOverlay — 远程协作者选区可视化
 *
 * 在幻灯片画布上渲染其他用户当前选中的元素：
 * - 彩色边框高亮被选中的元素
 * - 用户名标签显示在首个选中元素左上角
 *
 * 参考 Design 模块的 RemotePresenceOverlay。
 */
import React, { useMemo } from 'react'
import { getUserColor } from '@tabtin/collab-core'
import type { PPTElement } from '../types/slides'

export interface SlideRemotePeer {
  userId: string
  userName: string
  userColor: string
  userType?: 'user' | 'agent'
  pageId: string | null
  elementIds: string[]
}

export interface SlidePresenceOverlayProps {
  peers: SlideRemotePeer[]
  currentPageId: string | null
  elements: PPTElement[]
}

export const SlidePresenceOverlay = React.memo(function SlidePresenceOverlay({
  peers,
  currentPageId,
  elements,
}: SlidePresenceOverlayProps) {
  const pagePresences = useMemo(
    () => peers.filter((p) => p.pageId === currentPageId && p.elementIds.length > 0),
    [peers, currentPageId],
  )

  const elementMap = useMemo(() => {
    const map = new Map<string, PPTElement>()
    for (const el of elements) {
      map.set(el.id, el)
    }
    return map
  }, [elements])

  if (pagePresences.length === 0) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 100,
        overflow: 'hidden',
      }}
    >
      {pagePresences.map((presence) => {
        const color = presence.userColor || getUserColor(presence.userId)
        const isAgent = presence.userType === 'agent'

        return presence.elementIds.map((elementId) => {
          const el = elementMap.get(elementId)
          if (!el) return null

          const elX = el.x ?? 0
          const elY = el.y ?? 0
          const elW = el.width ?? 0
          const elH = el.height ?? 0

          if (elW < 1 || elH < 1) return null

          return (
            <div
              key={`${presence.userId}-${elementId}`}
              style={{
                position: 'absolute',
                left: elX,
                top: elY,
                width: elW,
                height: elH,
                border: `2px solid ${color}`,
                borderRadius: 2,
                boxSizing: 'border-box',
              }}
            >
              {presence.elementIds[0] === elementId && (
                <div
                  style={{
                    position: 'absolute',
                    left: -1,
                    top: -22,
                    background: color,
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '1px 6px',
                    borderRadius: '4px 4px 4px 0',
                    whiteSpace: 'nowrap',
                    lineHeight: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  {isAgent && (
                    <span
                      style={{
                        fontSize: 9,
                        background: 'rgba(255,255,255,0.3)',
                        borderRadius: 2,
                        padding: '0 3px',
                      }}
                    >
                      AI
                    </span>
                  )}
                  {presence.userName}
                </div>
              )}
            </div>
          )
        })
      })}
    </div>
  )
})
