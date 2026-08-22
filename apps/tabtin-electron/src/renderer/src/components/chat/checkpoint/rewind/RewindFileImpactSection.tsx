import React from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
} from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import type { DiffFileEntry } from '../CheckpointDiffSheet'
import { type FileDiffSummary } from './deriveRewindPreviewUi'
import { RewindAffectedPathsSection } from './RewindAffectedPathsSection'
import { RewindShadowGitFileDiffBody } from './RewindShadowGitFileDiffBody'

interface RewindShadowGitFileDiffSectionProps {
  preview: RollbackPreviewResult
  localAnchorId: string | null
  fileCheckpointHash: string | null
  usesShadowGitFileDiff: boolean
  fileDiffExpanded: boolean
  fileDiffs: DiffFileEntry[] | null
  fileDiffLoading: boolean
  fileDiffError: boolean
  fileDiffSummary: FileDiffSummary | null
  onToggleFileDiff: () => void
  onShowFullDiff: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const ShadowGitHintBanner: React.FC<{ t: RewindShadowGitFileDiffSectionProps['t'] }> = ({ t }) => (
  <div className="flex items-start gap-2 mb-2 rounded-md border border-warning/20 bg-warning/5 px-2.5 py-2">
    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
    <p className="text-caption text-warning">
      {t('rewind.fileDiffShadowGitHint', {
        defaultValue: '以下差异按历史快照估算，可能与实际恢复不一致；实际恢复以文件历史记录为准。',
      })}
    </p>
  </div>
)

const FileDiffToggleHeader: React.FC<{
  fileDiffExpanded: boolean
  fileDiffSummary: FileDiffSummary | null
  onToggleFileDiff: () => void
  t: RewindShadowGitFileDiffSectionProps['t']
}> = ({ fileDiffExpanded, fileDiffSummary, onToggleFileDiff, t }) => (
  <button onClick={onToggleFileDiff} className="flex items-center gap-2 w-full text-left">
    {fileDiffExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
    <span className="text-body font-medium flex-1">
      {fileDiffSummary
        ? t('rewind.fileRestoreDetail', { total: fileDiffSummary.total, defaultValue: '{{total}} 个文件将变更' })
        : t('rewind.fileRestore', { defaultValue: '文件将恢复到检查点状态' })}
    </span>
    {fileDiffSummary && (
      <div className="flex items-center gap-1.5 text-caption">
        {fileDiffSummary.added > 0 && <span className="text-success">+{fileDiffSummary.added}</span>}
        {fileDiffSummary.modified > 0 && <span className="text-warning">~{fileDiffSummary.modified}</span>}
        {fileDiffSummary.deleted > 0 && <span className="text-destructive">-{fileDiffSummary.deleted}</span>}
      </div>
    )}
  </button>
)

export const RewindShadowGitFileDiffSection: React.FC<RewindShadowGitFileDiffSectionProps> = ({
  preview,
  localAnchorId,
  fileCheckpointHash,
  usesShadowGitFileDiff,
  fileDiffExpanded,
  fileDiffs,
  fileDiffLoading,
  fileDiffError,
  fileDiffSummary,
  onToggleFileDiff,
  onShowFullDiff,
  t,
}) => {
  const showSection = (preview.impact?.files.available ?? false) || !!localAnchorId || !!fileCheckpointHash
  if (!showSection) return null

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      {usesShadowGitFileDiff && <ShadowGitHintBanner t={t} />}
      <FileDiffToggleHeader
        fileDiffExpanded={fileDiffExpanded}
        fileDiffSummary={fileDiffSummary}
        onToggleFileDiff={onToggleFileDiff}
        t={t}
      />
      {fileDiffExpanded && (
        <RewindShadowGitFileDiffBody
          fileDiffs={fileDiffs}
          fileDiffLoading={fileDiffLoading}
          fileDiffError={fileDiffError}
          onToggleFileDiff={onToggleFileDiff}
          onShowFullDiff={onShowFullDiff}
          t={t}
        />
      )}
    </div>
  )
}

export const RewindFileImpactSection: React.FC<RewindShadowGitFileDiffSectionProps & {
  effectiveAffectedPaths: string[] | null
}> = ({ effectiveAffectedPaths, ...shadowGitProps }) => {
  if (effectiveAffectedPaths !== null) {
    if (effectiveAffectedPaths.length === 0) return null
    return <RewindAffectedPathsSection paths={effectiveAffectedPaths} t={shadowGitProps.t} />
  }
  return <RewindShadowGitFileDiffSection {...shadowGitProps} />
}
