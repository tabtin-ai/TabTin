/**
 * TabCode 只读 Git History：当前分支提交列表，点选后复用连续 Diff。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { History, Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { GitCommitDetailResult, GitCommitListItem } from '@shared/git-types'
import type { GitLogFailureReason } from '@shared/git-log-errors'
import { ContinuousChangesDiff } from '@components/context-space/code-workspace/ContinuousChangesDiff'
import {
  ChangesFileTree,
  type ChangesFileSelection,
} from '@components/context-space/code-workspace/ChangesFileTree'
import {
  buildCommitContentRevisions,
  joinRootPath,
  mapCommitFilesToChangeFiles,
  resolveNavigationAnchor,
} from '@components/context-space/code-workspace/changesViewModel'
import { GitHistoryLinearMarker } from './GitHistoryLinearMarker'

const TREE_MIN_WIDTH = 200
const TREE_MAX_WIDTH = 480
const TREE_DEFAULT_WIDTH = 288
const LIST_MIN_WIDTH = 280
const LIST_MAX_WIDTH = 520
const LIST_DEFAULT_WIDTH = 360
const HOVER_TIP_DELAY_MS = 1000
const HOVER_TIP_OFFSET_X = 12
const HOVER_TIP_OFFSET_Y = 16
const HOVER_TIP_DISMISS_DISTANCE_PX = 28

interface CommitHoverTipContent {
  subject: string
  authorName: string
  authoredAt: string
  shortHash: string
  refs: string
}

interface CommitHoverTip extends CommitHoverTipContent {
  x: number
  y: number
}

function hoverDistance(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

function clampHoverTipPosition(x: number, y: number): { left: number; top: number } {
  const left = x + HOVER_TIP_OFFSET_X
  const top = y + HOVER_TIP_OFFSET_Y
  const maxLeft = Math.max(8, window.innerWidth - 328)
  const maxTop = Math.max(8, window.innerHeight - 160)
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top: Math.min(Math.max(8, top), maxTop),
  }
}

function formatCommitTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function clampTreeWidth(width: number): number {
  return Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, Math.round(width)))
}

function clampListWidth(width: number): number {
  return Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, Math.round(width)))
}

export interface GitHistoryPaneProps {
  rootPath: string
  refreshToken?: number
  /** 外层 Context 标签是否激活；保活 pane 隐藏时清掉 body portal 浮层。 */
  isPaneActive?: boolean
}

