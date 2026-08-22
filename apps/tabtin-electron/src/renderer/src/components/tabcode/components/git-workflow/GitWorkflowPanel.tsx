/**
 * Git 操作面板（无 Dialog 壳）——侧栏上下叠放区复用。
 * 顶：Commit；中：Changes；点变更文件由宿主打开主预览 Diff。
 * 分支与 Fetch/Pull/Push 在整面板通栏底栏（TabCodeStatusBar）。
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea, toast } from '@components/ui'
import { useGitWorkflowData } from './useGitWorkflowData'
import { ChangesPanel, type ChangesPanelDiffMode } from './ChangesPanel'
import { CommitBar, type GitActionPresentation } from './CommitBar'
import { AdvancedSheet } from './AdvancedSheet'
import { formatGitErrorForToast } from './gitErrorMessage'
import { logGitActionFailure } from '../../utils/gitActionDiagnostics'
import { useWorktreeDialogStore } from './useWorktreeDialogStore'
import { cn } from '@utils/cn'

export interface GitWorkflowPanelProps {
  rootPath: string
  currentBranch: string | null
  stagedCount: number
  unstagedCount: number
  enabled?: boolean
  /** 与 useGitStatus.statusRevision 对齐，驱动 Changes 列表跟外部改文件同步。 */
  refreshToken?: number
  /** ：当前 Space id——授权 worktree 路径 / 打开代码项目标签需要。 */
  spaceId?: string | null
  /** ：当前 chat 会话 id——「设为对话代码根」需要绑定目标会话。 */
  sessionId?: string | null
  /** 当前 TabCode 所属标签 scope。 */
  tabScopeKey?: string | null
  onRefreshGit: () => void | Promise<void>
  onSelectChangeFile?: (
    absolutePath: string,
    diffMode?: ChangesPanelDiffMode,
  ) => void
  /** 打开某个 worktree 路径为独立 TabCode 标签（ 恢复的 Worktree 入口用）。 */
  onOpenProjectPath?: (path: string) => void
  /** 保活 TabCode 面板的 Worktree Dialog 唯一归属。 */
  worktreeDialogOwnerId?: string
  className?: string
}

export const GitWorkflowPanel: React.FC<GitWorkflowPanelProps> = ({
  rootPath,
  currentBranch,
  stagedCount,
  unstagedCount,
  enabled = true,
  refreshToken = 0,
  spaceId,
  sessionId,
  tabScopeKey,
  onRefreshGit,
  onSelectChangeFile,
  onOpenProjectPath,
  worktreeDialogOwnerId = rootPath,
  className,
}) => {
  const { t } = useTranslation('tabcode')
  const [actionKey, setActionKey] = useState<string | null>(null)
  const advancedOpen = useWorktreeDialogStore(
    (state) => state.openOwnerId === worktreeDialogOwnerId,
  )
  const setWorktreeDialogOpen = useWorktreeDialogStore(
    (state) => state.setOpen,
  )
  const setAdvancedOpen = useCallback(
    (open: boolean) => setWorktreeDialogOpen(worktreeDialogOwnerId, open),
    [setWorktreeDialogOpen, worktreeDialogOwnerId],
  )

  const data = useGitWorkflowData({
    rootPath,
    currentBranch,
    enabled,
    refreshToken,
  })

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
      presentation?: GitActionPresentation,
    ) => {
      setActionKey(key)
      try {
        const result = await action()
        if (result?.success) {
          let refreshFailed = false
          try {
            await onRefreshGit()
            await data.loadData()
          } catch (refreshError) {
            refreshFailed = true
            logGitActionFailure(
              `workflow:${key}:refresh`,
              rootPath,
              [],
              refreshError,
            )
          }
          if (presentation?.showSuccessToast !== false) {
            const skippedCount =
              result.skippedCount ?? result.skippedPaths?.length ?? 0
            const skippedDesc =
              skippedCount > 0
                ? key.startsWith('unstage')
                  ? t('gitFlow.unstageSkippedDenied', { count: skippedCount })
                  : t('gitFlow.stageSkippedDenied', { count: skippedCount })
                : null
            toast({
              title: t('gitFlow.successTitle'),
              description: refreshFailed
                ? t('gitFlow.actionSucceededRefreshFailed', {
                    action: skippedDesc ?? successDesc,
                  })
                : (skippedDesc ?? successDesc),
            })
          }
          return true
        }
        logGitActionFailure(`workflow:${key}`, rootPath, [], result?.error)
        toast({
          title: t('gitFlow.errorTitle'),
          description:
            presentation?.formatError?.(result?.error) ??
            formatGitErrorForToast(result, t),
        })
        return false
      } catch (error) {
        logGitActionFailure(`workflow:${key}`, rootPath, [], error)
        toast({
          title: t('gitFlow.errorTitle'),
          description:
            presentation?.formatError?.(error) ??
            formatGitErrorForToast(error, t),
        })
        return false
      } finally {
        setActionKey(null)
      }
    },
    [data, onRefreshGit, rootPath, t],
  )

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-col @container/tabcode-git',
        className,
      )}
    >
      <div className="shrink-0 border-b border-border/40 bg-background/95 px-3 pb-2 pt-3">
        <CommitBar
          rootPath={rootPath}
          currentBranchName={data.currentBranchName}
          branchMeta={data.branchMeta}
          stagedCount={stagedCount}
          unstagedCount={unstagedCount}
          actionKey={actionKey}
          runGitAction={runGitAction}
        />
      </div>

      {data.files.length === 0 ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3">
          <ChangesPanel
            rootPath={rootPath}
            files={data.files}
            groups={data.groups}
            isLoading={data.isLoading}
            actionKey={actionKey}
            runGitAction={runGitAction}
            inlineDiff={false}
            onSelectChangeFile={onSelectChangeFile}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="min-w-0 px-3 pb-3 pt-2">
            <ChangesPanel
              rootPath={rootPath}
              files={data.files}
              groups={data.groups}
              isLoading={data.isLoading}
              actionKey={actionKey}
              runGitAction={runGitAction}
              inlineDiff={false}
              onSelectChangeFile={onSelectChangeFile}
            />
          </div>
        </ScrollArea>
      )}

      <AdvancedSheet
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        rootPath={rootPath}
        branchNames={data.branchNames}
        worktrees={data.worktrees}
        currentBranchName={data.currentBranchName}
        worktreeBaseBranch={data.worktreeBaseBranch}
        setWorktreeBaseBranch={data.setWorktreeBaseBranch}
        worktreeBranch={data.worktreeBranch}
        setWorktreeBranch={data.setWorktreeBranch}
        actionKey={actionKey}
        runGitAction={runGitAction}
        onOpenProjectPath={onOpenProjectPath}
        onCloseDialog={() => setAdvancedOpen(false)}
        spaceId={spaceId}
        sessionId={sessionId}
        tabScopeKey={tabScopeKey}
      />
    </div>
  )
}

export default GitWorkflowPanel
