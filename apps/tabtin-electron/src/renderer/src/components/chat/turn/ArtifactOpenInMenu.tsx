/**
 * ArtifactOpenInMenu — create_file 卡与「本轮产物」卡共享的打开动作区。
 *
 * - 遥控端本地文件：禁用占位（不再展开注定失败的菜单）
 * - 共享会话远端 local_file：仅「预览」按钮（当前会话 Tab），无工作区/系统应用；
 *   已知体积超过物化硬顶时禁用并 hover 提示
 * - 本机：可选「预览」（本地 HTML，）+「打开方式」下拉
 *   （工作空间 / 系统应用 / 按 OS 显示 Finder 或文件资源管理器）
 */

import React from 'react'
import { ChevronDown, ExternalLink, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { ArtifactOpenActions } from './useArtifactOpenActions'
import { resolveRevealInOsLabel } from './revealInOsLabel'

interface ArtifactOpenInMenuProps {
  actions: ArtifactOpenActions
  /** 文件类型身份图标（create_file 卡传入分类色图标；产物卡传通用文件图标）。 */
  fileIcon: typeof FolderOpen
  /** oss_file 产物无「系统应用 / Reveal」本地动作，仅保留工作空间打开。 */
  isOssFile?: boolean
  /** 触发按钮附加类名（两张卡的 hover 态略有差异，由调用方注入）。 */
  triggerClassName?: string
  /** 触发按钮点击是否 stopPropagation（卡片整体可点时需要，避免冒泡触发主动作）。 */
  stopPropagation?: boolean
  /** 选中任一项后回调（如「本会话产物」Dialog 打开后自动收起）。 */
  onAction?: () => void
  title: string
}

const actionButtonClassName = cn(
  'inline-flex h-7 shrink-0 items-center rounded-md border border-border/60 px-2',
  'text-caption font-medium text-muted-foreground transition-colors',
  'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
)

export const ArtifactOpenInMenu: React.FC<ArtifactOpenInMenuProps> = ({
  actions,
  fileIcon: FileIcon,
  isOssFile = false,
  triggerClassName,
  stopPropagation = false,
  onAction,
  title,
}) => {
  const { t } = useTranslation('chat')
  const revealLabel = resolveRevealInOsLabel(t)

  if (actions.isRemoteLocalFile) {
    return (
      <span
        className={cn(
          'ml-auto inline-flex h-7 shrink-0 items-center rounded-md border border-border/40 px-2',
          'text-caption font-medium text-muted-foreground/60 cursor-not-allowed select-none',
        )}
        title={actions.remoteUnavailableHint ?? undefined}
        onClick={(e) => { if (stopPropagation) e.stopPropagation() }}
        data-testid="artifact-remote-unavailable"
      >
        {t('turnArtifacts.remotePreviewUnavailable', { defaultValue: '不可预览' })}
      </span>
    )
  }

  const stop = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation()
  }

  // 共享会话远端文件：只保留会话内预览，不暴露工作区 / 系统应用 / Reveal。
  if (actions.isSharedSessionLocalFile) {
    const tooLarge = actions.isSharedPreviewTooLarge
    const disabledHint = actions.sharedPreviewDisabledHint
    // tip 挂外层 span：原生 title 在 disabled button 上部分浏览器不弹出。
    return (
      <div
        className="ml-auto flex shrink-0 items-center gap-1.5"
        onClick={stop}
        data-testid="artifact-shared-preview-only"
      >
        <span
          className={cn('inline-flex', tooLarge && 'cursor-not-allowed')}
          title={tooLarge ? (disabledHint ?? undefined) : undefined}
        >
          <button
            type="button"
            data-testid="artifact-preview"
            disabled={tooLarge}
            aria-disabled={tooLarge || undefined}
            className={cn(
              actionButtonClassName,
              triggerClassName,
              tooLarge && 'pointer-events-none opacity-50 hover:bg-transparent',
            )}
            onClick={() => {
              if (tooLarge) return
              onAction?.()
              void actions.openPrimary()
            }}
            aria-label={
              tooLarge
                ? (disabledHint ?? undefined)
                : t('card.openFile.sharedPreviewAria', {
                    title,
                    defaultValue: '预览 {{title}}',
                  })
            }
          >
            {t('turnArtifacts.preview', { defaultValue: '预览' })}
          </button>
        </span>
      </div>
    )
  }

  return (
    //  / ：外层若有 modal Dialog，内嵌默认 modal 的
    // DropdownMenu 会导致 onSelect/Dialog 收尾竞态。onAction 必须先于异步打开，
    // 否则 RemoveScroll 仍在时 MessageHost toast 的 × 点不到。
    <div
      className="ml-auto flex shrink-0 items-center gap-1.5"
      onClick={stop}
      data-testid="artifact-open-actions"
    >
      {actions.canPrimaryPreview ? (
        <button
          type="button"
          data-testid="artifact-preview"
          className={cn(actionButtonClassName, triggerClassName)}
          onClick={() => { onAction?.(); void actions.openPrimary() }}
        >
          {t('turnArtifacts.preview', { defaultValue: '预览' })}
        </button>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(actionButtonClassName, 'gap-1', triggerClassName)}
            aria-label={t('card.openFile.openInAria', { title, defaultValue: 'Open {{title}} in' })}
          >
            {t('card.openFile.openIn', { defaultValue: 'Open in' })}
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        {/* Portal 内容仍沿 React 树冒泡到整行；阻断后才不会连带触发 openPrimary（双 toast）。 */}
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="w-56"
          onClick={(event) => event.stopPropagation()}
        >
          <DropdownMenuItem onSelect={() => { onAction?.(); actions.openWorkspace() }} className="gap-2">
            <FolderOpen className="h-4 w-4" />
            <span>{t('card.openFile.openInWorkspace', { defaultValue: '工作空间' })}</span>
          </DropdownMenuItem>
          {!isOssFile && (
            <>
              <DropdownMenuItem onSelect={() => { onAction?.(); void actions.openWithSystemApp() }} className="gap-2">
                <FileIcon className="h-4 w-4" />
                <span>{t('card.openFile.systemApp', { defaultValue: 'System app' })}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { onAction?.(); void actions.revealInFinder() }} className="gap-2">
                <ExternalLink className="h-4 w-4" />
                <span>{revealLabel}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
