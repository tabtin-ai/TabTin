/**
 * Changes 右侧未提交文件树：单一压缩目录树 + 增删统计 + 定位左侧连续 Diff。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  Undo2,
} from 'lucide-react'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { cn } from '@utils/cn'
import {
  buildCompactGitChangeTree,
  flattenCompactGitChangeTree,
  type CompactGitChangeTreeNode,
  type CompactGitChangeTreeRow,
} from '@components/tabcode/utils/gitCompactTree'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import { TabCodeConfirmDialog } from '@components/tabcode/components/TabCodeConfirmDialog'
import { aggregateUncommittedTotals, joinRootPath } from './changesViewModel'

export interface ChangesFileSelection {
  relativePath: string
  absolutePath: string
}

interface ChangesFileTreeProps {
  rootPath: string
  files: ChangeFile[]
  selectedPath: string | null
  actionKey: string | null
  isLoading?: boolean
  /** 提交历史等只读场景：隐藏 stage / discard */
  readOnly?: boolean
  onSelect: (selection: ChangesFileSelection) => void
  runGitAction?: (
    key: string,
    action: () => Promise<{
      success: boolean
      error?: string
      skippedPaths?: string[]
      skippedCount?: number
    } | null>,
    successDesc: string,
  ) => Promise<boolean>
}

const ROW_HEIGHT = 28
const TREE_INDENT = 12
const SELECTED_ROW =
  'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'

const STATUS_BADGE: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-destructive',
  U: 'text-destructive',
  '?': 'text-muted-foreground',
}

function toAbsoluteEntries(rootPath: string, files: ChangeFile[]) {
  return files.map((file) => ({
    path: joinRootPath(rootPath, file.path),
    status: file.status,
    relativePath: file.path,
    file,
  }))
}

function countLeafFiles(node: CompactGitChangeTreeNode): number {
  if (node.type === 'file') return 1
  return node.children.reduce((sum, child) => sum + countLeafFiles(child), 0)
}

/** 选中文件到根的目录 id 链（含 compact 合并目录），用于自动展开祖先 */
function findAncestorDirectoryIds(
  nodes: CompactGitChangeTreeNode[],
  absolutePath: string,
): string[] | null {
  for (const node of nodes) {
    if (node.type === 'file' && node.path === absolutePath) return []
    if (node.type === 'directory') {
      const nested = findAncestorDirectoryIds(node.children, absolutePath)
      if (nested) return [node.id, ...nested]
    }
  }
  return null
}

function InlineAction({
  label,
  disabled,
  onAction,
  children,
}: {
  label: string
  disabled?: boolean
  onAction: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation()
        onAction()
      }}
    >
      {children}
    </button>
  )
}

