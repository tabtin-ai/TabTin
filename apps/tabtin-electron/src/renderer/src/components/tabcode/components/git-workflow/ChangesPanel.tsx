import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { ChangeFile, ChangeGroup, ChangeSectionId } from './useGitWorkflowData'
import { partitionChangeFiles } from './useGitWorkflowData'
import { formatGitErrorForToast } from './gitErrorMessage'
import { TabCodeConfirmDialog } from '../TabCodeConfirmDialog'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { cn } from '@utils/cn'
import {
  emptyScmSelection,
  makeScmSelectionKey,
  pruneSelection,
  reduceSelection,
  resolveActionPaths,
  selectionModeFromEvent,
  type ScmSelectionKey,
  type ScmSelectionState,
} from './scmListSelection'

const STATUS_LABEL: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '未跟踪',
}

/** 状态字母徽标配色（淡色底 + 语义色字） */
const STATUS_BADGE: Record<string, string> = {
  M: 'bg-warning/10 text-warning',
  A: 'bg-success/10 text-success',
  D: 'bg-destructive/10 text-destructive',
  R: 'bg-info/10 text-info',
  C: 'bg-info/10 text-info',
  U: 'bg-destructive/10 text-destructive',
  '?': 'bg-muted-foreground/10 text-muted-foreground',
}

/** 行操作：按钮小于固定行高，悬浮出现时不把行撑高 */
const ROW_ACTION_BASE =
  'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40'
/** 与 h-4 按钮同尺寸，视觉上占满 */
const ROW_ACTION_ICON_CLASS = 'h-4 w-4'
const ROW_ACTION_ICON_STROKE = 1.5
/** 亮/暗主题共用语义色；勿用 text-white（亮色底对比度不足） */
const ROW_ACTION_DISCARD =
  `${ROW_ACTION_BASE} text-muted-foreground hover:bg-destructive/10 hover:text-destructive`
const ROW_ACTION_STAGE =
  `${ROW_ACTION_BASE} text-muted-foreground hover:bg-muted/40 hover:text-foreground`
const ROW_ACTION_UNSTAGE =
  `${ROW_ACTION_BASE} text-muted-foreground hover:bg-muted/40 hover:text-foreground`
const ROW_ACTION_RESOLVE =
  `${ROW_ACTION_BASE} text-muted-foreground hover:bg-muted/40 hover:text-foreground`

const MAX_DIFF_PREVIEW_CHARS = 120_000

type DiffScope = 'staged' | 'unstaged' | 'untracked'

interface DiffSection {
  scope: DiffScope
  diff: string
  error?: string
  truncated: boolean
}

interface DiscardTarget {
  paths: string[]
  allUntracked: boolean
}

/** 文件名在前、目录淡色跟在后 */
function splitDisplayPath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx === -1) return { name: normalized, dir: '' }
  return {
    name: normalized.slice(idx + 1),
    dir: normalized.slice(0, idx),
  }
}

function buildDiffScopes(file: ChangeFile, section: ChangeSectionId): DiffScope[] {
  if (file.untracked) return ['untracked']
  if (section === 'staged') return ['staged']
  return ['unstaged']
}

function rawDiffArgs(file: ChangeFile, scope: DiffScope): string[] {
  if (scope === 'staged') return ['--cached', '--', file.path]
  return ['--', file.path]
}

