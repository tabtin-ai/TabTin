/**
 * PromptCard — IM 指令卡。
 *
 * 卡片自包含 prompt 正文（metadata.card.prompt_text，服务端已限长裁剪），
 * 不指向任何后端资源，因此无需挂载拉详情。折叠态显示正文预览（line-clamp），
 * 点击展开后全文按 Markdown 渲染（复用 IMMessageBubble 的 markdownComponents）。
 *
 * 「使用」→ 先选择 Workspace → applyPromptToNewTask：跳「新任务」欢迎态并把
 * 正文预填进输入框（关闭 IM 面板由 navigateToNewTask 内部处理）；失败 toast reason。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, SquareTerminal, Wand2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from '@tabtin/smartsheet-ui'
import type { SpaceListItem } from '@tabtin/app-shell'
import { applyPromptToNewTask } from '@/services/promptApply'
import { SpaceSwitcherPopover } from '@components/sidebar/SpaceSwitcherPopover'
import { markdownComponents } from './imMarkdownComponents'
import { cn } from '@utils/cn'

interface Props {
  /** 指令正文（服务端已裁剪到 1..8000 字符） */
  promptText: string
  /** 可选标题；无标题时用正文首行 */
  title?: string
}

/** 折叠态预览行数（与 HandoffComposerDialog 的 line-clamp 习惯对齐） */
const PREVIEW_LINE_CLAMP = 'line-clamp-4'

export const PromptCard: React.FC<Props> = ({ promptText, title }) => {
  const { t } = useTranslation('tabchat')
  const [expanded, setExpanded] = useState(false)

  const displayTitle = useMemo(() => {
    const trimmedTitle = (title ?? '').trim()
    if (trimmedTitle) return trimmedTitle
    const firstLine = promptText
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
    return firstLine || t('promptCardTitleFallback', { defaultValue: '指令' })
  }, [promptText, t, title])

  const handleApply = useCallback((workspace: SpaceListItem) => {
    const result = applyPromptToNewTask(promptText, workspace.source_id)
    if (!result.ok) {
      toast({
        title: t('promptApplyFailed', { defaultValue: '无法使用该指令' }),
        description: result.reason,
        variant: 'destructive',
      })
    }
  }, [promptText, t])

  return (
    <div className="w-[320px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-card">
      {/* 头部：类型标识 */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-accent">
          <SquareTerminal className="h-3.5 w-3.5" />
          {t('promptCardBadge', { defaultValue: '指令' })}
        </span>
      </div>

      {/* 标题 */}
      <div className="px-3.5 pb-2 pt-2">
        <div className="text-subtitle font-semibold leading-snug text-foreground">
          {displayTitle}
        </div>
      </div>

      {/* 正文：折叠预览 / 展开全文（Markdown） */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="block w-full px-3.5 pb-2 text-left"
        aria-expanded={expanded}
        title={expanded
          ? t('promptCardCollapse', { defaultValue: '收起' })
          : t('promptCardExpand', { defaultValue: '展开全文' })}
      >
        {expanded ? (
          <div className="prose-sm max-w-none text-body text-foreground/90">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {promptText}
            </ReactMarkdown>
          </div>
        ) : (
          <p className={cn('whitespace-pre-wrap text-body text-foreground/80', PREVIEW_LINE_CLAMP)}>
            {promptText}
          </p>
        )}
        <span className="mt-1 inline-flex items-center gap-0.5 text-caption text-muted-foreground/70">
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              {t('promptCardCollapse', { defaultValue: '收起' })}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              {t('promptCardExpand', { defaultValue: '展开全文' })}
            </>
          )}
        </span>
      </button>

      {/* 主按钮：使用 */}
      <SpaceSwitcherPopover
        currentSpaceId={null}
        onSelectSpace={handleApply}
        side="bottom"
        align="end"
      >
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 border-t border-border/40 py-2.5 text-body font-medium text-accent-foreground transition-colors bg-accent hover:bg-accent/90"
          title={t('promptCardApply', { defaultValue: '使用' })}
        >
          <Wand2 className="h-[1em] w-[1em]" aria-hidden />
          <span>{t('promptCardApply', { defaultValue: '使用此指令' })}</span>
        </button>
      </SpaceSwitcherPopover>
    </div>
  )
}
