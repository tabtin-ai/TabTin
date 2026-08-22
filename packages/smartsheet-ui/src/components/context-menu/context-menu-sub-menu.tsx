/**
 * ContextMenuSubMenu 组件
 * 支持鼠标悬停展开，使用 Floating UI 定位
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  autoPlacement,
} from '@floating-ui/react'
import { cn } from '../../utils/cn'
import type { ContextMenuSubMenuProps } from './types'
import { useContextMenuPortalContainer } from './context-menu'
import { useOverlayContainer } from '../overlay-container-context'

export const ContextMenuSubMenu: React.FC<ContextMenuSubMenuProps> = ({
  icon,
  label,
  suffix,
  children,
  expandMode = 'hover',
  expandDelay = 150,
  disabled = false,
  className,
  testId,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null)
  const createTimeRef = useRef(Date.now())
  const submenuRef = useRef<HTMLDivElement>(null)

  // Floating UI 子菜单定位
  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'right-start',
    middleware: [
      offset({ mainAxis: 16, crossAxis: -8.5 }),
      autoPlacement({
        allowedPlacements: ['right-start', 'left-start', 'right-end', 'left-end'],
      }),
      shift(),
    ],
    whileElementsMounted: autoUpdate,
  })

  const setSubmenuFloatingRef = useCallback((node: HTMLDivElement | null) => {
    submenuRef.current = node
    refs.setFloating(node)
  }, [refs])

  // 鼠标悬停展开
  const handleMouseEnter = () => {
    if (disabled || expandMode !== 'hover') return

    // 防止初始化时立即触发
    const timeSinceCreate = Date.now() - createTimeRef.current
    if (timeSinceCreate < 100) return

    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
    }
    hoverTimerRef.current = setTimeout(() => {
      setIsOpen(true)
    }, expandDelay)
  }

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
    }
    // 延迟关闭，给用户时间移动到子菜单
    hoverTimerRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 300)  // 增加延迟时间，给用户更多时间
  }

  // 子菜单也需要处理鼠标事件
  const handleSubmenuMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
    }
  }

  const handleSubmenuMouseLeave = () => {
    // 延迟关闭，避免鼠标移动过程中意外关闭
    hoverTimerRef.current = setTimeout(() => {
      setIsOpen(false)
    }, 150)
  }

  // 点击展开（click 模式）
  const handleClick = (e: React.MouseEvent) => {
    if (disabled) return

    e.preventDefault()
    e.stopPropagation()

    if (expandMode === 'click') {
      setIsOpen(!isOpen)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return

    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      setIsOpen(true)
    } else if (e.key === 'ArrowLeft' && isOpen) {
      e.preventDefault()
      e.stopPropagation()
      setIsOpen(false)
    }
  }

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current)
      }
    }
  }, [])

  // 重置创建时间
  useEffect(() => {
    createTimeRef.current = Date.now()
  }, [])

  // Wave 6.3：消费 OverlayContainerProvider 容器，跟父 ContextMenu 同源；
  // Provider 之外 fallback 到 body。
  const parentPortalContainer = useContextMenuPortalContainer()
  const overlayContainer = useOverlayContainer()
  const portalContainer = parentPortalContainer !== undefined ? parentPortalContainer : overlayContainer

  return (
    <>
      <div
        ref={refs.setReference}
        className={cn('context-menu-item', 'context-menu-sub-menu', className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={disabled ? -1 : 0}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-disabled={disabled}
        data-disabled={disabled}
        data-testid={testId}
      >
        {icon && <span className="context-menu-item__icon">{icon}</span>}
        <span className="context-menu-item__label">{label}</span>
        {suffix && <span className="context-menu-item__suffix">{suffix}</span>}
        <ChevronRight className="context-menu-sub-menu__arrow" />
      </div>

      {isOpen && createPortal(
        <div
          ref={setSubmenuFloatingRef}
          style={floatingStyles}
          className="context-menu context-menu--submenu"
          onMouseEnter={handleSubmenuMouseEnter}
          onMouseLeave={handleSubmenuMouseLeave}
          role="menu"
        >
          <div className="context-menu-body">
            {children}
          </div>
        </div>,
        portalContainer ?? document.body
      )}
    </>
  )
}

