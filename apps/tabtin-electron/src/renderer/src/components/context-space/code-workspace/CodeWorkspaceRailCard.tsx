/**
 * 对话聚焦布局右侧「代码工作区」卡片：挂在快捷入口上方。
 * 四行：本轮 Agent 编辑最终增减 → Changes；代码根（文件夹名）→ worktree；分支；提交或推送 → TabCode Git。
 * 非 Git 代码根确认后整卡隐藏；Git 状态刷新保持稳定「变更」文案。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  Diff,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Plus,
} from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { resolveSessionCodeRoot } from '@/stores/chat/utils/resolveSessionCodeRoot'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'
import { useGitStatus } from '@components/tabcode/hooks/useGitStatus'
import { TabCodeConfirmDialog } from '@components/tabcode/components/TabCodeConfirmDialog'
import type { GitWorktreeInfo } from '@shared/git-types'
import { normalizePathForCompare } from '@components/tabcode/utils/worktreePaths'
import { createLogger } from '@/utils/logger'
import { logGitActionFailure } from '@components/tabcode/utils/gitActionDiagnostics'
import { formatGitErrorForToast } from '@components/tabcode/components/git-workflow/gitErrorMessage'
import {
  CANVAS_TEXT_META,
} from '@components/layout/canvasUi'
import {
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { useCanvasRailPortal } from '@components/layout/CanvasRailPortalContext'
import {
  aggregateEditorTurnFinals,
  collectLatestTurnEditorFinals,
  getLatestClosedTurnEndMessageIdForCodeRoot,
} from './agentTurnEditorOps'
import { useFileEditPatchJournalStore } from './fileEditPatchJournalStore'
import { CreateWorktreeDialog } from './CreateWorktreeDialog'
import {
  BIND_REASON_I18N_KEY,
  switchSessionWorktree,
} from './switchSessionWorktree'
import { checkoutSessionBranch } from './checkoutSessionBranch'
import {
  DEFAULT_CODE_CHANGES_VIEW,
  openCodeChangesTab,
  openTabCodeGitPanel,
} from './codeWorkspaceTab'
import {
  resolveWorkspaceWorkingDir,
} from '../workspaceExecutionRootApp'
import { useSpaceContextState } from '../SpaceContextAreaContext'

const log = createLogger('CodeWorkspaceRailCard')

interface CodeWorkspaceRailCardProps {
  expandCanvas: () => void
  sessionId: string | null
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export const CodeWorkspaceRailCard: React.FC<CodeWorkspaceRailCardProps> = ({
  expandCanvas,
  sessionId,
}) => {
  const { t } = useTranslation('context')
  const { t: tTabcode } = useTranslation('tabcode')
  const { iconOnly } = useCanvasRailPortal()
  const { spaceId, tabScopeKey } = useSpaceContextState()

  const spaceWorkingDir = useSpaceStore((state) => {
    const space = state.spaces.find((item) => item.id === spaceId) ?? null
    const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
    const agent = agentId
      ? state.agentCache[agentId]
        ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null)
      : null
    return resolveWorkspaceWorkingDir(space, agent)
  })

  const boundRevision = useSessionBoundCodeRootStore((s) =>
    sessionId ? s.bindingsBySessionId[sessionId]?.revision ?? null : null,
  )
  const codeRoot = useMemo(() => {
    void boundRevision
    return resolveSessionCodeRoot(sessionId, { spaceWorkingDir })
  }, [sessionId, spaceWorkingDir, boundRevision])

  const {
    branch,
    gitStatus,
    stagedStatus,
    unstagedStatus,
    isGitRepo,
    statusRevision,
    refresh,
  } = useGitStatus(codeRoot)

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
  const repoConfirmed = statusRevision > 0
  const showWorkspace = Boolean(codeRoot) && (!repoConfirmed || isGitRepo)

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
  const latestTurnEndMessageId = useMemo(
    () => getLatestClosedTurnEndMessageIdForCodeRoot(
      messages,
      editorJournalRecords,
      codeRoot,
    ),
    [messages, editorJournalRecords, codeRoot],
  )
  const editorFinalFiles = useMemo(
    () => collectLatestTurnEditorFinals(
      messages,
      editorJournalRecords,
      codeRoot,
      latestTurnEndMessageId,
    ),
    [messages, editorJournalRecords, codeRoot, latestTurnEndMessageId],
  )
  const { insertions, deletions } = useMemo(
    () => aggregateEditorTurnFinals(editorFinalFiles),
    [editorFinalFiles],
  )

  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [worktreeListError, setWorktreeListError] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmStashBranch, setConfirmStashBranch] = useState<string | null>(null)
  const pendingStashBranchRef = useRef<string | null>(null)
  const newBranchInputRef = useRef<HTMLInputElement>(null)

  const loadGitLists = useCallback(async () => {
    if (!codeRoot || (repoConfirmed && !isGitRepo)) {
      setWorktrees([])
      setBranches([])
      setWorktreeListError(false)
      return
    }
    const git = window.tabtin?.git
    if (!git) {
      setWorktrees([])
      setBranches([])
      setWorktreeListError(true)
      return
    }
    try {
      const [wt, br] = await Promise.all([
        git.listWorktrees(codeRoot),
        git.listBranches(codeRoot),
      ])
      setWorktreeListError(!wt?.success)
      setWorktrees(wt?.success ? (wt.worktrees || []) : [])
      setBranches(
        br?.success
          ? (br.localBranches || []).map((item: { name: string }) => item.name).filter(Boolean)
          : [],
      )
    } catch (err) {
      log.warn('list worktrees/branches failed', {
        errorType: err instanceof Error ? err.name : typeof err,
      })
      setWorktrees([])
      setBranches([])
      setWorktreeListError(true)
    }
  }, [codeRoot, isGitRepo, repoConfirmed])

  useEffect(() => {
    void loadGitLists()
  }, [loadGitLists])

  // git worktree list 把主工作树排在第一位；其余为关联 worktree。
  const mainWorktrees = useMemo(
    () => (worktrees[0] ? [worktrees[0]] : []),
    [worktrees],
  )
  const linkedWorktrees = useMemo(() => worktrees.slice(1), [worktrees])
  const showLinkedEmpty =
    !worktreeListError && mainWorktrees.length > 0 && linkedWorktrees.length === 0
  const defaultBaseBranch = useMemo(() => {
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    return branches[0] || ''
  }, [branches])

  const currentRootFolderName = useMemo(() => {
    if (!codeRoot) return t('codeWorkspace.noRoot', { defaultValue: '未绑定代码根' })
    return basename(codeRoot)
  }, [codeRoot, t])

  const worktreeBranchLabel = useCallback(
    (item: GitWorktreeInfo) => {
      if (item.isDetached || !item.branch) {
        return t('codeWorkspace.detached', { defaultValue: '分离头指针' })
      }
      return item.branch
    },
    [t],
  )

  const handleOpenChanges = useCallback(() => {
    if (!codeRoot || !sessionId) {
      toast({
        title: t('codeWorkspace.errorTitle', { defaultValue: '无法打开' }),
        description: t('codeWorkspace.needSession', {
          defaultValue: '请先进入对话会话。',
        }),
      })
      return
    }
    if (repoConfirmed && !isGitRepo) return
    expandCanvas()
    openCodeChangesTab({
      tabScopeKey,
      spaceId,
      rootPath: codeRoot,
      sessionId,
      initialView: DEFAULT_CODE_CHANGES_VIEW,
      agentTurnEndMessageId: latestTurnEndMessageId,
      focusView: 'agent',
    })
  }, [
    codeRoot,
    sessionId,
    isGitRepo,
    repoConfirmed,
    expandCanvas,
    tabScopeKey,
    spaceId,
    t,
    latestTurnEndMessageId,
  ])

  const handleSelectWorktree = useCallback(
    async (path: string, worktreeBranch: string | null) => {
      if (!sessionId) {
        toast({
          variant: 'destructive',
          title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
          description: t('codeWorkspace.needSession', {
            defaultValue: '请先进入对话会话。',
          }),
        })
        return
      }
      if (!codeRoot) {
        toast({
          variant: 'destructive',
          title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
          description: t('codeWorkspace.noRoot', { defaultValue: '未绑定代码根' }),
        })
        return
      }
      if (normalizePathForCompare(path) === normalizePathForCompare(codeRoot)) {
        setWorktreeOpen(false)
        return
      }
      setBusy(true)
      try {
        const result = await switchSessionWorktree({
          sessionId,
          spaceId,
          tabScopeKey,
          rootPath: path,
          previousRootPath: codeRoot,
          branch: worktreeBranch,
        })
        if (!result.success) {
          const key = result.reason ? BIND_REASON_I18N_KEY[result.reason] : undefined
          toast({
            variant: 'destructive',
            title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
            description: key
              ? t(key, {
                defaultValue: t('codeWorkspace.bindReason.unknown', {
                  defaultValue: '无法切换代码根',
                }),
              })
              : (result.error?.trim()
                || t('codeWorkspace.bindReason.unknown', { defaultValue: '无法切换代码根' })),
          })
          return
        }
        const boundPath = result.rootPath ?? path
        const confirmed = useSessionBoundCodeRootStore.getState().getBinding(sessionId)
        if (
          !confirmed
          || confirmed.status !== 'active'
          || normalizePathForCompare(confirmed.rootPath) !== normalizePathForCompare(boundPath)
        ) {
          toast({
            variant: 'destructive',
            title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
            description: t('codeWorkspace.bindReason.unknown', {
              defaultValue: '无法切换代码根',
            }),
          })
          return
        }
        setWorktreeOpen(false)
        toast({
          variant: 'success',
          title: t('codeWorkspace.successTitle', { defaultValue: '已切换' }),
          description: t('codeWorkspace.worktreeSwitched', {
            defaultValue: '已将对话代码根切换到 {{path}}',
            path: boundPath,
          }),
        })
        refresh()
        void loadGitLists()
      } catch (error) {
        toast({
          variant: 'destructive',
          title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
          description: formatGitErrorForToast(error, tTabcode)
            || t('codeWorkspace.bindReason.unknown', { defaultValue: '无法切换代码根' }),
        })
      } finally {
        setBusy(false)
      }
    },
    [
      sessionId,
      codeRoot,
      spaceId,
      tabScopeKey,
      t,
      tTabcode,
      refresh,
      loadGitLists,
    ],
  )

  const doCheckout = useCallback(
    async (nextBranch: string, confirmedStash = false) => {
      if (!codeRoot) return
      setBusy(true)
      try {
        const result = await checkoutSessionBranch({
          rootPath: codeRoot,
          branch: nextBranch,
          stagedCount,
          unstagedCount,
          dirtyFileCount,
          untrackedCount,
          confirmedStash,
          t: tTabcode,
        })
        if (result.needsStashConfirm) {
          // 先关分支弹层，再开确认框，避免 Popover 焦点抢占把 Dialog 立刻关掉。
          setBranchOpen(false)
          pendingStashBranchRef.current = nextBranch
          setConfirmStashBranch(nextBranch)
          return
        }
        if (!result.success) {
          logGitActionFailure(
            result.phase === 'checkout-after-stash'
              ? 'code-workspace:checkout-after-stash'
              : result.phase === 'stash'
                ? 'code-workspace:stash-before-checkout'
                : 'code-workspace:checkout-branch',
            codeRoot,
            [],
            result.error,
          )
          toast({
            title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
            description: formatGitErrorForToast(
              result.error,
              tTabcode,
            ) || t('codeWorkspace.branchSwitchFailed', {
              defaultValue: '分支切换失败',
            }),
          })
          return
        }
        pendingStashBranchRef.current = null
        setConfirmStashBranch(null)
        setBranchOpen(false)
        refresh()
        void loadGitLists()
        toast({
          title: t('codeWorkspace.successTitle', { defaultValue: '已切换' }),
          description: tTabcode('gitFlow.checkoutSuccess', { branch: nextBranch }),
        })
      } catch (error) {
        logGitActionFailure('code-workspace:checkout-branch', codeRoot, [], error)
        toast({
          title: t('codeWorkspace.errorTitle', { defaultValue: '切换失败' }),
          description: formatGitErrorForToast(error, tTabcode),
        })
      } finally {
        setBusy(false)
      }
    },
    [codeRoot, stagedCount, unstagedCount, dirtyFileCount, untrackedCount, tTabcode, t, refresh, loadGitLists],
  )

  const doCreateBranch = useCallback(async () => {
    const nextBranch = newBranchName.trim()
    if (!codeRoot || !nextBranch || branches.includes(nextBranch) || busy)
      return

    setBusy(true)
    try {
      const result = await window.tabtin.git.checkoutBranch(codeRoot, {
        branch: nextBranch,
        create: true,
      })
      if (!result?.success) {
        logGitActionFailure(
          'code-workspace:create-branch',
          codeRoot,
          [],
          result?.error,
        )
        toast({
          title: t('codeWorkspace.errorTitle', { defaultValue: '创建失败' }),
          description:
            formatGitErrorForToast(result, tTabcode) ||
            t('codeWorkspace.branchCreateFailed', {
              defaultValue: '创建新分支失败',
            }),
        })
        return
      }

      setBranchOpen(false)
      setCreatingBranch(false)
      setNewBranchName('')
      refresh()
      void loadGitLists()
      toast({
        variant: 'success',
        title: t('codeWorkspace.successTitle', { defaultValue: '已完成' }),
        description: t('codeWorkspace.branchCreated', {
          defaultValue: '已创建并切换到 {{branch}}',
          branch: nextBranch,
        }),
      })
    } catch (error) {
      logGitActionFailure('code-workspace:create-branch', codeRoot, [], error)
      toast({
        title: t('codeWorkspace.errorTitle', { defaultValue: '创建失败' }),
        description:
          formatGitErrorForToast(error, tTabcode) ||
          t('codeWorkspace.branchCreateFailed', {
            defaultValue: '创建新分支失败',
          }),
      })
    } finally {
      setBusy(false)
    }
  }, [
    branches,
    busy,
    codeRoot,
    loadGitLists,
    newBranchName,
    refresh,
    t,
    tTabcode,
  ])

  useEffect(() => {
    if (creatingBranch) newBranchInputRef.current?.focus()
  }, [creatingBranch])

  const handleOpenGitPanel = useCallback(() => {
    if (!codeRoot) return
    if (repoConfirmed && !isGitRepo) return
    expandCanvas()
    openTabCodeGitPanel({ tabScopeKey, rootPath: codeRoot })
  }, [codeRoot, isGitRepo, repoConfirmed, expandCanvas, tabScopeKey])

  if (!showWorkspace || !codeRoot) return null

  // 静默刷新：始终展示「变更」与本轮 Agent 编辑最终增减，不切换成「读取变更…」。
  const changeLabel = [
    t('codeWorkspace.changesWord', { defaultValue: '变更' }),
    insertions > 0 ? `+${insertions}` : '',
    deletions > 0 ? `-${deletions}` : '',
  ].filter(Boolean).join(' ')

  const rowClass =
    'flex w-full min-w-0 items-center gap-2 rounded-interactive px-2 py-1 text-left text-body transition-colors hover:bg-foreground/[0.04]'
  const actionsEnabled = !repoConfirmed || isGitRepo

  const renderWorktreeOption = (item: GitWorktreeInfo) => {
    const selected =
      normalizePathForCompare(item.path) === normalizePathForCompare(codeRoot)
    const folderName = basename(item.path)
    return (
      <button
        key={item.path}
        type="button"
        role="option"
        aria-selected={selected}
        title={item.path}
        data-testid={`worktree-item-${item.path}`}
        className="flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left text-caption hover:bg-foreground/[0.06]"
        onClick={() => void handleSelectWorktree(item.path, item.branch)}
      >
        <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{folderName}</span>
          <span className={cn('block truncate', CANVAS_TEXT_META)}>
            {worktreeBranchLabel(item)}
          </span>
        </span>
        <Check
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0',
            selected ? 'opacity-100' : 'opacity-0',
          )}
        />
      </button>
    )
  }

  if (iconOnly) {
    return (
      <div className="min-w-0 shrink-0 space-y-0.5 pb-1" data-testid="code-workspace-rail-card">
        <button
          type="button"
          className="group flex w-full items-center justify-center py-0.5"
          title={changeLabel}
          aria-label={changeLabel}
          onClick={handleOpenChanges}
          disabled={!actionsEnabled}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-interactive hover:bg-foreground/[0.03]">
            <Diff className="h-4 w-4 opacity-70" />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="min-w-0 shrink-0 pb-1 pt-1" data-testid="code-workspace-rail-card">
      <div className={SIDEBAR_SECTION_HEADER}>
        <span className={SIDEBAR_SECTION_LABEL}>
          {t('codeWorkspace.title', { defaultValue: '代码工作区' })}
        </span>
      </div>
      <div className="mx-1.5 space-y-0.5 rounded-lg border border-border/40 bg-muted/[0.04] p-1">
        <button
          type="button"
          className={rowClass}
          onClick={handleOpenChanges}
          disabled={!actionsEnabled || !sessionId}
          aria-label={changeLabel}
          title={changeLabel}
          data-testid="code-workspace-changes-row"
        >
          <Diff className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">
            {t('codeWorkspace.changesWord', { defaultValue: '变更' })}
            {insertions > 0 ? (
              <>
                {' '}
                <span className="tabular-nums text-success">+{insertions}</span>
              </>
            ) : null}
            {deletions > 0 ? (
              <>
                {' '}
                <span className="tabular-nums text-destructive">-{deletions}</span>
              </>
            ) : null}
          </span>
        </button>

        <div data-testid="code-workspace-worktree-menu">
          <Popover
            open={worktreeOpen}
            onOpenChange={(open) => {
              if (busy && open) return
              setBranchOpen(false)
              setWorktreeOpen(open)
              if (open) void loadGitLists()
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={rowClass}
                disabled={!actionsEnabled || busy || !sessionId}
                aria-expanded={worktreeOpen}
                aria-haspopup="listbox"
                aria-label={currentRootFolderName}
                title={codeRoot || undefined}
                data-testid="code-workspace-worktree-trigger"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{currentRootFolderName}</span>
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ChevronDown className="h-3 w-3 opacity-50" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="left"
              align="start"
              sideOffset={8}
              className="w-64 p-1"
              data-testid="code-workspace-worktree-popover"
            >
              {worktreeListError || worktrees.length === 0 ? (
                <div className="px-2 py-1.5 text-caption text-muted-foreground">
                  {t('codeWorkspace.worktreeLoadFailed', {
                    defaultValue: '未能读取 worktree 列表',
                  })}
                </div>
              ) : (
                <div className="max-h-56 space-y-1 overflow-auto" role="listbox">
                  {mainWorktrees.length > 0 ? (
                    <div>
                      <div className="px-2 py-1 text-caption text-muted-foreground">
                        {t('codeWorkspace.mainWorktreeGroup', { defaultValue: '主目录' })}
                      </div>
                      {mainWorktrees.map(renderWorktreeOption)}
                    </div>
                  ) : null}
                  <div>
                    <div className="px-2 py-1 text-caption text-muted-foreground">
                      {t('codeWorkspace.linkedWorktreesGroup', {
                        defaultValue: '关联 worktree',
                      })}
                    </div>
                    {showLinkedEmpty ? (
                      <div
                        className="px-2 py-1.5 text-caption text-muted-foreground"
                        data-testid="code-workspace-linked-empty"
                      >
                        {t('codeWorkspace.linkedWorktreesEmpty', {
                          defaultValue: '还没有关联 worktree。新建后，当前对话可以在独立目录和分支里工作，不会改变工作空间主目录。',
                        })}
                      </div>
                    ) : (
                      linkedWorktrees.map(renderWorktreeOption)
                    )}
                  </div>
                </div>
              )}
              <div className="mt-1 border-t border-border/60 pt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-caption hover:bg-foreground/[0.06]"
                  data-testid="code-workspace-add-worktree"
                  disabled={busy || !sessionId}
                  onClick={() => {
                    setWorktreeOpen(false)
                    setCreateOpen(true)
                  }}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span>
                    {t('codeWorkspace.addWorktree', { defaultValue: '新增 worktree' })}
                  </span>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div data-testid="code-workspace-branch-menu">
          <Popover
            open={branchOpen}
            onOpenChange={(open) => {
              // 切换进行中仍允许关闭；仅禁止在 busy 时再次打开。
              if (busy && open) return
              setWorktreeOpen(false)
              setBranchOpen(open)
              if (open) {
                void loadGitLists()
                return
              }
              setCreatingBranch(false)
              setNewBranchName('')
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={rowClass}
                disabled={!actionsEnabled || busy}
                aria-expanded={branchOpen}
                aria-haspopup="dialog"
                data-testid="code-workspace-branch-trigger"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">
                  {t('codeWorkspace.branch', { defaultValue: '分支' })}
                  <span className={cn('ml-1', CANVAS_TEXT_META)}>{branch || '—'}</span>
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="left"
              align="start"
              sideOffset={8}
              className="w-64 p-0"
              data-testid="code-workspace-branch-popover"
              onOpenAutoFocus={(event) => {
                // 让 CommandInput 自动获得焦点，便于立即搜索。
                const root = event.currentTarget as HTMLElement
                const input = root.querySelector('input')
                if (input instanceof HTMLInputElement) {
                  event.preventDefault()
                  input.focus()
                }
              }}
            >
              {creatingBranch ? (
                <form
                  className="space-y-2 p-2"
                  data-testid="code-workspace-create-branch-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void doCreateBranch()
                  }}
                >
                  <label
                    className="text-caption text-muted-foreground"
                    htmlFor="code-workspace-new-branch"
                  >
                    {t('codeWorkspace.newBranchName', {
                      defaultValue: '新分支名称',
                    })}
                  </label>
                  <input
                    ref={newBranchInputRef}
                    id="code-workspace-new-branch"
                    type="text"
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    placeholder={t('codeWorkspace.branchNamePlaceholder', {
                      defaultValue: '例如：feat/login',
                    })}
                    className="h-8 w-full rounded-interactive border border-border bg-background px-2 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="code-workspace-new-branch-input"
                    disabled={busy}
                  />
                  <p
                    className="text-caption text-muted-foreground"
                    data-testid="code-workspace-create-branch-help"
                  >
                    {t('codeWorkspace.branchCreateBaseHint', {
                      defaultValue: '将基于当前分支 {{branch}} 创建，并自动切换到新分支',
                      branch: branch || t('codeWorkspace.currentBranch', {
                        defaultValue: '当前分支',
                      }),
                    })}
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-interactive px-2 py-1 text-caption hover:bg-foreground/[0.06]"
                      data-testid="code-workspace-cancel-create-branch"
                      disabled={busy}
                      onClick={() => {
                        setCreatingBranch(false)
                        setNewBranchName('')
                      }}
                    >
                      {t('codeWorkspace.cancel', { defaultValue: '取消' })}
                    </button>
                    <button
                      type="submit"
                      className="rounded-interactive bg-primary px-2 py-1 text-caption text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid="code-workspace-confirm-create-branch"
                      disabled={
                        busy ||
                        !newBranchName.trim() ||
                        branches.includes(newBranchName.trim())
                      }
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t('codeWorkspace.createBranch', {
                        defaultValue: '创建新分支',
                      })}
                    </button>
                  </div>
                </form>
              ) : (
                <>
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
                      <CommandGroup
                        heading={t('codeWorkspace.branchesHeading', {
                          defaultValue: '分支',
                        })}
                      >
                        {branches.map((name) => (
                          <CommandItem
                            key={name}
                            value={name}
                            disabled={busy}
                            onSelect={() => {
                              if (busy || name === branch) {
                                setBranchOpen(false)
                                return
                              }
                              void doCheckout(name)
                            }}
                          >
                            <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-70" />
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
                  <div className="border-t border-border/60 p-1">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-caption hover:bg-foreground/[0.06]"
                      data-testid="code-workspace-add-branch"
                      disabled={busy}
                      onClick={() => setCreatingBranch(true)}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span>
                        {t('codeWorkspace.createBranch', { defaultValue: '创建新分支' })}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>

        <button
          type="button"
          className={rowClass}
          onClick={handleOpenGitPanel}
          disabled={!actionsEnabled}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">
            {t('codeWorkspace.commitOrPush', { defaultValue: '提交或推送' })}
          </span>
        </button>
      </div>

      {codeRoot && sessionId ? (
        <CreateWorktreeDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          repoRoot={codeRoot}
          currentBranch={branch || ''}
          branchNames={branches}
          existingWorktreePaths={worktrees.map((item) => item.path)}
          defaultBaseBranch={defaultBaseBranch}
          sessionId={sessionId}
          spaceId={spaceId}
          tabScopeKey={tabScopeKey}
          previousRootPath={codeRoot}
          disabled={busy}
          onCreated={({ rootPath, switched }) => {
            refresh()
            void loadGitLists()
            if (switched) {
              toast({
                variant: 'success',
                title: t('codeWorkspace.successTitle', { defaultValue: '已完成' }),
                description: t('codeWorkspace.worktreeCreatedAndSwitched', {
                  defaultValue: '已创建关联 worktree，并切到 {{path}}',
                  path: rootPath,
                }),
              })
              return
            }
            toast({
              variant: 'destructive',
              title: t('codeWorkspace.errorTitle', { defaultValue: '无法完成' }),
              description: t('codeWorkspace.worktreeCreatedSwitchFailed', {
                defaultValue: '关联 worktree 已创建，但未能切到当前对话。目录已保留，可稍后在列表中切换。',
              }),
            })
          }}
          onError={(message) => {
            toast({
              variant: 'destructive',
              title: t('codeWorkspace.errorTitle', { defaultValue: '无法完成' }),
              description: message,
            })
          }}
        />
      ) : null}

      <TabCodeConfirmDialog
        open={Boolean(confirmStashBranch)}
        onOpenChange={(open) => {
          if (!open) {
            pendingStashBranchRef.current = null
            setConfirmStashBranch(null)
          }
        }}
        title={tTabcode('gitFlow.branchSection')}
        description={tTabcode('gitFlow.stashAndCheckout')}
        confirmLabel={t('codeWorkspace.stashAndSwitch', { defaultValue: '暂存并切换' })}
        disabled={busy}
        // 收起画布时 OverlayContainer 宽度为 0，scoped Dialog 会挤成不可见；强制 body。
        container={null}
        onConfirm={() => {
          const branch = pendingStashBranchRef.current || confirmStashBranch
          if (branch) void doCheckout(branch, true)
        }}
      />
    </div>
  )
}

CodeWorkspaceRailCard.displayName = 'CodeWorkspaceRailCard'
