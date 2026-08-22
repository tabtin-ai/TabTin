import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from '@tabtin/smartsheet-ui'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { TabCodeConfirmDialog } from '../TabCodeConfirmDialog'
import type { GitBranchMeta } from '@shared/git-types'
import { formatGitErrorForToast } from './gitErrorMessage'
import { logGitActionFailure } from '../../utils/gitActionDiagnostics'
import {
  collectCommitMessageContext,
  type CommitDiffScope,
} from './collectStagedCommitContext'
import { generateCommitMessage } from '@/services/tabcodeCommitMessageApi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { createLogger } from '@/utils/logger'
import { ApiError } from '@/services/api'

const log = createLogger('CommitBar')

/** text-body 行高 20px；上下 py-1.5 = 12px；约 10 行后内部滚动 */
const COMMIT_LINE_HEIGHT_PX = 20
const COMMIT_VERTICAL_PADDING_PX = 12
const COMMIT_MAX_ROWS = 10
const COMMIT_MAX_HEIGHT_PX =
  COMMIT_LINE_HEIGHT_PX * COMMIT_MAX_ROWS + COMMIT_VERTICAL_PADDING_PX
const COMMIT_MIN_HEIGHT_PX = COMMIT_LINE_HEIGHT_PX + COMMIT_VERTICAL_PADDING_PX

export interface GitActionPresentation {
  showSuccessToast?: boolean
  formatError?: (error: unknown) => string
}

export interface CommitBarProps {
  rootPath: string
  currentBranchName: string
  branchMeta: GitBranchMeta
  stagedCount: number
  unstagedCount: number
  actionKey: string | null
  runGitAction: (
    key: string,
    action: () => Promise<{
      success: boolean
      error?: string
      skippedPaths?: string[]
      skippedCount?: number
    } | null>,
    successDesc: string,
    presentation?: GitActionPresentation,
  ) => Promise<boolean>
}

