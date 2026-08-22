/**
 * Changes 变更中心：连续审阅双栏。
 * 顶栏视图下拉 + 页面级搜索 + 左侧多文件静态只读 Diff + 右侧未提交文件树定位。
 * 默认「最近 Agent 执行」为本轮编辑工具冻结的最终文件 Diff；
 * 「当前变更」为实时工作树；提交历史钻入后与当前变更同构（左连续 Diff + 右只读文件树）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  History,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Search,
  X,
} from 'lucide-react'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { useChatStore } from '@stores/chat/useChatStore'
import { useGitWorkflowData } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { formatGitErrorForToast } from '@components/tabcode/components/git-workflow/gitErrorMessage'
import { logGitActionFailure } from '@components/tabcode/utils/gitActionDiagnostics'
import { useGitStatus } from '@components/tabcode/hooks/useGitStatus'
import { TabCodeConfirmDialog } from '@components/tabcode/components/TabCodeConfirmDialog'
import type { GitCommitDetailResult, GitCommitListItem } from '@shared/git-types'
import type { GitLogFailureReason } from '@shared/git-log-errors'
import {
  collectLatestTurnEditorFinals,
  getLatestClosedTurnEndMessageIdForCodeRoot,
} from './agentTurnEditorOps'
import { useFileEditPatchJournalStore } from './fileEditPatchJournalStore'
import {
  CODE_CHANGES_TAB_TYPE,
  DEFAULT_CODE_CHANGES_VIEW,
  type CodeChangesViewId,
} from './codeWorkspaceTab'
import { checkoutSessionBranch } from './checkoutSessionBranch'
import {
  ChangesFileTree,
  type ChangesFileSelection,
} from './ChangesFileTree'
import { ContinuousChangesDiff } from './ContinuousChangesDiff'
import {
  buildCommitContentRevisions,
  collectAgentFrozenDiffs,
  filterFilesForChangesView,
  joinRootPath,
  mapCommitFilesToChangeFiles,
  mapEditorTurnFinalsToChangeFiles,
  normalizeLiveView,
  resolveNavigationAnchor,
} from './changesViewModel'
import { useChangesPageSearch } from './useChangesPageSearch'

export interface CodeChangesPaneProps {
  rootPath: string
  spaceId?: string | null
  sessionId?: string | null
  tabScopeKey?: string | null
  initialView?: CodeChangesViewId
  agentTurnEndMessageId?: string | null
  requestedView?: CodeChangesViewId
  requestedRelativePath?: string | null
  viewIntentId?: string | null
}

const VIEW_OPTIONS: CodeChangesViewId[] = [
  'agent',
  'uncommitted',
  'history',
]

/** Changes 右侧文件树：flex 占位调宽，不遮盖左侧 Diff */
const CHANGES_TREE_MIN_WIDTH = 200
const CHANGES_TREE_MAX_WIDTH = 480
const CHANGES_TREE_DEFAULT_WIDTH = 288

function clampChangesTreeWidth(width: number): number {
  return Math.max(CHANGES_TREE_MIN_WIDTH, Math.min(CHANGES_TREE_MAX_WIDTH, Math.round(width)))
}

