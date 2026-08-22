/**
 * CompactGitStatus — 远程 Daemon Git 状态紧凑展示
 *
 * 显示分支名、dirty 指示器、行变更统计、ahead/behind 状态。
 * 点击可展开文件列表面板。
 */
import React, { useEffect, useRef, useState } from 'react'
import { GitBranch, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useGitStatusStore } from '@stores/useGitStatusStore'
import type { RemoteGitStatus, GitFileEntry } from '@tabtin/app-shell'
import { cn } from '@utils/cn'

/**
 * Returns true for ~600ms after `value` changes (skipping initial render).
 * Used to flash-highlight numbers on real-time git status updates.
 */
function useFlash(value: number): boolean {
  const prevRef = useRef(value)
  const mountedRef = useRef(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    if (prevRef.current !== value) {
      prevRef.current = value
      setFlash(true)
      const timer = setTimeout(() => setFlash(false), 600)
      return () => clearTimeout(timer)
    }
  }, [value])

  return flash
}

interface CompactGitStatusProps {
  spaceId: string
  className?: string
}

export const CompactGitStatus: React.FC<CompactGitStatusProps> = ({ spaceId, className }) => {
  const { t } = useTranslation('space')
  const gitStatus = useGitStatusStore((s) => s.statusBySpaceId[spaceId])
  const setupWs = useGitStatusStore((s) => s.setupWsListener)
  const teardownWs = useGitStatusStore((s) => s.teardownWsListener)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setupWs()
    return () => { teardownWs() }
  }, [])

  const totalAdded = gitStatus
    ? gitStatus.staged_lines_added + gitStatus.unstaged_lines_added
    : 0
  const totalRemoved = gitStatus
    ? gitStatus.staged_lines_removed + gitStatus.unstaged_lines_removed
    : 0
  const addedFlash = useFlash(totalAdded)
  const removedFlash = useFlash(totalRemoved)

  if (!gitStatus || !gitStatus.is_repo) return null

  const hasChanges = gitStatus.is_dirty

  return (
    <div className={cn('select-none', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-caption w-full',
          'hover:bg-muted/60 transition-colors',
          hasChanges ? 'text-foreground/80' : 'text-muted-foreground/60',
        )}
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        <span className="font-medium truncate max-w-[120px]">
          {gitStatus.branch ?? t('gitStatus.detached')}
        </span>

        {hasChanges && (
          <>
            <span className="text-muted-foreground/40">·</span>
            {totalAdded > 0 && (
              <span className={cn(
                'font-mono transition-colors duration-500',
                addedFlash ? 'text-success font-bold' : 'text-success',
              )}>+{totalAdded}</span>
            )}
            {totalRemoved > 0 && (
              <span className={cn(
                'font-mono transition-colors duration-500',
                removedFlash ? 'text-destructive font-bold' : 'text-destructive',
              )}>-{totalRemoved}</span>
            )}
          </>
        )}

        {!hasChanges && (
          <span className="text-muted-foreground/40 text-caption">✓</span>
        )}

        <UpstreamBadge ahead={gitStatus.ahead_count} behind={gitStatus.behind_count} />

        {hasChanges && gitStatus.files.length > 0 && (
          expanded
            ? <ChevronUp className="h-3 w-3 ml-auto shrink-0 text-muted-foreground/40" />
            : <ChevronDown className="h-3 w-3 ml-auto shrink-0 text-muted-foreground/40" />
        )}
      </button>

      {expanded && hasChanges && gitStatus.files.length > 0 && (
        <GitFileList
          spaceId={spaceId}
          files={gitStatus.files}
          totalCount={gitStatus.total_file_count}
        />
      )}
    </div>
  )
}

function UpstreamBadge({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null
  return (
    <span className="text-caption text-muted-foreground/60 font-mono">
      {ahead > 0 && `↑${ahead}`}
      {behind > 0 && `↓${behind}`}
    </span>
  )
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: 'text-warning' },
  A: { label: 'A', color: 'text-success' },
  D: { label: 'D', color: 'text-destructive' },
  R: { label: 'R', color: 'text-info' },
  C: { label: 'C', color: 'text-info' },
  '?': { label: '?', color: 'text-muted-foreground/60' },
}

