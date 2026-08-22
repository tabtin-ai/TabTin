/**
 * FileCardHeader — 文件卡片头部 primitive。
 *
 * 三个 file 卡片（FileWriteCard / DiffCard / FileDeleteCard）共用的头部，避免在
 * 各卡片里重复实现：
 *   - 文件名（左键点击打开 TabCode 内置预览；外部文件同样进 IDE，系统应用仅右键）
 *   - 路径 hover 显示
 *   - 右上角右键菜单触发器（fixed 定位的菜单：在文件管理器中显示 / 用系统默认应用打开 / 复制路径）
 *   - 流式中 / 错误 / 已完成 多种状态指示
 *
 * **可点击的 affordance**：标题区 hover 时下划线 + cursor-pointer，让用户能感知"可点击"。
 * 失败 / 占位态（filePath 缺失或 disabled）时关闭点击行为，避免用户点了没反应。
 *
 * **菜单触发**：用 MoreHorizontal 三点按钮，hover 时浮现。点击后弹出 fixed 定位
 * 的菜单，参考 widget WidgetContextMenu 的轻量模式（不依赖 dropdown menu 库，避免
 * 引入新依赖）。点击外部 / Esc 自动关闭。
 *
 * 与 widget 的 WidgetContextMenu 不复用：widget 是按鼠标右键坐标弹出（在画布上
 * 任意位置），文件卡片是按按钮锚点弹出（位置固定在按钮下方），交互模式不同；
 * 而且 widget 的菜单只有 3 项，文件卡片可能要扩展更多操作（复制路径 / Reveal /
 * Open With / 未来还可能加 "Restore from checkpoint"），独立组件更利于演化。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderSearch, ExternalLink, ClipboardCopy } from 'lucide-react'
import { cn } from '@utils/cn'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { resolveRevealInOsLabel } from '@/components/chat/turn/revealInOsLabel'
import {
  CARD_HEADER_PADDING,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
} from '../../registry/chatDesignTokens'
import { basename } from '../../utils/path'
import { useFileOpenAction } from '../hooks/useFileOpenAction'
import { useScopedEventListener } from '@/hooks/spaceActivity'

export interface FileCardHeaderProps {
  /** 文件路径（绝对或相对均可，basename 会自动提取文件名）。 */
  filePath: string
  /** 头部左侧图标；不传时默认按 filePath 显示 TabCode 的文件格式图标。 */
  icon?: React.ReactNode
  /** 头部文件名右侧的副标题/统计信息（如 "+12 -3" / "1.2 KB"）。 */
  meta?: React.ReactNode
  /** 是否禁用点击行为（filePath 缺失或流式中尚未确定路径时）。 */
  disabled?: boolean
  /** 点击文件名时的自定义行为，默认走 `useFileOpenAction.openInTabCode`。 */
  onTitleClick?: (filePath: string) => void
  /** 卡片头部背景层（默认 BG.header；删除卡片可以传 BG.error 等）。 */
  headerBg?: string
  /** 文件名右侧额外要展示的 badge（流式中、错误等小状态）。 */
  statusBadge?: React.ReactNode
}

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-2 px-3 py-1.5 text-left',
      TEXT.body,
      TEXT_COLOR.secondary,
      'hover:bg-foreground/5 transition-colors',
    )}
  >
    {icon}
    <span className="flex-1">{label}</span>
  </button>
)

/** 菜单浮层——fixed 定位，按按钮下方对齐。 */
const FileCardMenu: React.FC<{
  anchor: { top: number; left: number }
  filePath: string
  onClose: () => void
}> = ({ anchor, filePath, onClose }) => {
  const { t } = useTranslation('chat')
  const { revealInOsFileManager, openWithDefaultApp, copyPath } = useFileOpenAction()

  // ESC / 外部点击关闭：用 scoped listener 让 hot-Space 切走时自动停掉
  const docTarget = typeof document !== 'undefined' ? document : null
  useScopedEventListener<KeyboardEvent>(docTarget, 'keydown', (e) => {
    if (e.key === 'Escape') onClose()
  })
  useScopedEventListener<MouseEvent>(
    docTarget,
    'mousedown',
    (e) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-file-card-menu="true"]')) return
      onClose()
    },
    { capture: true },
  )

  return (
    <div
      data-file-card-menu="true"
      role="menu"
      style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
      }}
      className={cn(
        'z-dropdown min-w-[200px] py-1 rounded-md border shadow-md',
        BORDER.default,
        BG.card,
      )}
    >
      <MenuItem
        icon={<FolderSearch className={cn(ICON_SIZE.sm, TEXT_COLOR.muted)} />}
        label={resolveRevealInOsLabel(t)}
        onClick={() => {
          void revealInOsFileManager(filePath)
          onClose()
        }}
      />
      <MenuItem
        icon={<ExternalLink className={cn(ICON_SIZE.sm, TEXT_COLOR.muted)} />}
        label={t('card.openFile.openWithDefault', { defaultValue: '用系统默认应用打开' })}
        onClick={() => {
          void openWithDefaultApp(filePath)
          onClose()
        }}
      />
      <MenuItem
        icon={<ClipboardCopy className={cn(ICON_SIZE.sm, TEXT_COLOR.muted)} />}
        label={t('card.openFile.copyPath', { defaultValue: '复制路径' })}
        onClick={() => {
          void copyPath(filePath)
          onClose()
        }}
      />
    </div>
  )
}

export const FileCardHeader: React.FC<FileCardHeaderProps> = ({
  filePath,
  icon,
  meta,
  disabled,
  onTitleClick,
  headerBg,
  statusBadge,
}) => {
  const { openInTabCode } = useFileOpenAction()
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null)
  const fileName = filePath ? basename(filePath) : ''
  const headerIcon = icon ?? (
    <FileIcon
      fileName={fileName}
      className={cn(ICON_SIZE.lg, 'shrink-0')}
    />
  )

  const handleTitleClick = useCallback(() => {
    if (disabled || !filePath) return
    if (onTitleClick) {
      onTitleClick(filePath)
    } else {
      openInTabCode(filePath)
    }
  }, [disabled, filePath, onTitleClick, openInTabCode])

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !filePath) return
    e.preventDefault()
    setMenuAnchor({
      top: e.clientY,
      left: Math.max(8, Math.min(e.clientX, window.innerWidth - 220)),
    })
  }, [disabled, filePath])

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5',
        CARD_HEADER_PADDING.x,
        CARD_HEADER_PADDING.y,
        headerBg ?? BG.header,
        'border-b',
        BORDER.subtle,
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      {headerIcon}
      <button
        type="button"
        onClick={handleTitleClick}
        disabled={disabled || !filePath}
        title={filePath || ''}
        className={cn(
          TEXT.code,
          TEXT_COLOR.secondary,
          'min-w-0 flex-1 truncate text-left',
          !disabled && filePath && 'hover:underline cursor-pointer',
          disabled && 'cursor-default',
        )}
      >
        {fileName}
      </button>
      {statusBadge}
      {meta && <span className="ml-1 shrink-0">{meta}</span>}
      {menuAnchor && filePath && (
        <FileCardMenu
          anchor={menuAnchor}
          filePath={filePath}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  )
}

FileCardHeader.displayName = 'FileCardHeader'
