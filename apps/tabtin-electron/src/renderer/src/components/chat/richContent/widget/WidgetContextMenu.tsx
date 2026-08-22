/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 561-711）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：Widget Wave 4.10 右键菜单组件 —— 保存 PNG / 复制源码 / 在新窗口打开。
 *       纯展示层，实际业务 handler（handleSavePng / handleCopyCode /
 *       handleOpenInNewWindow）由父组件 RichWidget 注入。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Copy, ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'

/**
 * Widget Wave 4.10：右键菜单组件。
 *
 * **设计取舍**：
 *   - 用 `position: fixed` + 鼠标坐标定位——避免父容器 overflow:hidden 截断
 *     菜单（chat 卡片在 ScrollArea 里）
 *   - 点 document 任意处 / Esc 关闭——标准右键菜单交互
 *   - menu items 都是 button——a11y / 键盘可达
 *   - 不引入 dropdown menu library（chat 模块没用 radix DropdownMenu）——保持
 *     依赖最小
 *
 * **状态分级**（什么菜单项可用）：
 *   | 状态 | 保存 PNG | 复制 SVG | 在新窗口打开 |
 *   |---|---|---|---|
 *   | finalCode 在 + image_url 在 | ✓（用 image_url 直接下载） | ✓ | ✓（image_url） |
 *   | finalCode 在 + image_url 缺 | ✓（renderer 端 SVG→PNG，提示限制） | ✓ | ✓（srcdoc） |
 *   | streamingCode 在 + finalCode 缺 | ✗（disable） | ✗（disable，正在流式） | ✓（srcdoc 当前 partial） |
 *   | image_url 在 + 双 code 缺 | ✓（image_url） | ✗ | ✓（image_url） |
 */
export interface WidgetMenuPosition {
  x: number
  y: number
}

export interface WidgetContextMenuProps {
  position: WidgetMenuPosition
  canSavePng: boolean
  canCopyCode: boolean
  canOpenInNewWindow: boolean
  copyLabel: string
  onSavePng: () => void
  onCopyCode: () => void
  onOpenInNewWindow: () => void
  onClose: () => void
}

export const WidgetContextMenu: React.FC<WidgetContextMenuProps> = ({
  position,
  canSavePng,
  canCopyCode,
  canOpenInNewWindow,
  copyLabel,
  onSavePng,
  onCopyCode,
  onOpenInNewWindow,
  onClose,
}) => {
  const { t } = useTranslation('chat')
  // 点击菜单外 / Esc 关闭——document level listener，cleanup 在 unmount
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    const onDocClick = (e: MouseEvent) => {
      // 点菜单内不关闭（菜单 stopPropagation 会更可靠，但保险起见加 guard）
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-widget-context-menu="true"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    // 加 capture: true 让我们先于子元素拿到 click，避免 widget 容器阻断
    document.addEventListener('mousedown', onDocClick, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocClick, true)
    }
  }, [onClose])

  // 让菜单不超出 viewport 边界——简单 clamp（不做完美 anchor 算法）。
  // 不在 inline style 设 zIndex——用 className 走 design-system 语义层级
  // (`z-dropdown` = 55，与 Popover / Select 同层；toast=60 高于菜单，符合
  // "用户主动触发菜单 + 点击后 toast 反馈在最顶层"的视觉栈)。
  const menuStyle = useMemo<React.CSSProperties>(() => {
    const MENU_WIDTH = 200
    const MENU_HEIGHT = 132
    const margin = 8
    const x = Math.min(position.x, window.innerWidth - MENU_WIDTH - margin)
    const y = Math.min(position.y, window.innerHeight - MENU_HEIGHT - margin)
    return {
      left: Math.max(margin, x),
      top: Math.max(margin, y),
    }
  }, [position])

  return (
    <div
      data-widget-context-menu="true"
      role="menu"
      aria-label={t('richContent.widgetMenuLabel', '图示操作菜单')}
      className={cn('fixed z-dropdown min-w-[180px] rounded-interactive py-1 text-caption', OVERLAY_SURFACE_CLASS)}
      style={menuStyle}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!canSavePng}
        onClick={() => {
          onSavePng()
          onClose()
        }}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          canSavePng
            ? 'text-foreground hover:bg-muted/40 cursor-pointer'
            : 'text-muted-foreground/60 cursor-not-allowed',
        )}
      >
        <Save className="h-3.5 w-3.5" aria-hidden />
        {t('richContent.widgetMenuSavePng', '保存图片 PNG')}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canCopyCode}
        onClick={() => {
          onCopyCode()
          onClose()
        }}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          canCopyCode
            ? 'text-foreground hover:bg-muted/40 cursor-pointer'
            : 'text-muted-foreground/60 cursor-not-allowed',
        )}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        {copyLabel}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!canOpenInNewWindow}
        onClick={() => {
          onOpenInNewWindow()
          onClose()
        }}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          canOpenInNewWindow
            ? 'text-foreground hover:bg-muted/40 cursor-pointer'
            : 'text-muted-foreground/60 cursor-not-allowed',
        )}
      >
        <ExternalLinkIcon className="h-3.5 w-3.5" aria-hidden />
        {t('richContent.widgetMenuOpenInNewWindow', '在新窗口打开')}
      </button>
    </div>
  )
}
