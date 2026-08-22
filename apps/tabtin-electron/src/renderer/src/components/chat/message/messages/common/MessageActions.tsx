import React, { useState, useCallback, useMemo } from 'react'
import { cn } from '@utils/cn'
import { Check, Copy, GitFork, Undo2, Pencil, AlertTriangle, Loader2, Package, RotateCcw, Reply } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import { safeCopyToClipboard } from '../../../utils/clipboard'
import { isTextSummaryPlaceholder } from '@/utils/contentBlockSummary'
import { ChatIconTooltip } from '../../../panel/ChatIconTooltip'

const ACTION_BUTTON_CLASS = 'inline-flex items-center rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors'

interface IconActionButtonProps {
  title: string
  ariaLabel?: string
  onClick: () => void
  icon: LucideIcon
}

function IconActionButton({ title, ariaLabel, onClick, icon: Icon }: IconActionButtonProps) {
  const accessibleName = ariaLabel ?? title
  return (
    <ChatIconTooltip content={title}>
      <button
        type="button"
        onClick={onClick}
        className={ACTION_BUTTON_CLASS}
        aria-label={accessibleName}
      >
        <Icon className="h-3 w-3" />
      </button>
    </ChatIconTooltip>
  )
}

function DisabledRollbackAction({ title, warning }: { title: string; warning: boolean }) {
  return (
    <ChatIconTooltip content={title}>
      <span
        className={cn(
          'inline-flex items-center rounded-md px-1.5 py-0.5 cursor-not-allowed',
          warning ? 'gap-0.5 text-warning' : 'text-muted-foreground/60',
        )}
        aria-label={title}
      >
        {warning && <AlertTriangle className="h-3 w-3" />}
        <Undo2 className="h-3 w-3" />
      </span>
    </ChatIconTooltip>
  )
}