export const ChangesFileTree: React.FC<ChangesFileTreeProps> = ({
  rootPath,
  files,
  selectedPath,
  actionKey,
  isLoading,
  readOnly = false,
  onSelect,
  runGitAction,
}) => {
  const { t } = useTranslation('tabcode')
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const [discardTarget, setDiscardTarget] = useState<{
    path: string
    untracked: boolean
  } | null>(null)

  const totals = useMemo(() => aggregateUncommittedTotals(files), [files])

  const tree = useMemo(
    () => buildCompactGitChangeTree(
      rootPath,
      toAbsoluteEntries(rootPath, files).map((entry) => ({
        path: entry.path,
        status: entry.status,
      })),
    ),
    [files, rootPath],
  )

  const rows = useMemo(
    () => flattenCompactGitChangeTree(tree, collapsedDirs),
    [collapsedDirs, tree],
  )

  const fileByAbsPath = useMemo(() => {
    const map = new Map<string, ChangeFile>()
    for (const file of files) {
      map.set(joinRootPath(rootPath, file.path), file)
    }
    return map
  }, [files, rootPath])

  // 选中文件时展开祖先目录，避免「标题 5 个文件、树只见折叠文件夹」
  useEffect(() => {
    if (!selectedPath) return
    const ancestors = findAncestorDirectoryIds(tree, selectedPath)
    if (!ancestors?.length) return
    setCollapsedDirs((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of ancestors) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }, [selectedPath, tree])

  const toggleDir = useCallback((id: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectFile = useCallback(
    (absolutePath: string) => {
      const file = fileByAbsPath.get(absolutePath)
      if (!file) return
      onSelect({
        relativePath: file.path,
        absolutePath,
      })
    },
    [fileByAbsPath, onSelect],
  )

  const stageOne = useCallback(
    async (relativePath: string) => {
      if (!runGitAction) return
      await runGitAction(
        `stage:${relativePath}`,
        () => window.tabtin.git.stageFiles(rootPath, [relativePath]),
        t('gitFlow.stageOneSuccess'),
      )
    },
    [rootPath, runGitAction, t],
  )

  const unstageOne = useCallback(
    async (relativePath: string) => {
      if (!runGitAction) return
      await runGitAction(
        `unstage:${relativePath}`,
        () => window.tabtin.git.unstageFiles(rootPath, [relativePath]),
        t('gitFlow.unstageOneSuccess'),
      )
    },
    [rootPath, runGitAction, t],
  )

  const doDiscard = useCallback(async () => {
    const target = discardTarget
    if (!target || !runGitAction) return
    setDiscardTarget(null)
    await runGitAction(
      `discard:${target.path}`,
      () => window.tabtin.git.discardFiles(rootPath, [target.path]),
      t('gitFlow.discardSuccess'),
    )
  }, [discardTarget, rootPath, runGitAction, t])

  const renderRow = (row: CompactGitChangeTreeRow) => {
    const depth = row.depth + 1
    if (row.type === 'directory') {
      const collapsed = collapsedDirs.has(row.id)
      const leafCount = countLeafFiles(row)
      return (
        <div
          key={row.id}
          role="button"
          tabIndex={0}
          data-testid="changes-dir-row"
          data-dir-id={row.id}
          className="flex w-full items-center rounded-md px-1 text-left text-body text-foreground/80 hover:bg-muted/30"
          style={{ paddingLeft: depth * TREE_INDENT, height: ROW_HEIGHT }}
          onClick={() => toggleDir(row.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleDir(row.id)
            }
          }}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {collapsed
              ? <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
              : <ChevronDown className="h-3 w-3 text-muted-foreground/60" />}
          </span>
          <FileIcon
            fileName={row.name.split('/').pop() || row.name}
            isDirectory
            isOpen={!collapsed}
            className="mr-1 h-3.5 w-3.5 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span
            className="ml-1 shrink-0 text-caption tabular-nums text-muted-foreground/70"
            data-testid="changes-dir-file-count"
          >
            {leafCount}
          </span>
        </div>
      )
    }

    const file = fileByAbsPath.get(row.path)
    const selected = selectedPath === row.path
    const relativePath = file?.path || row.path
    const busy = Boolean(actionKey?.includes(relativePath))
    const badgeClass = STATUS_BADGE[row.status || ''] || 'text-muted-foreground'

    return (
      <div
        key={row.path}
        role="button"
        tabIndex={0}
        data-testid="changes-file-row"
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'group/changes-row flex w-full items-center rounded-md px-1 text-left text-body transition-colors',
          selected ? SELECTED_ROW : 'text-foreground/80 hover:bg-muted/30 hover:text-foreground',
        )}
        style={{ paddingLeft: depth * TREE_INDENT, height: ROW_HEIGHT }}
        onClick={() => selectFile(row.path)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectFile(row.path)
          }
        }}
      >
        <span className="h-4 w-4 shrink-0" />
        <FileIcon fileName={row.name} className="mr-1 h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            row.status === 'D' && 'text-muted-foreground line-through',
          )}
        >
          {row.name}
        </span>
        {!readOnly ? (
          <span
            className="ml-1 hidden shrink-0 items-center gap-0.5 group-hover/changes-row:flex group-focus-within/changes-row:flex"
            data-testid="changes-file-actions"
          >
            {file?.conflict ? (
              <InlineAction
                label={t('gitFlow.markResolved')}
                disabled={Boolean(actionKey)}
                onAction={() => void stageOne(relativePath)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </InlineAction>
            ) : null}
            {file?.staged && !file.conflict ? (
              <InlineAction
                label={t('gitFlow.unstageFile')}
                disabled={Boolean(actionKey)}
                onAction={() => void unstageOne(relativePath)}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Minus className="h-3.5 w-3.5" />}
              </InlineAction>
            ) : null}
            {(file?.unstaged || file?.untracked) && !file?.conflict ? (
              <>
                <InlineAction
                  label={t('gitFlow.discardChanges')}
                  disabled={Boolean(actionKey)}
                  onAction={() => setDiscardTarget({
                    path: relativePath,
                    untracked: Boolean(file?.untracked),
                  })}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </InlineAction>
                <InlineAction
                  label={t('gitFlow.stageFile')}
                  disabled={Boolean(actionKey)}
                  onAction={() => void stageOne(relativePath)}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                </InlineAction>
              </>
            ) : null}
          </span>
        ) : null}
        {file ? (
          <span className="ml-1 shrink-0 text-caption tabular-nums text-muted-foreground/70">
            {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
            {file.added > 0 && file.deleted > 0 ? ' ' : null}
            {file.deleted > 0 ? <span className="text-destructive">-{file.deleted}</span> : null}
          </span>
        ) : null}
        <span className={cn('ml-1 mr-1 shrink-0 text-caption font-semibold opacity-80', badgeClass)}>
          {row.status === '?' ? 'U' : row.status || 'M'}
        </span>
      </div>
    )
  }

  if (totals.fileCount === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-body text-muted-foreground/60">
        {isLoading ? t('gitFlow.loadingChanges') : t('gitFlow.changesEmpty')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="changes-file-tree">
      <div className="shrink-0 border-b border-border/40 px-3 py-2 text-caption font-medium text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span>
            {t('gitFlow.filesChanged', {
              defaultValue: '{{count}} Files Changed',
              count: totals.fileCount,
            })}
          </span>
          <span className="shrink-0 tabular-nums" data-testid="changes-tree-totals">
            {totals.added > 0 ? <span className="text-success">+{totals.added}</span> : null}
            {totals.added > 0 && totals.deleted > 0 ? ' ' : null}
            {totals.deleted > 0 ? <span className="text-destructive">-{totals.deleted}</span> : null}
            {totals.added === 0 && totals.deleted === 0 ? (
              <span className="text-muted-foreground/70">±0</span>
            ) : null}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-hover">
        {rows.map((row) => renderRow(row))}
      </div>

      <TabCodeConfirmDialog
        open={Boolean(discardTarget)}
        onOpenChange={(open) => {
          if (!open) setDiscardTarget(null)
        }}
        title={t('gitFlow.discardChanges')}
        description={t(
          discardTarget?.untracked
            ? 'gitFlow.confirmDiscardUntracked'
            : 'gitFlow.confirmDiscard',
          { path: discardTarget?.path || '' },
        )}
        variant="destructive"
        confirmLabel={t('gitFlow.discardChanges')}
        onConfirm={() => void doDiscard()}
      />
    </div>
  )
}

export default ChangesFileTree
