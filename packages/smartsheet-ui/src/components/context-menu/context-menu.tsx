/**
 * ContextMenu 根组件
 * 使用 Floating UI 进行定位
 */

import React, { createContext, useContext, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  autoPlacement,
  type Placement,
} from '@floating-ui/react'
import { cn } from '../../utils/cn'
import type { ContextMenuProps } from './types'
import { ContextMenuHeader } from './context-menu-header'
import { FLOATING_OFFSET, FLOATING_SHIFT_PADDING } from './constants'
import { resolveContextMenuPortalContainer } from './portal-container'
import { useOverlayContainer } from '../overlay-container-context'

interface ContextMenuContextValue {
  onClose: () => void
  portalContainer: HTMLElement | null
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null)

export function useContextMenuClose(): (() => void) | null {
  return useContext(ContextMenuContext)?.onClose ?? null
}

export function useContextMenuPortalContainer(): HTMLElement | null | undefined {
  return useContext(ContextMenuContext)?.portalContainer
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  open,
  onClose,
  anchorEl,
  anchorPosition,
  header,
  children,
  className,
  style,
  placement = 'bottom-start',
  closeOnClickOutside = true,
  closeOnEscape = true,
  testId,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const virtualElementRef = useRef<{
    getBoundingClientRect: () => DOMRect
  } | null>(null)

  // 如果提供坐标，创建虚拟元素用于定位
  useEffect(() => {
    if (anchorPosition) {
      virtualElementRef.current = {
        getBoundingClientRect: () => ({
          x: anchorPosition.x,
          y: anchorPosition.y,
          top: anchorPosition.y,
          left: anchorPosition.x,
          bottom: anchorPosition.y,
          right: anchorPosition.x,
          width: 0,
          height: 0,
        } as DOMRect),
      }
    } else {
      virtualElementRef.current = null
    }
  }, [anchorPosition])

  // Floating UI 配置
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (isOpen) => {
      if (!isOpen) onClose()
    },
    placement: placement === 'auto' ? undefined : (placement as Placement),
    middleware: placement === 'auto'
      ? [
          autoPlacement({
            allowedPlacements: ['bottom-start', 'bottom-end', 'top-start', 'top-end'],
          }),
          offset(FLOATING_OFFSET),
          shift({ padding: FLOATING_SHIFT_PADDING }),
        ]
      : [
          offset(FLOATING_OFFSET),
          flip(),
          shift({ padding: FLOATING_SHIFT_PADDING }),
        ],
    whileElementsMounted: autoUpdate,
  })

  const setFloatingRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node
    refs.setFloating(node)
  }, [refs])

  // 设置参考元素
  useEffect(() => {
    if (anchorEl) {
      refs.setReference(anchorEl)
    } else if (virtualElementRef.current) {
      refs.setReference(virtualElementRef.current as any)
    }
  }, [anchorEl, anchorPosition, refs])

  // ESC 关闭
  useEffect(() => {
    if (!open || !closeOnEscape) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, closeOnEscape, onClose])

  // 点击外部关闭
  useEffect(() => {
    if (!open || !closeOnClickOutside) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null
      const menuElement = menuRef.current
      if (!menuElement || !target) return

      if (menuElement.contains(target)) {
        return
      }

      if (anchorEl?.contains(target)) {
        return
      }

      if (target instanceof Element) {
        const closestMenu = target.closest('.context-menu')
        if (closestMenu?.classList.contains('context-menu--submenu')) {
          return
        }
      }

      onClose()
    }

    // 延迟添加监听器，避免立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [open, closeOnClickOutside, onClose, anchorEl])

  // Wave 6.3：消费上层 OverlayContainerProvider 的容器，让 ContextMenu 跟随
  // 所属 Space 的 hot/visible 状态自动隐藏；Provider 之外仍 portal 到 body。
  const overlayContainer = useOverlayContainer()
  const portalContainer = React.useMemo(
    () => resolveContextMenuPortalContainer({ overlayContainer, anchorEl, anchorPosition }),
    [anchorEl, anchorPosition, overlayContainer],
  )
  const contextValue = React.useMemo(() => ({ onClose, portalContainer }), [onClose, portalContainer])

  if (!open) {
    return null
  }

  return createPortal(
    <ContextMenuContext.Provider value={contextValue}>
      <div
        ref={setFloatingRef}
        style={{
          ...floatingStyles,
          ...style,
        }}
        className={cn('context-menu', className)}
        data-testid={testId}
        role="menu"
        tabIndex={-1}
      >
        {header && <ContextMenuHeader {...header} />}
        <div className="context-menu-body">
          {children}
        </div>
      </div>
    </ContextMenuContext.Provider>,
    portalContainer ?? document.body
  )
}