function AgentRunRollbackAction({
  title,
  rollingBack,
  onClick,
}: {
  title: string
  rollingBack?: boolean
  onClick: () => void
}) {
  return (
    <ChatIconTooltip content={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={rollingBack}
        className={cn(
          'inline-flex items-center rounded-md px-1.5 py-0.5 transition-colors',
          rollingBack
            ? 'text-muted-foreground/40 cursor-not-allowed'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/30',
        )}
        aria-label={title}
      >
        {rollingBack
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Package className="h-3 w-3" />
        }
      </button>
    </ChatIconTooltip>
  )
}

function CopyActionButton({
  copied,
  isPlaceholderOnly,
  onCopy,
  label,
  copiedLabel,
  disabledLabel,
}: {
  copied: boolean
  isPlaceholderOnly: boolean
  onCopy: () => void
  label: string
  copiedLabel: string
  disabledLabel: string
}) {
  const title = copied ? copiedLabel : isPlaceholderOnly ? disabledLabel : label

  return (
    <ChatIconTooltip content={title}>
      <button
        type="button"
        onClick={onCopy}
        className={cn(
          'inline-flex items-center rounded-md px-1.5 py-0.5 transition-all duration-200',
          copied
            ? 'text-success'
            : isPlaceholderOnly
              ? 'text-muted-foreground/40 cursor-not-allowed hover:bg-transparent'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/30',
        )}
        aria-label={title}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </ChatIconTooltip>
  )
}

export const MessageActions: React.FC<{
  content: string
  copyContent?: string
  isUser?: boolean
  canEdit?: boolean
  onEdit?: () => void
  showRollback?: boolean
  showRollbackDisabled?: boolean
  showRollbackWarning?: boolean
  rollbackTitle?: string
  rollbackDisabledTitle?: string
  rollbackWarningTitle?: string
  onRollback?: () => void
  showAgentRunRollback?: boolean
  agentRunRollingBack?: boolean
  onAgentRunRollback?: () => void
  onFork?: () => void
  forkWholeSession?: boolean
  onRegenerate?: () => void
  /**  引用回复：点击后把本条消息设为 composer 的引用目标。 */
  onReply?: () => void
  showCopy?: boolean
}> = ({
  content,
  copyContent,
  isUser,
  canEdit,
  onEdit,
  showRollback,
  showRollbackDisabled,
  showRollbackWarning,
  rollbackTitle,
  rollbackDisabledTitle,
  rollbackWarningTitle,
  onRollback,
  showAgentRunRollback,
  agentRunRollingBack,
  onAgentRunRollback,
  onFork,
  forkWholeSession = false,
  onRegenerate,
  onReply,
  showCopy = true,
// eslint-disable-next-line complexity -- 动作栏按权限和消息类型组合展示，按钮细节已拆到小组件。
}) => {
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation('chat')

  const editTitle = t('checkpoint.edit')
  const regenerateTitle = t('messageActions.regenerate', { defaultValue: '重新生成' })
  const regenerateTooltip = t('messageActions.regenerateTooltip', { defaultValue: '重新生成回复，将重新执行上一条指令' })
  const replyTitle = t('messageActions.reply', { defaultValue: '引用回复' })
  const rollbackTooltip = rollbackTitle || t('checkpoint.rollbackToThisTooltip', {
    defaultValue: '回退对话到此处：移除之后的消息，并恢复工作区文件与资源',
  })
  const rollbackWarningTooltip = rollbackWarningTitle || t('checkpoint.createFailedHint', {
    defaultValue: '自动备份创建失败，回退功能暂不可用。可尝试重新发送消息。',
  })
  const rollbackDisabledTooltip = rollbackDisabledTitle || t('checkpoint.noCheckpointTooltip', {
    defaultValue: '此消息没有可用版本点，无法回退文件或资源',
  })
  const agentRunRollbackTooltip = t('checkpoint.rollbackAgentRunTooltip', {
    defaultValue: '撤销本轮 AI 对文档、表格等资源的改动（对话消息不受影响）',
  })
  const copiedLabel = t('common.copied')
  const copyLabel = t('common.copy')
  const copyDisabledLabel = t('messageActions.copyDisabledPlaceholder', {
    defaultValue: '此消息没有可复制的文字内容（仅包含工具调用 / 富内容）',
  })

  const forkAriaTitle = useMemo(
    () => (onFork
      ? forkWholeSession
        ? t('sharedPane.forkWizardTitle', { defaultValue: '复制到我的任务' })
        : `${t('session.forkFromHere')} — ${t('session.forkFromHereHint')}`
      : ''),
    [forkWholeSession, onFork, t],
  )

  // 纯非 text 消息（譬如 assistant 一轮只调用工具不写一句话），content 派生
  // 出来是 `deriveTextSummary` 的占位文案 `[工具调用]/[富内容]/[思考中]`。
  // 这些字面值复制给用户毫无意义——按钮置灰 + tooltip 改成"无可复制文字"，
  // 用户能看到 footer 但不会点击后剪贴板里突然多个 `[工具调用]`。
  const effectiveCopyContent = copyContent ?? content
  const isPlaceholderOnly = isTextSummaryPlaceholder(effectiveCopyContent)

  const handleCopy = useCallback(() => {
    if (isPlaceholderOnly) {
      toast({
        title: t('messageActions.copyEmpty', {
          defaultValue: '此消息没有可复制的文字内容',
        }),
        duration: 2500,
      })
      return
    }
    safeCopyToClipboard(effectiveCopyContent, () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [effectiveCopyContent, isPlaceholderOnly, t])

  return (
    <div
      data-testid="message-actions"
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity',
        'opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/msg:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/msg:opacity-100',
      )}
    >
      {isUser && canEdit && onEdit && (
        <IconActionButton title={editTitle} onClick={onEdit} icon={Pencil} />
      )}
      {!isUser && onRegenerate && (
        <IconActionButton
          title={regenerateTooltip}
          ariaLabel={regenerateTitle}
          onClick={onRegenerate}
          icon={RotateCcw}
        />
      )}
      {showRollback && onRollback && (
        <IconActionButton title={rollbackTooltip} onClick={onRollback} icon={Undo2} />
      )}
      {!showRollback && showRollbackWarning && (
        <DisabledRollbackAction title={rollbackWarningTooltip} warning />
      )}
      {!showRollback && !showRollbackWarning && showRollbackDisabled && (
        <DisabledRollbackAction title={rollbackDisabledTooltip} warning={false} />
      )}
      {showAgentRunRollback && onAgentRunRollback && (
        <AgentRunRollbackAction
          title={agentRunRollbackTooltip}
          rollingBack={agentRunRollingBack}
          onClick={onAgentRunRollback}
        />
      )}
      {onReply && (
        <IconActionButton title={replyTitle} onClick={onReply} icon={Reply} />
      )}
      {onFork && (
        <IconActionButton title={forkAriaTitle} onClick={onFork} icon={GitFork} />
      )}
      {showCopy && (
        <CopyActionButton
          copied={copied}
          isPlaceholderOnly={isPlaceholderOnly}
          onCopy={handleCopy}
          label={copyLabel}
          copiedLabel={copiedLabel}
          disabledLabel={copyDisabledLabel}
        />
      )}
    </div>
  )
}
