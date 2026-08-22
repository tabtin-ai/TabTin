/**
 * 统一的下拉菜单组件
 * 用于所有需要弹出菜单的场景：右键菜单、更多操作等
 *
 * 统一样式规范：
 * - 菜单项 hover 状态：bg-accent/15 (15% 透明度，更明显)
 * - 危险操作 hover：bg-destructive/10
 * - 圆角：rounded-interactive (8px)
 * - 内边距：p-1 外层，px-2 py-2 内层
 * - 动画：0.1s 缩放淡入淡出
 */

import React from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '../../utils/cn'
import { ZIndex } from '@tabtin/app-shell'
import { OVERLAY_SURFACE_CLASS } from '../overlay-surface'

// Wave 6.3 注：本组件**全仓 0 调用方**（grep 历史无活引用），且其内部用相对
// trigger 定位的 className（`absolute top-full mt-1 left-0`）——一旦 portal 到
// 任何非 body 容器（比如 OverlayContainer 的 absolute div），`absolute` 就会被
// 解析为相对该容器原点而不是 trigger，菜单立即位置错乱。结合"无调用方"的
// 现状，本组件保持裸 portal 到 body，等下波 dev 体验治理时一并删除（或重写
// 为 fixed + viewport 计算）。**新加调用方前请先重写定位逻辑**。

export interface MenuItem {
  id: string
  label?: string
  icon?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'default' | 'destructive'
  separator?: boolean
  /** 右侧额外内容（如选中标记） */
  trailing?: React.ReactNode
}

// 单独的菜单项组件，用于管理 hover 状态
const MenuItemButton: React.FC<{
  item: MenuItem
  onClose: () => void
}> = ({ item, onClose }) => {
  const [isHovered, setIsHovered] = React.useState(false)

  return (
    <button
      onClick={() => {
        if (!item.disabled && item.onClick) {
          item.onClick()
          onClose()
        }
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      disabled={item.disabled}
      style={{
        backgroundColor: isHovered && !item.disabled
          ? item.variant === 'destructive'
            ? 'hsl(0 62.8% 30.6% / 0.1)'
            : 'hsl(262 83% 58% / 0.15)'
          : 'transparent',
      }}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-2 rounded-interactive text-body transition-all duration-150 outline-none cursor-pointer',
        item.variant === 'destructive' ? 'text-destructive' : 'text-foreground',
        item.disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      {item.icon && (
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground">
          {item.icon}
        </span>
      )}
      <span className="flex-1 text-left">{item.label}</span>
      {item.trailing && (
        <span className="flex-shrink-0 ml-auto">
          {item.trailing}
        </span>
      )}
    </button>
  )
}

export interface MenuProps {
  items: MenuItem[]
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  /** 菜单位置，默认 'bottom' */
  position?: 'bottom' | 'top' | 'left' | 'right'
  /** 对齐方式，默认 'start' */
  align?: 'start' | 'center' | 'end'
  /** 自定义类名 */
  className?: string
  /** 固定位置（用于右键菜单） */
  fixedPosition?: { x: number; y: number }
}

export const Menu: React.FC<MenuProps> = ({
  items,
  isOpen,
  onClose,
  children,
  position = 'bottom',
  align = 'start',
  className,
  fixedPosition,
}) => {
  return (
    <div className="relative">
      {children}

      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <>
              {/* 遮罩层 - 使用 Portal 渲染到 body，确保覆盖整个应用 */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="fixed inset-0"
                style={{ zIndex: ZIndex.global }}
                onClick={onClose}
              />

              {/* 菜单内容 */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.1 }}
                style={{
                  zIndex: ZIndex.global,
                  ...(fixedPosition
                    ? {
                        position: 'fixed',
                        left: fixedPosition.x,
                        top: fixedPosition.y,
                      }
                    : {})
                }}
                className={cn(
                cn('min-w-[180px] rounded-interactive overflow-hidden', OVERLAY_SURFACE_CLASS),
                  // 相对定位时的位置
                  !fixedPosition && [
                    'absolute',
                    position === 'bottom' && 'top-full mt-1',
                    position === 'top' && 'bottom-full mb-1',
                    position === 'left' && 'right-full mr-1',
                    position === 'right' && 'left-full ml-1',
                    // 对齐
                    align === 'start' && 'left-0',
                    align === 'center' && 'left-1/2 -translate-x-1/2',
                    align === 'end' && 'right-0',
                  ],
                  className
                )}
              >
                <div className="p-1">
                  {items.map((item, index) => {
                    if (item.separator) {
                      return (
                        <div
                          key={item.id || `separator-${index}`}
                          className="border-t border-border my-1"
                        />
                      )
                    }

                    return (
                      <MenuItemButton
                        key={item.id}
                        item={item}
                        onClose={onClose}
                      />
                    )
                  })}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