function joinRootPath(rootPath: string, filePath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/'
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${filePath.replace(/^[\\/]+/, '')}`
}

function trimDiffPreview(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF_PREVIEW_CHARS) return { diff, truncated: false }
  return { diff: diff.slice(0, MAX_DIFF_PREVIEW_CHARS), truncated: true }
}

function formatUntrackedDiff(filePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.length === 0
    ? []
    : (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n')
  const hunkLineCount = lines.length
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${hunkLineCount} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n')
}

export type ChangesPanelDiffMode = 'staged' | 'unstaged'

interface ChangesPanelProps {
  rootPath: string
  files: ChangeFile[]
  /** @deprecated 分区后由面板内部从 files 派生；保留以免旧调用方立刻炸掉 */
  groups?: ChangeGroup[]
  isLoading: boolean
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
  ) => Promise<boolean>
  /**
   * false：不在面板内展开行内 diff，点击文件走 onSelectChangeFile（侧栏模式）。
   * true / 缺省：保留 Dialog 时代的行内 diff 预览。
   */
  inlineDiff?: boolean
  /**
   * 点击变更文件（绝对路径）。
   * diffMode 缺省时打开可编辑源文件（冲突处理）；有值时打开只读 Diff。
   */
  onSelectChangeFile?: (absolutePath: string, diffMode?: ChangesPanelDiffMode) => void
}

function resolveDiffMode(section: ChangeSectionId): ChangesPanelDiffMode | undefined {
  if (section === 'conflicts') return undefined
  return section === 'staged' ? 'staged' : 'unstaged'
}

function statusLetter(status: string): string {
  if (status === '?') return 'U'
  if (status === 'U') return '!'
  return status
}

export const ChangesPanel: React.FC<ChangesPanelProps> = ({
  rootPath,
  files,
  isLoading,
  actionKey,
  runGitAction,
  inlineDiff = true,
  onSelectChangeFile,
}) => {
  const { t } = useTranslation('tabcode')
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<ChangeSectionId, boolean>>({
    conflicts: false,
    staged: false,
    unstaged: false,
  })
  const [activeDiffPath, setActiveDiffPath] = useState<string | null>(null)
  const [diffSections, setDiffSections] = useState<DiffSection[]>([])
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<DiscardTarget | null>(null)
  const [selection, setSelection] = useState<ScmSelectionState>(emptyScmSelection)
  const activeDiffPathRef = useRef<string | null>(null)
  activeDiffPathRef.current = activeDiffPath

  const sections = useMemo(() => partitionChangeFiles(files), [files])

  const sectionPathLists = useMemo(() => ({
    conflicts: sections.conflicts.map(f => f.path),
    staged: sections.staged.map(f => f.path),
    unstaged: sections.unstaged.map(f => f.path),
  }), [sections])

  const validSelectionKeys = useMemo(() => {
    const keys = new Set<ScmSelectionKey>()
    for (const section of ['conflicts', 'staged', 'unstaged'] as const) {
      for (const path of sectionPathLists[section]) {
        keys.add(makeScmSelectionKey(section, path))
      }
    }
    return keys
  }, [sectionPathLists])

  useEffect(() => {
    setSelection(prev => pruneSelection(prev, validSelectionKeys))
  }, [validSelectionKeys])

  const fileBySectionPath = useMemo(() => {
    const map = new Map<string, ChangeFile>()
    for (const section of ['conflicts', 'staged', 'unstaged'] as const) {
      for (const file of sections[section]) {
        map.set(makeScmSelectionKey(section, file.path), file)
      }
    }
    return map
  }, [sections])

  const toggleSection = useCallback((id: ChangeSectionId) => {
    setSectionCollapsed(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const clearDiffPreview = useCallback(() => {
    activeDiffPathRef.current = null
    setActiveDiffPath(null)
    setDiffSections([])
    setDiffLoadingPath(null)
  }, [])

  const loadFileDiff = useCallback(async (file: ChangeFile, section: ChangeSectionId) => {
    const requestKey = `${section}:${file.path}`
    if (activeDiffPath === requestKey) {
      clearDiffPreview()
      return
    }

    activeDiffPathRef.current = requestKey
    setActiveDiffPath(requestKey)
    setDiffSections([])
    setDiffLoadingPath(requestKey)

    const scopes = buildDiffScopes(file, section)
    const nextSections = await Promise.all(scopes.map(async (scope): Promise<DiffSection> => {
      try {
        if (scope === 'untracked') {
          const result = await window.tabtin.fileSystem.readFilePreview(joinRootPath(rootPath, file.path), { maxBytes: MAX_DIFF_PREVIEW_CHARS })
          if (!result?.success) {
            return { scope, diff: '', error: formatGitErrorForToast(result, t), truncated: false }
          }
          if (result.data?.kind !== 'text') {
            return { scope, diff: '', truncated: Boolean(result.data?.truncated) }
          }
          const preview = trimDiffPreview(formatUntrackedDiff(file.path, result.data.content || ''))
          return { scope, diff: preview.diff, truncated: preview.truncated || Boolean(result.data.truncated) }
        }

        const result = await window.tabtin.git.rawDiff(rootPath, rawDiffArgs(file, scope))
        if (!result?.success) {
          return { scope, diff: '', error: formatGitErrorForToast(result, t), truncated: false }
        }
        const preview = trimDiffPreview(result.diff || '')
        return { scope, diff: preview.diff, truncated: preview.truncated }
      } catch (error) {
        return { scope, diff: '', error: formatGitErrorForToast(error, t), truncated: false }
      }
    }))

    if (activeDiffPathRef.current === requestKey) {
      setDiffSections(nextSections)
      setDiffLoadingPath(null)
    }
  }, [activeDiffPath, clearDiffPreview, rootPath, t])

  const selectFile = useCallback((file: ChangeFile, section: ChangeSectionId) => {
    if (!inlineDiff && onSelectChangeFile) {
      onSelectChangeFile(joinRootPath(rootPath, file.path), resolveDiffMode(section))
      return
    }
    void loadFileDiff(file, section)
  }, [inlineDiff, loadFileDiff, onSelectChangeFile, rootPath])

  const handleRowClick = useCallback((
    event: React.MouseEvent,
    file: ChangeFile,
    section: ChangeSectionId,
  ) => {
    const mode = selectionModeFromEvent(event)
    setSelection(prev => reduceSelection({
      prev,
      mode,
      section,
      path: file.path,
      sectionPaths: sectionPathLists[section],
    }))
    if (mode === 'replace') {
      selectFile(file, section)
    }
  }, [sectionPathLists, selectFile])

  const stagePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    clearDiffPreview()
    const multi = paths.length > 1
    await runGitAction(
      multi ? 'stage-selected' : `stage:${paths[0]}`,
      () => window.tabtin.git.stageFiles(rootPath, paths),
      multi ? t('gitFlow.stageManySuccess', { count: paths.length }) : t('gitFlow.stageOneSuccess'),
    )
  }, [clearDiffPreview, rootPath, runGitAction, t])

  const markResolved = useCallback(async (path: string) => {
    clearDiffPreview()
    await runGitAction(
      `resolve:${path}`,
      () => window.tabtin.git.stageFiles(rootPath, [path]),
      t('gitFlow.markResolvedSuccess'),
    )
  }, [clearDiffPreview, rootPath, runGitAction, t])

  const unstagePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    clearDiffPreview()
    const multi = paths.length > 1
    await runGitAction(
      multi ? 'unstage-selected' : `unstage:${paths[0]}`,
      () => window.tabtin.git.unstageFiles(rootPath, paths),
      multi ? t('gitFlow.unstageManySuccess', { count: paths.length }) : t('gitFlow.unstageOneSuccess'),
    )
  }, [clearDiffPreview, rootPath, runGitAction, t])

  const stageAllUnstaged = useCallback(async () => {
    const paths = sections.unstaged.filter(f => !f.conflict).map(f => f.path)
    if (paths.length === 0) return
    clearDiffPreview()
    await runGitAction(
      'stage-all',
      () => window.tabtin.git.stageFiles(rootPath, paths),
      t('gitFlow.stageAllSuccess'),
    )
  }, [clearDiffPreview, rootPath, runGitAction, sections.unstaged, t])

  const unstageAllStaged = useCallback(async () => {
    const paths = sections.staged.filter(f => !f.conflict).map(f => f.path)
    if (paths.length === 0) return
    clearDiffPreview()
    await runGitAction(
      'unstage-all',
      () => window.tabtin.git.unstageFiles(rootPath, paths),
      t('gitFlow.unstageAllSuccess'),
    )
  }, [clearDiffPreview, rootPath, runGitAction, sections.staged, t])

  const requestDiscard = useCallback((section: ChangeSectionId, clickedPath: string) => {
    const paths = resolveActionPaths(
      selection.selectedKeys,
      section,
      clickedPath,
      sectionPathLists[section],
    )
    const filesForPaths = paths
      .map(path => fileBySectionPath.get(makeScmSelectionKey(section, path)))
      .filter((f): f is ChangeFile => Boolean(f))
    if (filesForPaths.length === 0) return
    const allUntracked = filesForPaths.every(f => f.untracked)
    setDiscardTarget({ paths, allUntracked })
  }, [fileBySectionPath, sectionPathLists, selection.selectedKeys])

  const doDiscard = useCallback(async () => {
    const target = discardTarget
    if (!target) return
    setDiscardTarget(null)
    clearDiffPreview()
    const multi = target.paths.length > 1
    await runGitAction(
      multi ? 'discard-selected' : `discard:${target.paths[0]}`,
      () => window.tabtin.git.discardFiles(rootPath, target.paths),
      multi
        ? t('gitFlow.discardManySuccess', { count: target.paths.length })
        : t('gitFlow.discardSuccess'),
    )
  }, [clearDiffPreview, discardTarget, rootPath, runGitAction, t])

  const discardDescription = useMemo(() => {
    if (!discardTarget) return ''
    if (discardTarget.paths.length === 1) {
      const path = discardTarget.paths[0] || ''
      return t(
        discardTarget.allUntracked
          ? 'gitFlow.confirmDiscardUntracked'
          : 'gitFlow.confirmDiscard',
        { path },
      )
    }
    return t(
      discardTarget.allUntracked
        ? 'gitFlow.confirmDiscardUntrackedMany'
        : 'gitFlow.confirmDiscardMany',
      { count: discardTarget.paths.length },
    )
  }, [discardTarget, t])

  if (files.length === 0) {
    return (
      <div className="flex min-h-full w-full flex-1 items-center justify-center text-body text-muted-foreground/60">
        {isLoading ? t('gitFlow.loadingChanges') : t('gitFlow.changesEmpty')}
      </div>
    )
  }

  const renderFileRow = (file: ChangeFile, section: ChangeSectionId) => {
    const badgeTone = STATUS_BADGE[file.status] || 'bg-muted-foreground/10 text-muted-foreground'
    const label = STATUS_LABEL[file.status] || file.status
    const rowKey = makeScmSelectionKey(section, file.path)
    const isSelected = selection.selectedKeys.has(rowKey)
    const isDiffActive = activeDiffPath === rowKey
    const isDiffLoading = diffLoadingPath === rowKey
    const canDiscard = section === 'unstaged' && !file.conflict && (file.unstaged || file.untracked)
    const isStaging = actionKey === `stage:${file.path}`
      || actionKey === `resolve:${file.path}`
      || (actionKey === 'stage-selected' && isSelected && section === 'unstaged')
    const isUnstaging = actionKey === `unstage:${file.path}`
      || (actionKey === 'unstage-selected' && isSelected && section === 'staged')
    const isDiscarding = actionKey === `discard:${file.path}`
      || (actionKey === 'discard-selected' && isSelected && section === 'unstaged')
    const rowBusy = isStaging || isUnstaging || isDiscarding
    const { name, dir } = splitDisplayPath(file.path)
    const isDeleted = file.status === 'D'
    const isCurrent = inlineDiff ? isDiffActive : isSelected && selection.anchorKey === rowKey

    return (
      <div key={rowKey}>
        <div
          data-selected={isSelected ? 'true' : undefined}
          className={cn(
            'group/row relative flex items-center gap-1.5 py-0.5 pl-1.5 transition-colors',
            isSelected
              ? 'surface-row-active'
              : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
          )}
        >
          {isSelected && (
            <span
              aria-hidden
              className="absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-accent"
            />
          )}
          <button
            type="button"
            onClick={(event) => handleRowClick(event, file, section)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-expanded={inlineDiff ? isDiffActive : undefined}
            aria-current={isCurrent ? 'true' : undefined}
            aria-selected={isSelected}
            aria-label={
              section === 'conflicts'
                ? t('gitFlow.openConflictFile', { path: file.path })
                : t('gitFlow.viewFileDiff', { path: file.path })
            }
            title={file.path}
          >
            {inlineDiff && (
              isDiffActive
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <FileIcon
              fileName={name}
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                isSelected && 'text-accent-text',
              )}
            />
            <span className="min-w-0 truncate leading-none">
              <span
                className={cn(
                  'text-caption font-medium',
                  isDeleted ? 'text-muted-foreground line-through' : 'text-foreground',
                )}
              >
                {name}
              </span>
              {dir ? (
                <span className="ml-1.5 text-micro text-muted-foreground/60">{dir}</span>
              ) : null}
            </span>
          </button>
          {inlineDiff && isDiffLoading && (
            <Loader2
              className={`${ROW_ACTION_ICON_CLASS} shrink-0 animate-spin text-muted-foreground`}
              strokeWidth={ROW_ACTION_ICON_STROKE}
            />
          )}
          <div
            className={cn(
              'shrink-0 items-center gap-0.5',
              rowBusy
                ? 'flex'
                : 'hidden group-hover/row:flex group-focus-within/row:flex',
            )}
            data-testid="change-row-actions"
          >
            {section === 'conflicts' && (
              <button
                type="button"
                className={ROW_ACTION_RESOLVE}
                disabled={Boolean(actionKey)}
                onClick={(event) => {
                  event.stopPropagation()
                  void markResolved(file.path)
                }}
                title={t('gitFlow.markResolved')}
                aria-label={t('gitFlow.markResolved')}
              >
                {actionKey === `resolve:${file.path}`
                  ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                  : <Check className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
              </button>
            )}
            {section === 'staged' && (
              <button
                type="button"
                className={ROW_ACTION_UNSTAGE}
                disabled={Boolean(actionKey)}
                onClick={(event) => {
                  event.stopPropagation()
                  void unstagePaths(resolveActionPaths(
                    selection.selectedKeys,
                    section,
                    file.path,
                    sectionPathLists[section],
                  ))
                }}
                title={t('gitFlow.unstageFile')}
                aria-label={t('gitFlow.unstageFile')}
              >
                {isUnstaging
                  ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                  : <Minus className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
              </button>
            )}
            {section === 'unstaged' && (
              <>
                {canDiscard && (
                  <button
                    type="button"
                    className={ROW_ACTION_DISCARD}
                    disabled={Boolean(actionKey)}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestDiscard(section, file.path)
                    }}
                    title={t('gitFlow.discardChanges')}
                    aria-label={t('gitFlow.discardChanges')}
                  >
                    {isDiscarding
                      ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                      : <Undo2 className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
                  </button>
                )}
                <button
                  type="button"
                  className={ROW_ACTION_STAGE}
                  disabled={Boolean(actionKey)}
                  onClick={(event) => {
                    event.stopPropagation()
                    void stagePaths(resolveActionPaths(
                      selection.selectedKeys,
                      section,
                      file.path,
                      sectionPathLists[section],
                    ))
                  }}
                  title={t('gitFlow.stageFile')}
                  aria-label={t('gitFlow.stageFile')}
                >
                  {isStaging
                    ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                    : <Plus className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
                </button>
              </>
            )}
          </div>
          <span
            className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-0.5 text-caption font-medium ${badgeTone}`}
            title={label}
          >
            {statusLetter(file.status)}
          </span>
        </div>
        {inlineDiff && isDiffActive && (
          <FileDiffPreview
            loading={isDiffLoading}
            sections={diffSections}
            loadingText={t('gitFlow.loadingDiff')}
            stagedLabel={t('gitFlow.stagedDiff')}
            unstagedLabel={file.untracked ? t('gitFlow.untrackedDiff') : t('gitFlow.unstagedDiff')}
            untrackedLabel={t('gitFlow.untrackedDiff')}
            noDiffText={file.untracked ? t('gitFlow.untrackedNoDiff') : t('gitFlow.noDiff')}
            truncatedText={t('gitFlow.diffTruncated')}
          />
        )}
      </div>
    )
  }

  const renderFlatList = (section: ChangeSectionId, list: ChangeFile[]) => (
    <div className="rounded-md bg-muted/[0.06]">
      {list.map(file => renderFileRow(file, section))}
    </div>
  )

  const renderSectionHeader = (
    id: ChangeSectionId,
    title: string,
    count: number,
    actions?: React.ReactNode,
    tone: 'default' | 'danger' = 'default',
  ) => {
    const collapsedSection = sectionCollapsed[id]
    return (
      <div className="flex min-w-0 items-center gap-x-1.5">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          className="flex h-6 min-w-0 items-center gap-1 rounded-sm text-left"
          aria-expanded={!collapsedSection}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
              !collapsedSection && 'rotate-90',
            )}
          />
          <span
            className={cn(
              'shrink-0 whitespace-nowrap text-body font-medium leading-none',
              tone === 'danger' ? 'text-destructive' : 'text-foreground',
            )}
          >
            {title}
          </span>
        </button>
        <span
          className={cn(
            'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-caption font-medium leading-none tabular-nums',
            tone === 'danger'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-primary/15 text-primary-text',
          )}
        >
          {count}
        </span>
        <span className="flex-1" />
        {actions}
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-3">
      {sections.conflicts.length > 0 && (
        <section className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/[0.04] p-2">
          {renderSectionHeader(
            'conflicts',
            t('gitFlow.conflictsSection'),
            sections.conflicts.length,
            undefined,
            'danger',
          )}
          {!sectionCollapsed.conflicts && (
            <>
              <p className="px-1 text-caption text-destructive/80">
                {t('gitFlow.conflictsHint')}
              </p>
              {renderFlatList('conflicts', sections.conflicts)}
            </>
          )}
        </section>
      )}

      {sections.staged.length > 0 && (
        <section className="space-y-1.5">
          {renderSectionHeader(
            'staged',
            t('gitFlow.stagedFiles'),
            sections.staged.length,
            <button
              type="button"
              disabled={Boolean(actionKey)}
              onClick={() => void unstageAllStaged()}
              title={t('gitFlow.unstageAll')}
              aria-label={t('gitFlow.unstageAll')}
              className={ROW_ACTION_UNSTAGE}
            >
              {actionKey === 'unstage-all'
                ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                : <Minus className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
            </button>,
          )}
          {!sectionCollapsed.staged && renderFlatList('staged', sections.staged)}
        </section>
      )}

      {sections.unstaged.length > 0 && (
        <section className="space-y-1.5">
          {renderSectionHeader(
            'unstaged',
            t('gitFlow.unstagedFiles'),
            sections.unstaged.length,
            <button
              type="button"
              disabled={Boolean(actionKey)}
              onClick={() => void stageAllUnstaged()}
              title={t('gitFlow.stageAll')}
              aria-label={t('gitFlow.stageAll')}
              className={ROW_ACTION_STAGE}
            >
              {actionKey === 'stage-all'
                ? <Loader2 className={`${ROW_ACTION_ICON_CLASS} animate-spin`} strokeWidth={ROW_ACTION_ICON_STROKE} />
                : <Plus className={ROW_ACTION_ICON_CLASS} strokeWidth={ROW_ACTION_ICON_STROKE} />}
            </button>,
          )}
          {!sectionCollapsed.unstaged && renderFlatList('unstaged', sections.unstaged)}
        </section>
      )}

      <TabCodeConfirmDialog
        open={Boolean(discardTarget)}
        onOpenChange={(open) => { if (!open) setDiscardTarget(null) }}
        title={t('gitFlow.discardChanges')}
        description={discardDescription}
        variant="destructive"
        confirmLabel={t('gitFlow.discardChanges')}
        onConfirm={() => void doDiscard()}
      />
    </div>
  )
}

