import React from 'react'
import { AlertTriangle, Eye, Loader2 } from 'lucide-react'
import type { DiffFileEntry } from '../CheckpointDiffSheet'
import { MAX_FILE_PREVIEW_COUNT } from './deriveRewindPreviewUi'

interface RewindShadowGitFileDiffBodyProps {
  fileDiffs: DiffFileEntry[] | null
  fileDiffLoading: boolean
  fileDiffError: boolean
  onToggleFileDiff: () => void
  onShowFullDiff: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const RewindShadowGitFileDiffBody: React.FC<RewindShadowGitFileDiffBodyProps> = ({
  fileDiffs,
  fileDiffLoading,
  fileDiffError,
  onToggleFileDiff,
  onShowFullDiff,
  t,
}) => (
  <div className="mt-2 ml-5 space-y-0.5">
    {fileDiffLoading && (
      <div className="flex items-center gap-1.5 py-1 text-body text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('rewind.loadingFiles', { defaultValue: '加载文件变更...' })}
      </div>
    )}
    {fileDiffError && !fileDiffLoading && (
      <div className="flex items-center gap-1.5 py-1 text-body text-muted-foreground">
        <AlertTriangle className="h-3 w-3" />
        {t('rewind.fileDiffError', { defaultValue: '无法获取文件变更详情' })}
        <button onClick={onToggleFileDiff} className="ml-1 hover:underline">{t('rewind.retry', { defaultValue: '重试' })}</button>
      </div>
    )}
    {fileDiffs && fileDiffs.length === 0 && !fileDiffLoading && !fileDiffError && (
      <p className="text-body text-muted-foreground py-1">{t('rewind.noFileChanges', { defaultValue: '未检测到文件变更' })}</p>
    )}
    {fileDiffs && fileDiffs.length > 0 && !fileDiffLoading && !fileDiffError && (
      <>
        {fileDiffs.slice(0, MAX_FILE_PREVIEW_COUNT).map((f) => (
          <div key={f.path} className="flex min-w-0 items-center gap-1.5 font-mono text-caption text-muted-foreground">
            <span className={`w-3 shrink-0 text-center font-bold ${f.status === 'added' ? 'text-success' : f.status === 'deleted' ? 'text-destructive' : 'text-warning'}`}>
              {f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : 'M'}
            </span>
            <span className="min-w-0 flex-1 truncate">{f.path}</span>
          </div>
        ))}
        {fileDiffs.length > MAX_FILE_PREVIEW_COUNT && (
          <p className="text-caption text-muted-foreground/60 ml-4">...{t('rewind.moreFiles', { count: fileDiffs.length - MAX_FILE_PREVIEW_COUNT, defaultValue: '还有 {{count}} 个文件' })}</p>
        )}
        <button onClick={onShowFullDiff} className="flex items-center gap-1 mt-1.5 text-caption text-primary hover:underline">
          <Eye className="h-3 w-3" />{t('rewind.viewDetailedDiff', { defaultValue: '查看详细变更' })}
        </button>
      </>
    )}
  </div>
)