export const CommitBar: React.FC<CommitBarProps> = ({
  rootPath,
  currentBranchName,
  branchMeta,
  stagedCount,
  unstagedCount,
  actionKey,
  runGitAction,
}) => {
  const { t } = useTranslation('tabcode')
  const organizationId = useOrganizationStore((s) => s.getEffectiveOrganizationId())
  const [commitMessage, setCommitMessage] = useState('')
  const [confirmStageAll, setConfirmStageAll] = useState(false)
  const [confirmReplaceMessage, setConfirmReplaceMessage] = useState(false)
  const [pendingGeneratedMessage, setPendingGeneratedMessage] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<'commit' | 'commit-and-push' | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const commitMessageRef = useRef(commitMessage)
  commitMessageRef.current = commitMessage

  const syncTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // 先锁 overflow，避免测量时滚动条占位把 scrollHeight 撑大
    el.style.overflowY = 'hidden'
    el.style.height = '0px'
    const contentHeight = el.scrollHeight
    const next = Math.min(
      Math.max(contentHeight, COMMIT_MIN_HEIGHT_PX),
      COMMIT_MAX_HEIGHT_PX,
    )
    el.style.height = `${next}px`
    // 仅撑满上限后才允许内部滚动，空态/未满行不可滚
    el.style.overflowY = next >= COMMIT_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    syncTextareaHeight()
  }, [commitMessage, syncTextareaHeight])

  const doCommit = useCallback(async (showSuccessToast = true): Promise<boolean> => {
    const ok = await runGitAction(
      'commit',
      () => window.tabtin.git.commit(rootPath, commitMessage.trim()),
      t('gitFlow.commitSuccess'),
      { showSuccessToast },
    )
    if (ok) setCommitMessage('')
    return ok
  }, [commitMessage, rootPath, runGitAction, t])

  const doPushAfterCommit = useCallback(async (): Promise<boolean> => {
    const upstream = branchMeta.upstream || ''
    const remote = upstream.includes('/') ? upstream.split('/')[0] : 'origin'
    return runGitAction(
      'push',
      () => window.tabtin.git.push(rootPath, {
        remote,
        branch: currentBranchName || undefined,
        setUpstream: !upstream,
        // Push 只发送已有 commit；未暂存/未跟踪文件不会进入远端内容。
        // 组合操作允许保留这些文件，避免选择性提交成功后被本地 dirty gate 拦截。
        allowDirty: true,
      }),
      t('gitFlow.commitAndPushSuccess'),
      {
        formatError: error => t('gitFlow.commitSucceededPushFailed', {
          reason: formatGitErrorForToast(error, t),
        }),
      },
    )
  }, [branchMeta.upstream, currentBranchName, rootPath, runGitAction, t])

  const guardEmptyMessage = useCallback((): boolean => {
    if (!commitMessage.trim()) {
      toast({ title: t('gitFlow.errorTitle'), description: t('gitFlow.commitMessageRequired') })
      return false
    }
    return true
  }, [commitMessage, t])

  const applyGeneratedMessage = useCallback((message: string) => {
    setCommitMessage(message)
    setPendingGeneratedMessage(null)
    setConfirmReplaceMessage(false)
  }, [])

  const handleGenerateCommitMessage = useCallback(async () => {
    if (isGenerating || Boolean(actionKey) || confirmReplaceMessage) return
    if (stagedCount <= 0 && unstagedCount <= 0) {
      toast({
        title: t('gitFlow.errorTitle'),
        description: t('gitFlow.generateCommitMessageNoChanges'),
      })
      return
    }
    if (!organizationId) {
      toast({
        title: t('gitFlow.errorTitle'),
        description: t('gitFlow.generateCommitMessageNoOrganization'),
      })
      return
    }

    const scope: CommitDiffScope = stagedCount > 0 ? 'staged' : 'workspace'
    setIsGenerating(true)
    log.info('generate commit message start', {
      scope,
      stagedCount,
      unstagedCount,
    })
    try {
      const context = await collectCommitMessageContext(rootPath, scope)
      if (!context.ok) {
        if (context.reason === 'empty') {
          toast({
            title: t('gitFlow.errorTitle'),
            description: t('gitFlow.generateCommitMessageNoChanges'),
          })
        } else if (context.reason === 'sensitive') {
          toast({
            title: t('gitFlow.errorTitle'),
            description: t('gitFlow.generateCommitMessageSensitive'),
          })
        } else {
          log.warn('collect commit message context failed', {
            scope,
            reason: context.reason,
            error: context.error,
          })
          toast({
            title: t('gitFlow.errorTitle'),
            description: t('gitFlow.generateCommitMessageFailed'),
          })
        }
        return
      }

      log.info('generate commit message context ready', {
        scope: context.scope,
        fileCount: context.files.length,
        truncated: context.truncated,
      })

      const { commitMessage: generated } = await generateCommitMessage({
        organizationId,
        files: context.files,
        diffExcerpt: context.diffExcerpt,
        truncated: context.truncated,
      })

      // 以 await 后的最新草稿为准，避免生成期间用户编辑造成误直填/误确认
      if (commitMessageRef.current.trim()) {
        setPendingGeneratedMessage(generated)
        setConfirmReplaceMessage(true)
      } else {
        applyGeneratedMessage(generated)
      }
    } catch (error) {
      log.error('generate commit message failed', {
        organizationId,
        scope,
        status: error instanceof ApiError ? error.status : undefined,
        message: error instanceof Error ? error.message : String(error),
      })
      const description = error instanceof ApiError && error.status === 402
        ? t('gitFlow.generateCommitMessageBudgetExceeded')
        : t('gitFlow.generateCommitMessageFailed')
      toast({ title: t('gitFlow.errorTitle'), description })
    } finally {
      setIsGenerating(false)
    }
  }, [
    actionKey,
    applyGeneratedMessage,
    confirmReplaceMessage,
    isGenerating,
    organizationId,
    rootPath,
    stagedCount,
    t,
    unstagedCount,
  ])

  const handleCommit = useCallback(async () => {
    if (!guardEmptyMessage()) return
    if (stagedCount === 0 && unstagedCount > 0) {
      setPendingAction('commit')
      setConfirmStageAll(true)
      return
    }
    await doCommit()
  }, [doCommit, guardEmptyMessage, stagedCount, unstagedCount])

  const handleCommitAndPush = useCallback(async () => {
    if (!guardEmptyMessage()) return
    if (stagedCount === 0 && unstagedCount > 0) {
      setPendingAction('commit-and-push')
      setConfirmStageAll(true)
      return
    }
    const ok = await doCommit(false)
    if (ok) await doPushAfterCommit()
  }, [doCommit, doPushAfterCommit, guardEmptyMessage, stagedCount, unstagedCount])

  const handleConfirmStageAndCommit = useCallback(async () => {
    const stageResult = await window.tabtin.git.stageFiles(rootPath)
    if (!stageResult?.success) {
      logGitActionFailure('workflow:stage-all-before-commit', rootPath, [], stageResult?.error)
      toast({ title: t('gitFlow.errorTitle'), description: formatGitErrorForToast(stageResult?.error, t) })
      return
    }
    const isCommitAndPush = pendingAction === 'commit-and-push'
    const ok = await doCommit(!isCommitAndPush)
    if (ok && isCommitAndPush) await doPushAfterCommit()
    setPendingAction(null)
  }, [doCommit, doPushAfterCommit, pendingAction, rootPath, t])

  const isCommitting = actionKey === 'commit'
  const isPushing = actionKey === 'push'
  const busy = Boolean(actionKey) || isGenerating
  const generateDisabled = busy || confirmReplaceMessage
  const generateTitle = t('gitFlow.generateCommitMessage')

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void handleCommit()
            }
          }}
          rows={1}
          placeholder={t('gitFlow.commitMessagePlaceholder')}
          className="scrollbar-hidden max-h-[212px] min-h-[32px] w-full min-w-0 resize-none overflow-y-hidden rounded-interactive border border-transparent bg-muted/30 py-1.5 pl-2 pr-9 text-body leading-5 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <span
          className="absolute right-0.5 top-0.5 inline-flex"
          title={generateTitle}
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 px-0 text-muted-foreground hover:text-foreground"
            disabled={generateDisabled}
            onClick={() => void handleGenerateCommitMessage()}
            aria-label={generateTitle}
            title={generateTitle}
          >
            {isGenerating
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Sparkles className="h-3.5 w-3.5" />}
          </Button>
        </span>
      </div>
      <div className="flex h-8 w-full min-w-0 items-stretch rounded-interactive shadow-sm">
        <Button
          size="sm"
          className="h-8 min-w-0 flex-1 rounded-r-none px-2 text-body"
          disabled={busy}
          onClick={() => void handleCommit()}
          title={`${t('gitFlow.commit')} (⌘⏎)`}
        >
          {isCommitting ? <Loader2 className="mr-1 h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
          <span className="truncate">{t('gitFlow.commit')}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              className="h-8 w-8 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-0"
              disabled={busy}
              aria-label={t('gitFlow.moreCommitActions')}
              title={t('gitFlow.moreCommitActions')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => void handleCommitAndPush()}
            >
              {(isCommitting || isPushing) ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              <span>{t('gitFlow.commitAndPush')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TabCodeConfirmDialog
        open={confirmStageAll}
        onOpenChange={setConfirmStageAll}
        title={t('gitFlow.commitSection')}
        description={t('gitFlow.commitEmptyStaged')}
        confirmLabel={t('gitFlow.stageAll')}
        onConfirm={() => void handleConfirmStageAndCommit()}
      />
      <TabCodeConfirmDialog
        open={confirmReplaceMessage}
        onOpenChange={(open) => {
          setConfirmReplaceMessage(open)
          if (!open) setPendingGeneratedMessage(null)
        }}
        title={t('gitFlow.generateCommitMessage')}
        description={t('gitFlow.confirmReplaceCommitMessage')}
        confirmLabel={t('gitFlow.replaceCommitMessage')}
        onConfirm={() => {
          if (pendingGeneratedMessage) applyGeneratedMessage(pendingGeneratedMessage)
        }}
      />
    </div>
  )
}

export default CommitBar