function FileDiffPreview({
  loading,
  sections,
  loadingText,
  stagedLabel,
  unstagedLabel,
  untrackedLabel,
  noDiffText,
  truncatedText,
}: {
  loading: boolean
  sections: DiffSection[]
  loadingText: string
  stagedLabel: string
  unstagedLabel: string
  untrackedLabel: string
  noDiffText: string
  truncatedText: string
}) {
  if (loading) {
    return (
      <div className="border-t border-border/30 bg-background/40 px-3 py-2 pl-6 text-caption text-muted-foreground/60">
        <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
        {loadingText}
      </div>
    )
  }

  return (
    <div className="space-y-2 border-t border-border/30 bg-background/40 px-3 py-2 pl-6">
      {sections.map(section => (
        <div key={section.scope} className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-caption text-muted-foreground/80">
            <span>{section.scope === 'staged' ? stagedLabel : section.scope === 'untracked' ? untrackedLabel : unstagedLabel}</span>
            {section.truncated && <span className="text-warning">{truncatedText}</span>}
          </div>
          {section.error ? (
            <div className="rounded border border-destructive/20 bg-destructive/5 px-2 py-1 text-caption text-destructive">
              {section.error}
            </div>
          ) : section.diff ? (
            <pre className="max-h-[320px] overflow-auto rounded bg-muted/20 p-2 text-caption font-mono leading-4 whitespace-pre">
              {section.diff.split('\n').map((line, index) => (
                <span key={index} className={diffLineClass(line)}>
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : (
            <div className="rounded border border-border/40 bg-muted/[0.12] px-2 py-1 text-caption text-muted-foreground/60">
              {noDiffText}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-success'
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-destructive'
  if (line.startsWith('@@')) return 'text-info'
  if (line.startsWith('diff') || line.startsWith('index')) return 'text-muted-foreground/60'
  return 'text-foreground/80'
}

export default ChangesPanel
