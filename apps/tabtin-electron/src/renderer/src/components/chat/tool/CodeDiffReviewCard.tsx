/* eslint-disable tabtin/no-chat-design-violations -- 代码 Diff 的 +/- 颜色是编辑器领域约定。 */
import React, { useCallback, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import { blockExpandKey, useBlockExpanded } from '@stores/chat/presentation/blockUiPrefs'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useFileEditPatchJournalStore } from '@components/context-space/code-workspace/fileEditPatchJournalStore'
import {
  collectClosedAgentTurnReview,
  type ClosedAgentTurnReview,
} from '@components/context-space/code-workspace/agentTurnEditorOps'
import {
  DEFAULT_CODE_CHANGES_VIEW,
  openCodeChangesTab,
} from '@components/context-space/code-workspace/codeWorkspaceTab'
import { joinRootPath } from '@components/context-space/code-workspace/changesViewModel'
import { resolveSessionCodeRoot } from '@/stores/chat/utils/resolveSessionCodeRoot'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'
import { resolveWorkspaceWorkingDir } from '@components/context-space/workspaceExecutionRootApp'
import { useOptionalSpaceContextState } from '@components/context-space/SpaceContextAreaContext'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { useGitStatus } from '@components/tabcode/hooks/useGitStatus'

interface CodeDiffReviewCardProps {
  message: ChatMessage
  timelineMessages?: ChatMessage[]
  sessionId?: string | null
  tabScopeKey?: string | null
  isLastInTurn: boolean
  isStreaming?: boolean
  isMiniMessage: boolean
  isErrorEnvelope: boolean
  includeSubagentMessages?: boolean
  previewMode?: boolean
}

const MAX_VISIBLE_REVIEW_FILES = 5