function GitFileList({
  spaceId,
  files,
  totalCount,
}: {
  spaceId: string
  files: GitFileEntry[]
  totalCount?: number
}) {
  const { t } = useTranslation('space')
  const maxDisplay = 20
  const displayFiles = files.slice(0, maxDisplay)
  const remaining = (totalCount ?? files.length) - displayFiles.length
  const [activeDiff, setActiveDiff] = useState<string | null>(null)
  const [diffContent, setDiffContent] = useState<string>('')
  const [diffLoading, setDiffLoading] = useState(false)
  const requestDiff = useGitStatusStore((s) => s.requestFileDiff)
  const activeDiffRef = useRef<string | null>(null)
  activeDiffRef.current = activeDiff

  const handleFileClick = async (file: GitFileEntry) => {
    const key = `${file.path}:${file.is_staged}`
    if (activeDiff === key) {
      setActiveDiff(null)
      return
    }
    if (file.status === '?') return

    setActiveDiff(key)
    setDiffLoading(true)
    const requestKey = key
    try {
      const diff = await requestDiff(spaceId, file.path, file.is_staged)
      if (activeDiffRef.current === requestKey) {
        setDiffContent(diff)
      }
    } catch {
      if (activeDiffRef.current === requestKey) {
        setDiffContent('')
      }
    } finally {
      if (activeDiffRef.current === requestKey) {
        setDiffLoading(false)
      }
    }
  }

  return (
    <div className="mt-1 ml-1 border-l border-border/30 pl-2.5 space-y-0.5 max-h-[300px] overflow-y-auto">
      {displayFiles.map((file) => {
        const cfg = (file.status ? STATUS_CONFIG[file.status] : undefined) ?? STATUS_CONFIG['?']
        const key = `${file.path}:${file.is_staged}`
        const isActive = activeDiff === key
        const canDiff = file.status !== '?'
        return (
          <div key={key}>
            <button
              onClick={() => canDiff && handleFileClick(file)}
              className={cn(
                'flex items-center gap-1.5 text-caption py-0.5 w-full text-left rounded-sm',
                canDiff && 'hover:bg-muted/40 cursor-pointer',
                isActive && 'bg-muted/30',
              )}
            >
              <span className={cn('font-mono w-3 text-center shrink-0', cfg.color)}>
                {cfg.label}
              </span>
              <span className="truncate text-foreground/80 min-w-0">{file.path}</span>
              {(file.lines_added !== undefined || file.lines_removed !== undefined) && (
                <span className="ml-auto shrink-0 font-mono text-caption text-muted-foreground/60">
                  {file.lines_added ? `+${file.lines_added}` : ''}
                  {file.lines_removed ? ` -${file.lines_removed}` : ''}
                </span>
              )}
            </button>
            {isActive && (
              <DiffPreview loading={diffLoading} diff={diffContent} />
            )}
          </div>
        )
      })}
      {remaining > 0 && (
        <div className="text-caption text-muted-foreground/40 py-0.5">
          {t('gitStatus.moreFiles', { count: remaining })}
        </div>
      )}
    </div>
  )
}

function DiffPreview({ loading, diff }: { loading: boolean; diff: string }) {
  const { t } = useTranslation('space')
  if (loading) {
    return (
      <div className="ml-4 my-1 text-caption text-muted-foreground/60 animate-pulse">
        {t('gitStatus.loadingDiff')}
      </div>
    )
  }
  if (!diff) {
    return (
      <div className="ml-4 my-1 text-caption text-muted-foreground/40">
        {t('gitStatus.noDiff')}
      </div>
    )
  }
  return (
    <pre className="ml-4 my-1 p-2 rounded bg-muted/20 text-caption font-mono leading-4 max-h-[200px] overflow-auto whitespace-pre">
      {diff.split('\n').map((line, i) => {
        let color = 'text-foreground/60'
        if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-success'
        else if (line.startsWith('-') && !line.startsWith('---')) color = 'text-destructive'
        else if (line.startsWith('@@')) color = 'text-info'
        else if (line.startsWith('diff') || line.startsWith('index')) color = 'text-muted-foreground/40'
        return (
          <span key={i} className={color}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}