export const CodeChangesPane: React.FC<CodeChangesPaneProps> = ({
  rootPath,
  sessionId,
  initialView = DEFAULT_CODE_CHANGES_VIEW,
  agentTurnEndMessageId,
  requestedView,
  requestedRelativePath,
  viewIntentId,
}) => {
  const { t } = useTranslation('context')
  const { t: tTabcode } = useTranslation('tabcode')
  // 只在新建/重建标签时采用 initialView；后续 props 变化不覆盖用户已切的视图。
  const [view, setView] = useState<CodeChangesViewId>(
    normalizeLiveView(initialView || DEFAULT_CODE_CHANGES_VIEW),
  )
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [confirmStashBranch, setConfirmStashBranch] = useState<string | null>(null)
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const [treeWidth, setTreeWidth] = useState(CHANGES_TREE_DEFAULT_WIDTH)
  const [isTreeResizing, setIsTreeResizing] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const treeResizeCleanupRef = useRef<(() => void) | null>(null)
  /** 用户主动点选文件后为 true；阻止自动锚点跳过「无行级 Diff」文件时的静默改选 */
  const userSelectedPathRef = useRef(false)
  /** 标签跳转要求的文件可能在异步数据到达前尚不存在，先保留一次待处理路径。 */
  const pendingRequestedPathRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      treeResizeCleanupRef.current?.()
      treeResizeCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!viewIntentId || !requestedView) return
    const nextRequestedPath = requestedRelativePath?.trim() || null
    pendingRequestedPathRef.current = nextRequestedPath
    userSelectedPathRef.current = false
    setSelectedRelativePath(nextRequestedPath)
    setView(normalizeLiveView(requestedView))
  }, [requestedRelativePath, requestedView, viewIntentId])

  const handleTreeResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    treeResizeCleanupRef.current?.()
    setIsTreeResizing(true)
    const startX = event.clientX
    const startWidth = treeWidth

    const onMouseMove = (moveEvent: MouseEvent) => {
      // 右侧栏：向左拖加宽，向右拖收窄；宽度变化会挤占左侧 Diff
      setTreeWidth(clampChangesTreeWidth(startWidth - (moveEvent.clientX - startX)))
    }
    const cleanup = () => {
      setIsTreeResizing(false)
      treeResizeCleanupRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', cleanup, true)
      window.removeEventListener('blur', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    treeResizeCleanupRef.current = cleanup
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', cleanup, true)
    window.addEventListener('blur', cleanup)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [treeWidth])

  const {
    branch,
    gitStatus,
    stagedStatus,
    unstagedStatus,
    isGitRepo,
    isLoading: statusLoading,
    statusRevision,
    contentRevisions,
    refresh,
  } = useGitStatus(rootPath, { assumeRepo: true })

  const stagedCount = stagedStatus.size
  const unstagedCount = unstagedStatus.size
  const dirtyFileCount = gitStatus.size
  const untrackedCount = useMemo(() => {
    let count = 0
    for (const status of gitStatus.values()) {
      if (status === '?') count += 1
    }
    return count
  }, [gitStatus])

  const data = useGitWorkflowData({
    rootPath,
    currentBranch: branch,
    enabled: isGitRepo,
    refreshToken: statusRevision,
    mode: 'changes',
  })

  const messages = useChatStore((s) =>
    sessionId ? s.messagesBySessionId[sessionId] : undefined,
  )
  const loadEditorJournal = useFileEditPatchJournalStore((s) => s.load)
  const editorJournalRecords = useFileEditPatchJournalStore((s) =>
    sessionId ? s.byThread[sessionId] : undefined,
  )

  useEffect(() => {
    if (!sessionId) return
    void loadEditorJournal(sessionId)
  }, [sessionId, messages, loadEditorJournal])

  const resolvedAgentTurnEndMessageId = useMemo(
    () => agentTurnEndMessageId ?? getLatestClosedTurnEndMessageIdForCodeRoot(
      messages,
      editorJournalRecords,
      rootPath,
    ),
    [agentTurnEndMessageId, messages, editorJournalRecords, rootPath],
  )
  const editorFinalFiles = useMemo(
    () => collectLatestTurnEditorFinals(
      messages,
      editorJournalRecords,
      rootPath,
      resolvedAgentTurnEndMessageId,
    ),
    [messages, editorJournalRecords, rootPath, resolvedAgentTurnEndMessageId],
  )
  const agentChangeFiles = useMemo(
    () => mapEditorTurnFinalsToChangeFiles(editorFinalFiles),
    [editorFinalFiles],
  )
  const agentFrozenDiffs = useMemo(
    () => collectAgentFrozenDiffs(editorFinalFiles),
    [editorFinalFiles],
  )

  const runGitAction = useCallback(
    async (
      key: string,
      action: () => Promise<{
        success: boolean
        error?: string
        skippedPaths?: string[]
        skippedCount?: number
      } | null>,
      successDesc: string,
      presentation?: { showSuccessToast?: boolean },
    ) => {
      setActionKey(key)
      try {
        const result = await action()
        if (result?.success) {
          try {
            // refresh → statusRevision → useGitWorkflowData 自动 loadData，避免双刷
            refresh()
          } catch (refreshError) {
            logGitActionFailure(`changes:${key}:refresh`, rootPath, [], refreshError)
          }
          if (presentation?.showSuccessToast !== false) {
            toast({ title: tTabcode('gitFlow.successTitle'), description: successDesc })
          }
          return true
        }
        logGitActionFailure(`changes:${key}`, rootPath, [], result?.error)
        toast({
          title: tTabcode('gitFlow.errorTitle'),
          description: formatGitErrorForToast(result, tTabcode),
        })
        return false
      } catch (error) {
        logGitActionFailure(`changes:${key}`, rootPath, [], error)
        toast({
          title: tTabcode('gitFlow.errorTitle'),
          description: formatGitErrorForToast(error, tTabcode),
        })
        return false
      } finally {
        setActionKey(null)
      }
    },
    [refresh, rootPath, tTabcode],
  )

  const liveFiles = useMemo(
    () => filterFilesForChangesView(data.files, 'uncommitted'),
    [data.files],
  )
  const isLiveView = view === 'uncommitted'
  const showAgentReview = view === 'agent' && editorFinalFiles.length > 0
  const showDualPane = isLiveView || showAgentReview
  const dualPaneFiles = showAgentReview ? agentChangeFiles : liveFiles
  const pageSearch = useChangesPageSearch({
    rootPath,
    files: liveFiles,
    contentRevisions,
    enabled: isLiveView,
  })

  useEffect(() => {
    if (view === 'history' || (view === 'agent' && editorFinalFiles.length === 0)) {
      pendingRequestedPathRef.current = null
      userSelectedPathRef.current = false
      setSelectedRelativePath(null)
      return
    }
    const files = view === 'agent' ? agentChangeFiles : liveFiles
    setSelectedRelativePath((prev) => {
      const pendingPath = pendingRequestedPathRef.current
      if (pendingPath) {
        if (files.length === 0) return pendingPath
        pendingRequestedPathRef.current = null
        const normalizedPendingPath = pendingPath.replace(/\\/g, '/').replace(/^\.\//, '')
        const requestedFile = files.find((file) => (
          file.path.replace(/\\/g, '/').replace(/^\.\//, '') === normalizedPendingPath
        ))
        if (requestedFile) return requestedFile.path
        userSelectedPathRef.current = false
        return resolveNavigationAnchor(files, null)
      }
      const next = resolveNavigationAnchor(files, prev)
      if (next !== prev) userSelectedPathRef.current = false
      return next
    })
  }, [liveFiles, agentChangeFiles, editorFinalFiles.length, view])

  useEffect(() => {
    if (!isLiveView || !pageSearch.searchHit?.path) return
    userSelectedPathRef.current = true
    setSelectedRelativePath(pageSearch.searchHit.path)
  }, [isLiveView, pageSearch.searchHit?.path, pageSearch.searchHit?.requestId])

  const handleCheckoutBranch = useCallback(
    async (nextBranch: string, confirmedStash = false) => {
      try {
        const result = await checkoutSessionBranch({
          rootPath,
          branch: nextBranch,
          stagedCount,
          unstagedCount,
          dirtyFileCount,
          untrackedCount,
          confirmedStash,
          t: tTabcode,
        })
        if (result.needsStashConfirm) {
          setConfirmStashBranch(nextBranch)
          return
        }
        if (!result.success) {
          logGitActionFailure(
            result.phase === 'checkout-after-stash'
              ? 'code-changes:checkout-after-stash'
              : result.phase === 'stash'
                ? 'code-changes:stash-before-checkout'
                : 'code-changes:checkout-branch',
            rootPath,
            [],
            result.error,
          )
          toast({
            title: tTabcode('gitFlow.errorTitle'),
            description: formatGitErrorForToast(result.error, tTabcode) || tTabcode('gitFlow.errorTitle'),
          })
          return
        }
        setConfirmStashBranch(null)
        setSelectedRelativePath(null)
        // refresh → statusRevision → 轻量 files；分支列表单独补齐，避免再叠一次全量 loadData
        refresh()
        await data.ensureBranchContext()
        toast({
          title: tTabcode('gitFlow.successTitle'),
          description: tTabcode('gitFlow.checkoutSuccess', { branch: nextBranch }),
        })
      } catch (error) {
        logGitActionFailure('code-changes:checkout-branch', rootPath, [], error)
        toast({
          title: tTabcode('gitFlow.errorTitle'),
          description: formatGitErrorForToast(error, tTabcode),
        })
      }
    },
    [rootPath, stagedCount, unstagedCount, dirtyFileCount, untrackedCount, tTabcode, refresh, data],
  )

  const handleSelectFile = useCallback((next: ChangesFileSelection) => {
    pendingRequestedPathRef.current = null
    userSelectedPathRef.current = true
    setSelectedRelativePath(next.relativePath)
  }, [])

  const handlePreferVisibleSelection = useCallback((relativePath: string) => {
    if (userSelectedPathRef.current) return
    setSelectedRelativePath((prev) => (prev === relativePath ? prev : relativePath))
  }, [])

  const branchOptions = data.branchNames.length
    ? data.branchNames
    : branch
      ? [branch]
      : []

  if (!rootPath.trim()) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-body text-muted-foreground">
          {t('codeWorkspace.noRoot', { defaultValue: '未绑定代码根' })}
        </p>
      </div>
    )
  }

  if (!isGitRepo && !statusLoading) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="text-body text-muted-foreground">
          {t('codeWorkspace.notGitRepo', {
            defaultValue: '当前代码根不是 Git 仓库，无法打开变更中心。',
          })}
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="code-changes-pane"
      data-tab-type={CODE_CHANGES_TAB_TYPE}
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <Select
          value={view}
          onValueChange={(value) => setView(normalizeLiveView(value as CodeChangesViewId))}
        >
          <SelectTrigger
            className="h-7 w-[160px] text-body"
            aria-label={t('codeWorkspace.viewSelect', { defaultValue: '变更视图' })}
            data-testid="changes-view-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEW_OPTIONS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`codeWorkspace.views.${id}`, { defaultValue: id })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Popover
          open={branchOpen}
          onOpenChange={(open) => {
            if (Boolean(actionKey) && open) return
            setBranchOpen(open)
            if (open) void data.ensureBranchContext()
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 max-w-[220px] min-w-[120px] items-center gap-1 rounded-md border border-border/50 bg-background px-2 text-body',
                'hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-50',
              )}
              disabled={Boolean(actionKey) || branchOptions.length === 0}
              aria-expanded={branchOpen}
              aria-haspopup="listbox"
              aria-label={t('codeWorkspace.branch', { defaultValue: '分支' })}
              data-testid="changes-branch-select"
              title={branch || undefined}
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {branch || t('codeWorkspace.branch', { defaultValue: '分支' })}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[280px] p-0"
            data-testid="changes-branch-popover"
            onOpenAutoFocus={(event) => {
              const root = event.currentTarget as HTMLElement
              const input = root.querySelector('input')
              if (input instanceof HTMLInputElement) {
                event.preventDefault()
                input.focus()
              }
            }}
          >
            <Command>
              <CommandInput
                placeholder={t('codeWorkspace.searchBranches', {
                  defaultValue: '搜索分支…',
                })}
                containerClassName="h-9 focus-within:!outline-none focus-within:!ring-0 focus-within:!ring-offset-0"
                className="!outline-none !ring-0 !ring-offset-0 focus:!outline-none focus:!ring-0 focus:!ring-offset-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0"
              />
              <CommandList className="max-h-56">
                <CommandEmpty>
                  {t('codeWorkspace.noMatchingBranches', {
                    defaultValue: '没有匹配的分支',
                  })}
                </CommandEmpty>
                <CommandGroup>
                  {branchOptions.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      disabled={Boolean(actionKey)}
                      title={name}
                      onSelect={() => {
                        setBranchOpen(false)
                        if (!actionKey && name !== branch) {
                          void handleCheckoutBranch(name)
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          name === branch ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground/70" title={rootPath}>
          {rootPath}
        </span>

        {isLiveView ? (
          <div
            className="flex h-7 min-w-[180px] max-w-[320px] shrink items-center gap-1 rounded-md border border-border/50 bg-background px-1.5"
            data-testid="changes-page-search"
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={pageSearch.query}
              onChange={(event) => pageSearch.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (event.shiftKey) pageSearch.goPrev()
                  else pageSearch.goNext()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  pageSearch.clear()
                }
              }}
              placeholder={t('codeWorkspace.searchDiffs', {
                defaultValue: '搜索变更…',
              })}
              aria-label={t('codeWorkspace.searchDiffs', {
                defaultValue: '搜索变更…',
              })}
              className="h-full min-w-0 flex-1 bg-transparent text-caption outline-none placeholder:text-muted-foreground/60"
              data-testid="changes-page-search-input"
            />
            {pageSearch.hasQuery ? (
              <span
                className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
                data-testid="changes-page-search-status"
              >
                {pageSearch.isIndexing
                  ? t('codeWorkspace.searchIndexing', {
                      defaultValue: '索引中 {{done}}/{{total}}',
                      done: pageSearch.progress.done,
                      total: pageSearch.progress.total,
                    })
                  : pageSearch.hits.length === 0
                    ? t('codeWorkspace.searchNoMatches', {
                        defaultValue: '无匹配',
                      })
                    : t('codeWorkspace.searchMatchCount', {
                        defaultValue: '{{current}}/{{total}}',
                        current: pageSearch.activeIndex + 1,
                        total: pageSearch.hits.length,
                      })}
              </span>
            ) : null}
            {pageSearch.hasQuery && !pageSearch.isIndexing && pageSearch.errorFileCount > 0 ? (
              <span
                className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline"
                title={t('codeWorkspace.searchSkippedHint', {
                  defaultValue: '{{skipped}} 个文件无法索引（过大/二进制/读取失败）',
                  skipped: pageSearch.skippedFileCount + pageSearch.errorFileCount,
                })}
              >
                {t('codeWorkspace.searchSkippedShort', {
                  defaultValue: '跳过 {{count}}',
                  count: pageSearch.skippedFileCount + pageSearch.errorFileCount,
                })}
              </span>
            ) : null}
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
              disabled={!pageSearch.hasQuery || pageSearch.hits.length === 0}
              onClick={pageSearch.goPrev}
              aria-label={t('codeWorkspace.searchPrev', { defaultValue: '上一处匹配' })}
              data-testid="changes-page-search-prev"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
              disabled={!pageSearch.hasQuery || pageSearch.hits.length === 0}
              onClick={pageSearch.goNext}
              aria-label={t('codeWorkspace.searchNext', { defaultValue: '下一处匹配' })}
              data-testid="changes-page-search-next"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {pageSearch.hasQuery ? (
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                onClick={pageSearch.clear}
                aria-label={t('codeWorkspace.searchClear', { defaultValue: '清除搜索' })}
                data-testid="changes-page-search-clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        {showDualPane ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2 text-caption text-muted-foreground hover:bg-muted/40"
            onClick={() => setTreeOpen((v) => !v)}
            aria-pressed={treeOpen}
            aria-label={treeOpen
              ? t('codeWorkspace.hideFileTree', { defaultValue: '收起文件树' })
              : t('codeWorkspace.showFileTree', { defaultValue: '展开文件树' })}
            data-testid="changes-tree-toggle"
          >
            {treeOpen
              ? <PanelRightClose className="h-3.5 w-3.5" />
              : <PanelRightOpen className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">
              {treeOpen
                ? t('codeWorkspace.hideFileTree', { defaultValue: '收起文件树' })
                : t('codeWorkspace.showFileTree', { defaultValue: '展开文件树' })}
            </span>
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {showDualPane ? (
          <>
            <div
              className="relative z-0 isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              data-testid={showAgentReview ? 'changes-agent-ops' : 'changes-diff-column'}
            >
              {showAgentReview ? (
                <div className="shrink-0 border-b border-border/30 px-3 py-1.5 text-caption text-muted-foreground">
                  {t('codeWorkspace.agentEditorHint', {
                    defaultValue: '本轮agent编辑工具造成的最终差异（不含终端改动与之后的手改）',
                  })}
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">
              <ContinuousChangesDiff
                rootPath={rootPath}
                files={dualPaneFiles}
                selectedRelativePath={selectedRelativePath}
                contentRevisions={
                  showAgentReview ? agentFrozenDiffs.contentRevisions : contentRevisions
                }
                searchHit={isLiveView ? pageSearch.searchHit : undefined}
                onPreferVisibleSelection={handlePreferVisibleSelection}
                isBootstrapping={
                  isLiveView
                  && (
                    statusRevision === 0
                    || (data.isLoading && liveFiles.length === 0)
                  )
                }
                frozenTextsByPath={
                  showAgentReview ? agentFrozenDiffs.frozenTextsByPath : undefined
                }
                unreadablePaths={
                  showAgentReview ? agentFrozenDiffs.unreadablePaths : undefined
                }
                unreadableLabel={showAgentReview
                  ? t('codeWorkspace.agentOpUnreadable', {
                      defaultValue:
                        '该文件无法可靠还原（快照不连续、二进制、超限或缺少冻结补丁），不会用当前磁盘内容补猜。',
                    })
                  : undefined}
              />
              </div>
            </div>
            {treeOpen ? (
              <>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={CHANGES_TREE_MIN_WIDTH}
                  aria-valuemax={CHANGES_TREE_MAX_WIDTH}
                  aria-valuenow={treeWidth}
                  aria-label={t('codeWorkspace.resizeFileTree', {
                    defaultValue: '调整文件树宽度',
                  })}
                  data-testid="changes-tree-resize-handle"
                  onMouseDown={handleTreeResizeStart}
                  className={cn(
                    'group relative z-sticky flex w-2 shrink-0 cursor-col-resize justify-center',
                    'before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]',
                  )}
                >
                  <div
                    className={cn(
                      'h-full w-px transition-colors',
                      isTreeResizing ? 'bg-border/80' : 'bg-border/40 group-hover:bg-border/60',
                    )}
                  />
                </div>
                <aside
                  className="relative z-sticky isolate flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/[0.04]"
                  style={{ width: treeWidth }}
                  data-testid="changes-file-tree-panel"
                >
                  <ChangesFileTree
                    rootPath={rootPath}
                    files={dualPaneFiles}
                    selectedPath={
                      selectedRelativePath
                        ? joinRootPath(rootPath, selectedRelativePath)
                        : null
                    }
                    actionKey={showAgentReview ? null : actionKey}
                    isLoading={showAgentReview ? false : (data.isLoading || statusLoading)}
                    readOnly={showAgentReview}
                    onSelect={handleSelectFile}
                    runGitAction={showAgentReview ? undefined : runGitAction}
                  />
                </aside>
              </>
            ) : null}
          </>
        ) : view === 'agent' ? (
          <AgentEditorEmptyView
            dirtyFileCount={dirtyFileCount}
            onShowUncommitted={() => setView('uncommitted')}
          />
        ) : (
          <CommitHistoryView
            rootPath={rootPath}
            refreshToken={statusRevision}
          />
        )}
      </div>

      <TabCodeConfirmDialog
        open={Boolean(confirmStashBranch)}
        onOpenChange={(open) => {
          if (!open) setConfirmStashBranch(null)
        }}
        title={tTabcode('gitFlow.branchSection')}
        description={tTabcode('gitFlow.stashAndCheckout')}
        confirmLabel={t('codeWorkspace.stashAndSwitch', { defaultValue: '暂存并切换' })}
        onConfirm={() => {
          if (confirmStashBranch) void handleCheckoutBranch(confirmStashBranch, true)
        }}
      />
    </div>
  )
}

function AgentEditorEmptyView({
  dirtyFileCount = 0,
  onShowUncommitted,
}: {
  dirtyFileCount?: number
  onShowUncommitted?: () => void
}) {
  const { t } = useTranslation('context')
  const hasLiveDirty = dirtyFileCount > 0
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="changes-agent-empty"
    >
      <p className="text-body text-muted-foreground/80">
        {hasLiveDirty
          ? t('codeWorkspace.agentEmptyWithLiveDirty', {
              defaultValue:
                '本轮没有可展示的编辑工具改动。工作区仍有 {{count}} 个未提交改动，可先在「当前变更」查看。',
              count: dirtyFileCount,
            })
          : t('codeWorkspace.agentEmpty', {
              defaultValue: '还没有可展示的 Agent 编辑。完成一轮 edit_file / write_file / delete_file 后会出现在这里。',
            })}
      </p>
      {hasLiveDirty && onShowUncommitted ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          data-testid="changes-agent-empty-show-uncommitted"
          onClick={onShowUncommitted}
        >
          {t('codeWorkspace.agentEmptyGoUncommitted', {
            defaultValue: '查看当前变更',
          })}
        </Button>
      ) : null}
    </div>
  )
}

type HistoryAsideMode = 'commits' | 'files'

function CommitHistoryView({
  rootPath,
  refreshToken,
}: {
  rootPath: string
  refreshToken: number
}) {
  const { t } = useTranslation('context')
  const [commits, setCommits] = useState<GitCommitListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetailResult | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [asideMode, setAsideMode] = useState<HistoryAsideMode>('commits')
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useState(CHANGES_TREE_DEFAULT_WIDTH)
  const [isTreeResizing, setIsTreeResizing] = useState(false)
  const historyLoadedForRootRef = useRef<string | null>(null)
  const treeResizeCleanupRef = useRef<(() => void) | null>(null)
  const userSelectedPathRef = useRef(false)

  useEffect(() => {
    return () => {
      treeResizeCleanupRef.current?.()
      treeResizeCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const isInitialForRoot = historyLoadedForRootRef.current !== rootPath
      if (isInitialForRoot) {
        setLoading(true)
        setSelectedHash(null)
        setAsideMode('commits')
        setDetail(null)
        userSelectedPathRef.current = false
        setSelectedRelativePath(null)
      }
      setLoadError(null)
      try {
        const result = await window.tabtin?.git?.listCommits?.(rootPath, { limit: 50 })
        if (cancelled) return
        if (!result) {
          setCommits([])
          setLoadError(t('codeWorkspace.historyIpcUnavailable', {
            defaultValue: 'Git 历史接口未就绪，请重启客户端后重试。',
          }))
          return
        }
        if (!result.success) {
          setCommits([])
          const reason = (result as { reason?: GitLogFailureReason }).reason
          if (reason === 'path_not_found') {
            setLoadError(t('codeWorkspace.historyPathMissing', {
              defaultValue: '代码根目录不存在或不是有效目录。',
            }))
          } else if (reason === 'permission_denied') {
            setLoadError(t('codeWorkspace.historyPermissionDenied', {
              defaultValue: '没有读取该代码根的权限。',
            }))
          } else {
            setLoadError(result.error || t('codeWorkspace.historyLoadFailed', {
              defaultValue: '无法加载提交历史',
            }))
          }
          return
        }
        const nextCommits = result.commits || []
        setCommits(nextCommits)
        historyLoadedForRootRef.current = rootPath
        setSelectedHash((prev) => {
          if (prev && nextCommits.some((c) => c.hash === prev)) return prev
          return null
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [rootPath, refreshToken, t])

  useEffect(() => {
    if (!selectedHash) {
      setDetail(null)
      userSelectedPathRef.current = false
      setSelectedRelativePath(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setDetailLoading(true)
      setDetailError(null)
      try {
        const next = await window.tabtin?.git?.getCommitDetail?.(rootPath, {
          commitHash: selectedHash,
        })
        if (cancelled) return
        if (!next?.success) {
          setDetail(null)
          setDetailError(next?.error || t('codeWorkspace.historyDetailFailed', {
            defaultValue: '无法加载提交详情',
          }))
          userSelectedPathRef.current = false
          setSelectedRelativePath(null)
          return
        }
        setDetail(next)
        const mapped = mapCommitFilesToChangeFiles(next.files)
        setSelectedRelativePath((prev) => {
          const nextPath = resolveNavigationAnchor(mapped, prev)
          if (nextPath !== prev) userSelectedPathRef.current = false
          return nextPath
        })
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [rootPath, selectedHash, t])

  const activeDetail = detail?.commit?.hash === selectedHash ? detail : null
  const commitFiles = useMemo(
    () => mapCommitFilesToChangeFiles(activeDetail?.files),
    [activeDetail?.files],
  )
  const contentRevisions = useMemo(
    () => (selectedHash ? buildCommitContentRevisions(commitFiles, selectedHash) : {}),
    [commitFiles, selectedHash],
  )
  const selectedCommit = useMemo(
    () => commits.find((c) => c.hash === selectedHash) || activeDetail?.commit || null,
    [commits, selectedHash, activeDetail?.commit],
  )
  const showingDualPane = Boolean(selectedHash) && asideMode === 'files'

  const handlePickCommit = useCallback((hash: string) => {
    setSelectedHash(hash)
    setAsideMode('files')
  }, [])

  const handleSelectFile = useCallback((next: ChangesFileSelection) => {
    userSelectedPathRef.current = true
    setSelectedRelativePath(next.relativePath)
  }, [])

  const handlePreferVisibleSelection = useCallback((relativePath: string) => {
    if (userSelectedPathRef.current) return
    setSelectedRelativePath((prev) => (prev === relativePath ? prev : relativePath))
  }, [])

  const handleTreeResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    treeResizeCleanupRef.current?.()
    setIsTreeResizing(true)
    const startX = event.clientX
    const startWidth = treeWidth
    const onMouseMove = (moveEvent: MouseEvent) => {
      setTreeWidth(clampChangesTreeWidth(startWidth - (moveEvent.clientX - startX)))
    }
    const cleanup = () => {
      setIsTreeResizing(false)
      treeResizeCleanupRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', cleanup, true)
      window.removeEventListener('blur', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    treeResizeCleanupRef.current = cleanup
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', cleanup, true)
    window.addEventListener('blur', cleanup)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [treeWidth])

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-body text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('codeWorkspace.loadingHistory', { defaultValue: '加载提交历史…' })}
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-center">
        <p className="text-body text-destructive/80">{loadError}</p>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-center">
        <p className="text-body text-muted-foreground/70">
          {t('codeWorkspace.historyEmpty', { defaultValue: '暂无 Git 提交记录。' })}
        </p>
      </div>
    )
  }

  const commitList = (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover" data-testid="commit-history-list">
      <ul className="space-y-0.5 p-1">
        {commits.map((commit) => (
          <li key={commit.hash}>
            <button
              type="button"
              data-testid="commit-history-item"
              className={cn(
                'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left',
                selectedHash === commit.hash
                  ? 'bg-primary/10 ring-1 ring-inset ring-primary/20'
                  : 'hover:bg-muted/40',
              )}
              onClick={() => handlePickCommit(commit.hash)}
            >
              <span className="truncate text-body">{commit.subject}</span>
              <span className="text-caption text-muted-foreground/70">
                <span className="font-mono">{commit.shortHash}</span>
                {' · '}
                {commit.authorName}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="commit-history-view">
      <div
        className="relative z-0 isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="history-diff-column"
      >
        {!selectedHash ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-body text-muted-foreground/60">
            {t('codeWorkspace.pickCommit', {
              defaultValue: '选择右侧一条提交查看变更',
            })}
          </div>
        ) : detailLoading && !activeDetail ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('codeWorkspace.loading', { defaultValue: '读取变更…' })}
          </div>
        ) : detailError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-body text-destructive/80">
            {detailError}
          </div>
        ) : (
          <ContinuousChangesDiff
            rootPath={rootPath}
            files={commitFiles}
            selectedRelativePath={selectedRelativePath}
            contentRevisions={contentRevisions}
            diffMode="commit"
            commitHash={selectedHash}
            onPreferVisibleSelection={handlePreferVisibleSelection}
            isBootstrapping={detailLoading && commitFiles.length === 0}
            emptyLabel={t('codeWorkspace.historyCommitEmpty', {
              defaultValue: '该提交没有可展示的文件变更。',
            })}
          />
        )}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={CHANGES_TREE_MIN_WIDTH}
        aria-valuemax={CHANGES_TREE_MAX_WIDTH}
        aria-valuenow={treeWidth}
        aria-label={t('codeWorkspace.resizeFileTree', {
          defaultValue: '调整文件树宽度',
        })}
        data-testid="history-aside-resize-handle"
        onMouseDown={handleTreeResizeStart}
        className={cn(
          'group relative z-sticky flex w-2 shrink-0 cursor-col-resize justify-center',
          'before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]',
        )}
      >
        <div
          className={cn(
            'h-full w-px transition-colors',
            isTreeResizing ? 'bg-border/80' : 'bg-border/40 group-hover:bg-border/60',
          )}
        />
      </div>

      <aside
        className="relative z-sticky isolate flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/[0.04]"
        style={{ width: treeWidth }}
        data-testid="commit-history-aside"
        data-aside-mode={asideMode}
      >
        {showingDualPane && selectedCommit ? (
          <>
            <div className="shrink-0 border-b border-border/40 px-3 py-2">
              <div className="flex items-start gap-2">
                <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body text-foreground" title={selectedCommit.subject}>
                    {selectedCommit.subject}
                  </p>
                  <p className="truncate text-caption text-muted-foreground/70">
                    <span className="font-mono">{selectedCommit.shortHash}</span>
                    {' · '}
                    {selectedCommit.authorName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="mt-2 inline-flex h-7 w-full items-center justify-center rounded-md border border-border/50 text-caption text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                data-testid="history-change-commit"
                onClick={() => setAsideMode('commits')}
              >
                {t('codeWorkspace.changeCommit', { defaultValue: '更换提交' })}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChangesFileTree
                rootPath={rootPath}
                files={commitFiles}
                selectedPath={
                  selectedRelativePath
                    ? joinRootPath(rootPath, selectedRelativePath)
                    : null
                }
                actionKey={null}
                isLoading={detailLoading}
                readOnly
                onSelect={handleSelectFile}
              />
            </div>
          </>
        ) : (
          <>
            <div className="border-b border-border/40 px-3 py-2 text-caption font-medium text-muted-foreground">
              {t('codeWorkspace.views.history', { defaultValue: '提交历史' })}
            </div>
            {commitList}
          </>
        )}
      </aside>
    </div>
  )
}

export default CodeChangesPane