export function GitHistoryPane({
  rootPath,
  refreshToken = 0,
  isPaneActive = true,
}: GitHistoryPaneProps): React.ReactElement {
  const { t } = useTranslation('tabcode')
  const [commits, setCommits] = useState<GitCommitListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetailResult | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_WIDTH)
  const [listWidth, setListWidth] = useState(LIST_DEFAULT_WIDTH)
  const [isTreeResizing, setIsTreeResizing] = useState(false)
  const [isListResizing, setIsListResizing] = useState(false)
  const loadedRootRef = useRef<string | null>(null)
  const treeResizeCleanupRef = useRef<(() => void) | null>(null)
  const listResizeCleanupRef = useRef<(() => void) | null>(null)
  const [hoverTip, setHoverTip] = useState<CommitHoverTip | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverOriginRef = useRef({ x: 0, y: 0 })
  const hoverContentRef = useRef<CommitHoverTipContent | null>(null)

  const clearHoverTip = useCallback(() => {
    if (hoverTimerRef.current != null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    hoverContentRef.current = null
    setHoverTip(null)
  }, [])

  useEffect(() => {
    if (isPaneActive) return
    clearHoverTip()
  }, [clearHoverTip, isPaneActive])

  const scheduleHoverTip = useCallback((content: CommitHoverTipContent, event: React.MouseEvent) => {
    hoverOriginRef.current = { x: event.clientX, y: event.clientY }
    hoverContentRef.current = content
    if (hoverTimerRef.current != null) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => {
      const next = hoverContentRef.current
      if (!next) return
      setHoverTip({
        ...next,
        x: hoverOriginRef.current.x,
        y: hoverOriginRef.current.y,
      })
    }, HOVER_TIP_DELAY_MS)
  }, [])

  const dismissHoverTipIfMovedFar = useCallback((event: React.MouseEvent) => {
    if (hoverDistance(hoverOriginRef.current, { x: event.clientX, y: event.clientY }) < HOVER_TIP_DISMISS_DISTANCE_PX) {
      return
    }
    clearHoverTip()
  }, [clearHoverTip])

  useEffect(() => {
    return () => {
      treeResizeCleanupRef.current?.()
      treeResizeCleanupRef.current = null
      listResizeCleanupRef.current?.()
      listResizeCleanupRef.current = null
      if (hoverTimerRef.current != null) {
        clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const isInitial = loadedRootRef.current !== rootPath
      if (isInitial) {
        setLoading(true)
        setSelectedHash(null)
        setDetail(null)
        setSelectedRelativePath(null)
      }
      setLoadError(null)
      try {
        const result = await window.tabtin?.git?.listCommits?.(rootPath)
        if (cancelled) return
        if (!result) {
          setCommits([])
          setLoadError(t('gitHistory.ipcUnavailable'))
          return
        }
        if (!result.success) {
          setCommits([])
          const reason = (result as { reason?: GitLogFailureReason }).reason
          if (reason === 'path_not_found') {
            setLoadError(t('gitHistory.pathMissing'))
          } else if (reason === 'permission_denied') {
            setLoadError(t('gitHistory.permissionDenied'))
          } else {
            setLoadError(result.error || t('gitHistory.loadFailed'))
          }
          return
        }
        setCommits(result.commits || [])
        loadedRootRef.current = rootPath
        setSelectedHash((prev) => {
          if (prev && (result.commits || []).some((commit) => commit.hash === prev)) return prev
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
          setDetailError(next?.error || t('gitHistory.detailFailed'))
          setSelectedRelativePath(null)
          return
        }
        setDetail(next)
        const mapped = mapCommitFilesToChangeFiles(next.files)
        setSelectedRelativePath((prev) => resolveNavigationAnchor(mapped, prev))
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
    () => commits.find((commit) => commit.hash === selectedHash) || activeDetail?.commit || null,
    [commits, selectedHash, activeDetail?.commit],
  )

  const handleSelectFile = useCallback((next: ChangesFileSelection) => {
    setSelectedRelativePath(next.relativePath)
  }, [])

  const handleTreeResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    treeResizeCleanupRef.current?.()
    setIsTreeResizing(true)
    const startX = event.clientX
    const startWidth = treeWidth
    const onMouseMove = (moveEvent: MouseEvent) => {
      setTreeWidth(clampTreeWidth(startWidth - (moveEvent.clientX - startX)))
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

  const handleListResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    listResizeCleanupRef.current?.()
    setIsListResizing(true)
    const startX = event.clientX
    const startWidth = listWidth
    const onMouseMove = (moveEvent: MouseEvent) => {
      setListWidth(clampListWidth(startWidth + (moveEvent.clientX - startX)))
    }
    const cleanup = () => {
      setIsListResizing(false)
      listResizeCleanupRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', cleanup, true)
      window.removeEventListener('blur', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    listResizeCleanupRef.current = cleanup
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', cleanup, true)
    window.addEventListener('blur', cleanup)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [listWidth])

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-body text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('gitHistory.loading')}
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
        <p className="text-body text-muted-foreground/70">{t('gitHistory.empty')}</p>
      </div>
    )
  }

  const hoverTipNode = isPaneActive && hoverTip && typeof document !== 'undefined'
    ? createPortal(
      <div
        role="tooltip"
        data-testid="git-history-hover-tip"
        className="pointer-events-none fixed z-tooltip w-max max-w-sm rounded-md border border-border/50 bg-popover px-2.5 py-2 text-left text-popover-foreground shadow-md"
        style={clampHoverTipPosition(hoverTip.x, hoverTip.y)}
      >
        <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1 text-body leading-5">
          <span className="text-right text-muted-foreground">{t('gitHistory.tipMessage')}</span>
          <span className="min-w-0 break-words">{hoverTip.subject}</span>
          {hoverTip.shortHash ? (
            <>
              <span className="text-right text-muted-foreground">{t('gitHistory.tipHash')}</span>
              <span className="min-w-0 font-mono tabular-nums">{hoverTip.shortHash}</span>
            </>
          ) : null}
          {hoverTip.authorName ? (
            <>
              <span className="text-right text-muted-foreground">{t('gitHistory.tipAuthor')}</span>
              <span className="min-w-0 break-words">{hoverTip.authorName}</span>
            </>
          ) : null}
          {hoverTip.authoredAt ? (
            <>
              <span className="text-right text-muted-foreground">{t('gitHistory.tipTime')}</span>
              <span className="min-w-0 tabular-nums">{hoverTip.authoredAt}</span>
            </>
          ) : null}
          {hoverTip.refs ? (
            <>
              <span className="text-right text-muted-foreground">{t('gitHistory.tipRefs')}</span>
              <span className="min-w-0 break-words">{hoverTip.refs}</span>
            </>
          ) : null}
        </div>
      </div>,
      document.body,
    )
    : null
  const commitList = (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover" data-testid="git-history-list">
      {commits.map((commit, index) => {
        const isSelected = selectedHash === commit.hash
        const authoredAt = formatCommitTime(commit.authoredAt)
        const hoverLabel = [commit.subject, commit.authorName, authoredAt].filter(Boolean).join(' · ')
        const hoverContent: CommitHoverTipContent = {
          subject: commit.subject,
          authorName: commit.authorName || '',
          authoredAt,
          shortHash: commit.shortHash.slice(0, 7),
          refs: (commit.refs || []).map((ref) => ref.name).join(', '),
        }
        return (
          <button
            key={commit.hash}
            type="button"
            data-testid="git-history-item"
            data-commit-hash={commit.hash}
            aria-label={hoverLabel}
            className={cn(
              'flex h-7 w-full items-center gap-2 pr-3 text-left',
              isSelected ? 'bg-muted/45' : 'hover:bg-muted/25',
            )}
            onMouseEnter={(event) => scheduleHoverTip(hoverContent, event)}
            onMouseMove={dismissHoverTipIfMovedFar}
            onMouseLeave={clearHoverTip}
            onClick={() => {
              clearHoverTip()
              setSelectedHash((current) => (current === commit.hash ? null : commit.hash))
            }}
          >
            <GitHistoryLinearMarker
              connectsPrevious={index > 0}
              connectsNext={index < commits.length - 1}
              selected={isSelected}
            />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate text-body">{commit.subject}</span>
            </span>
            <span className="w-14 shrink-0 font-mono text-caption tabular-nums text-muted-foreground/70">
              {commit.shortHash.slice(0, 7)}
            </span>
            <span className="hidden w-24 shrink-0 truncate text-caption text-muted-foreground/60 @[560px]:block">
              {commit.authorName}
            </span>
            {authoredAt ? (
              <span className="hidden w-[4.5rem] shrink-0 text-right text-caption tabular-nums text-muted-foreground/50 @[720px]:block">
                {authoredAt}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )

  const diffPane = selectedHash ? (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {detailLoading && !activeDetail ? (
        <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('gitHistory.loadingDetail')}
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
          isBootstrapping={detailLoading && commitFiles.length === 0}
          emptyLabel={t('gitHistory.commitEmpty')}
        />
      )}
    </div>
  ) : null

  if (!selectedHash) {
    return (
      <div className="@container/git-history flex h-full min-h-0 w-full flex-col" data-testid="git-history-view">
        {commitList}
        {hoverTipNode}
      </div>
    )
  }

  return (
    <div
      className="@container/git-history flex h-full min-h-0 w-full"
      data-testid="git-history-view"
      data-selected="true"
    >
      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{ width: listWidth }}
        data-testid="git-history-list-pane"
      >
        {commitList}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={LIST_MIN_WIDTH}
        aria-valuemax={LIST_MAX_WIDTH}
        aria-valuenow={listWidth}
        aria-label={t('gitHistory.resizeCommitList')}
        data-testid="git-history-list-resize-handle"
        onMouseDown={handleListResizeStart}
        className={cn(
          'group relative z-sticky flex w-2 shrink-0 cursor-col-resize justify-center',
          'before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]',
        )}
      >
        <div
          className={cn(
            'h-full w-px transition-colors',
            isListResizing ? 'bg-border/80' : 'bg-border/40 group-hover:bg-border/60',
          )}
        />
      </div>

      {diffPane}

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={TREE_MIN_WIDTH}
        aria-valuemax={TREE_MAX_WIDTH}
        aria-valuenow={treeWidth}
        aria-label={t('gitHistory.resizeFileTree')}
        data-testid="git-history-resize-handle"
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
        className="flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/[0.04]"
        style={{ width: treeWidth }}
        data-testid="git-history-aside"
      >
        {selectedCommit ? (
          <div className="shrink-0 border-b border-border/40 px-3 py-2">
            <div className="flex items-start gap-2">
              <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-foreground">
                  {selectedCommit.subject}
                </p>
                <p className="truncate text-caption text-muted-foreground/70">
                  <span className="font-mono">{selectedCommit.shortHash}</span>
                  {' · '}
                  {selectedCommit.authorName}
                </p>
              </div>
            </div>
          </div>
        ) : null}
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
      </aside>
      {hoverTipNode}
    </div>
  )
}

export default GitHistoryPane