export const CodeDiffReviewCard: React.FC<CodeDiffReviewCardProps> = React.memo(({
  message,
  timelineMessages,
  sessionId,
  tabScopeKey,
  isLastInTurn,
  isStreaming = false,
  isMiniMessage,
  isErrorEnvelope,
  includeSubagentMessages = false,
  previewMode = false,
}) => {
  const { t } = useTranslation('chat')
  const spaceContext = useOptionalSpaceContextState()
  const contextSpaceId = spaceContext?.spaceId ?? null
  const resolvedTabScopeKey = spaceContext?.tabScopeKey ?? tabScopeKey ?? null

  const selectedSpace = useSpaceStore((state) => state.selectedSpace ?? null)
  const effectiveSpaceId = contextSpaceId ?? selectedSpace?.id ?? null
  const spaceType = useSpaceStore((state) => {
    if (contextSpaceId) {
      return state.spaces.find((item) => item.id === contextSpaceId)?.type ?? null
    }
    return selectedSpace?.type ?? null
  })
  const spaceWorkingDir = useSpaceStore((state) => {
    const space = contextSpaceId
      ? state.spaces.find((item) => item.id === contextSpaceId) ?? null
      : selectedSpace
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    const agent = agentId
      ? state.agentCache[agentId]
        ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
      : null
    return resolveWorkspaceWorkingDir(space, agent)
  })
  // Worktree 切换先更新 session 代码根绑定，再异步协调 Changes / TabCode。
  // 订阅路径和状态，确保 Review Card 不会继续展示旧 worktree 的变更。
  const boundCodeRoot = useSessionBoundCodeRootStore((state) => {
    if (!sessionId) return null
    const binding = state.bindingsBySessionId[sessionId]
    return binding?.status === 'active' ? binding.rootPath : null
  })
  const codeRoot = useMemo(
    () => boundCodeRoot || resolveSessionCodeRoot(sessionId, { spaceWorkingDir }),
    [boundCodeRoot, sessionId, spaceWorkingDir],
  )
  const { isGitRepo, statusRevision } = useGitStatus(codeRoot)
  const gitRepoReady = statusRevision > 0 && isGitRepo
  const journalRecords = useFileEditPatchJournalStore((state) =>
    sessionId ? state.byThread[sessionId] : undefined,
  )
  const loadJournal = useFileEditPatchJournalStore((state) => state.load)

  useEffect(() => {
    if (!sessionId || isStreaming) return
    void loadJournal(sessionId)
  }, [isStreaming, loadJournal, sessionId])

  const review = useMemo<ClosedAgentTurnReview | null>(() => {
    if (
      !timelineMessages
      || !sessionId
      || !codeRoot
      || !gitRepoReady
      || !effectiveSpaceId
      || spaceType === null
      || spaceType === 'team_space'
      || !isLastInTurn
      || isStreaming
      || isMiniMessage
      || isErrorEnvelope
      || includeSubagentMessages
      || previewMode
    ) return null

    const currentReview = collectClosedAgentTurnReview(timelineMessages, journalRecords, codeRoot)
    return currentReview?.turnEndMessageId === message.id ? currentReview : null
  }, [
    codeRoot,
    effectiveSpaceId,
    gitRepoReady,
    includeSubagentMessages,
    isErrorEnvelope,
    isLastInTurn,
    isMiniMessage,
    isStreaming,
    journalRecords,
    message.id,
    previewMode,
    sessionId,
    spaceType,
    timelineMessages,
  ])

  const handleOpen = useCallback(() => {
    if (!review || !sessionId || !codeRoot || !resolvedTabScopeKey || !effectiveSpaceId) return
    expandCanvasForScope(resolvedTabScopeKey)
    openCodeChangesTab({
      tabScopeKey: resolvedTabScopeKey,
      spaceId: effectiveSpaceId,
      rootPath: codeRoot,
      sessionId,
      initialView: DEFAULT_CODE_CHANGES_VIEW,
      agentTurnEndMessageId: review.turnEndMessageId,
      focusView: 'agent',
    })
  }, [codeRoot, effectiveSpaceId, resolvedTabScopeKey, review, sessionId])

  const displayableFiles = useMemo(
    () => review?.files.filter((file) => file.displayable) ?? [],
    [review],
  )
  const displayableTotals = useMemo(
    () => displayableFiles.reduce(
      (totals, file) => ({
        insertions: totals.insertions + file.insertions,
        deletions: totals.deletions + file.deletions,
      }),
      { insertions: 0, deletions: 0 },
    ),
    [displayableFiles],
  )

  const isExpandable = displayableFiles.length > MAX_VISIBLE_REVIEW_FILES
  const reviewExpandKey = blockExpandKey(`review-card:${message.id}`)
  const [expanded, setExpanded] = useBlockExpanded(reviewExpandKey, !isExpandable)
  const visibleFiles = useMemo(
    () => expanded ? displayableFiles : displayableFiles.slice(0, MAX_VISIBLE_REVIEW_FILES),
    [displayableFiles, expanded],
  )
  const fileListId = `code-diff-review-files-${message.id}`
  const remainingFileCount = displayableFiles.length - MAX_VISIBLE_REVIEW_FILES

  const handleToggleExpanded = useCallback(() => {
    setExpanded(!expanded)
  }, [expanded, setExpanded])

  const handleOpenFile = useCallback((relativePath: string) => {
    if (!review || !sessionId || !codeRoot || !resolvedTabScopeKey || !effectiveSpaceId) return
    expandCanvasForScope(resolvedTabScopeKey)
    openCodeChangesTab({
      tabScopeKey: resolvedTabScopeKey,
      spaceId: effectiveSpaceId,
      rootPath: codeRoot,
      sessionId,
      initialView: DEFAULT_CODE_CHANGES_VIEW,
      agentTurnEndMessageId: review.turnEndMessageId,
      focusView: 'agent',
      focusRelativePath: relativePath,
    })
  }, [codeRoot, effectiveSpaceId, resolvedTabScopeKey, review, sessionId])

  if (!review || displayableFiles.length === 0) return null

  const headerSummary = (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <span className="min-w-0 truncate text-caption font-medium text-foreground">
        {t('codeDiffReview.editedFiles', { defaultValue: '已编辑 {{count}} 个文件', count: displayableFiles.length })}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-caption tabular-nums">
        {displayableTotals.insertions > 0 && <span className="text-green-500">+{displayableTotals.insertions}</span>}
        {displayableTotals.deletions > 0 && <span className="text-red-500">-{displayableTotals.deletions}</span>}
      </span>
    </span>
  )

  return (
    <div
      data-testid="code-diff-review-card"
      className="mt-2 w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20"
    >
      <div
        data-testid="code-diff-review-header"
        className="flex min-h-9 w-full items-center gap-2.5 py-2 pl-3 pr-2"
      >
        {headerSummary}
        <button
          type="button"
          data-testid="code-diff-review-review-button"
          className="inline-flex w-12 shrink-0 items-center justify-end text-caption text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          onClick={handleOpen}
          aria-label={t('codeDiffReview.open', { defaultValue: '审阅本轮文件改动' })}
        >
          {t('codeDiffReview.review', { defaultValue: '审阅' })}
        </button>
      </div>

      <div
        id={fileListId}
        data-testid="code-diff-review-file-list"
        className="border-t border-border/40 px-1 py-1"
        role="list"
        aria-label={t('codeDiffReview.fileList', { defaultValue: '已编辑文件' })}
      >
        {visibleFiles.map((file) => (
          <div key={file.relativePath} role="listitem">
            <button
              type="button"
              data-testid="code-diff-review-file"
              className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-left text-caption text-muted-foreground/60 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
              onClick={() => handleOpenFile(file.relativePath)}
              aria-label={t('codeDiffReview.reviewFile', {
                defaultValue: '审阅 {{file}}',
                file: file.relativePath,
              })}
              title={joinRootPath(codeRoot ?? '', file.relativePath)}
            >
              <span
                className={cn(
                  'w-4 shrink-0 text-center text-caption font-semibold leading-4',
                  file.status === 'added'
                    ? 'text-success'
                    : file.status === 'deleted'
                      ? 'text-destructive'
                      : 'text-warning',
                )}
                title={file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}
                aria-label={file.status === 'added' ? '新增文件' : file.status === 'deleted' ? '删除文件' : '修改文件'}
                data-testid="code-diff-review-status"
              >
                {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  file.status === 'deleted' && 'line-through',
                )}
              >
                {file.relativePath}
              </span>
              <span className="flex w-12 shrink-0 justify-end tabular-nums">
                <span className="text-green-500">+{file.insertions}</span>
                <span className="ml-1 text-red-500">-{file.deletions}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
      {isExpandable && (
        <button
          type="button"
          data-testid="code-diff-review-expand-button"
          className="flex w-full items-center gap-1 border-t border-border/40 px-3 py-1.5 text-left text-caption text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none"
          onClick={handleToggleExpanded}
          aria-expanded={expanded}
          aria-controls={fileListId}
          aria-label={t(
            expanded ? 'codeDiffReview.collapseAria' : 'codeDiffReview.expandRemainingAria',
            {
              defaultValue: expanded ? '收起文件' : '展开剩余 {{count}} 个文件',
              count: remainingFileCount,
            },
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
          )}
          {expanded
            ? t('codeDiffReview.collapse', { defaultValue: '收起文件' })
            : t('codeDiffReview.expandRemaining', {
              defaultValue: '展开剩余 {{count}} 个文件',
              count: remainingFileCount,
            })}
        </button>
      )}
    </div>
  )
})

CodeDiffReviewCard.displayName = 'CodeDiffReviewCard'
