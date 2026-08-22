import React from 'react'
import { FileText } from 'lucide-react'
import { MAX_FILE_PREVIEW_COUNT } from './deriveRewindPreviewUi'

interface RewindAffectedPathsSectionProps {
  paths: string[]
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const RewindAffectedPathsSection: React.FC<RewindAffectedPathsSectionProps> = ({ paths, t }) => (
  <div className="rounded-lg border border-border bg-muted/30 p-3">
    <div className="flex items-center gap-2 mb-2">
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-body font-medium">
        {t('rewind.fileRestoreCount', { count: paths.length, defaultValue: '将恢复 {{count}} 个文件' })}
      </span>
    </div>
    <div className="space-y-0.5 ml-6">
      {paths.slice(0, MAX_FILE_PREVIEW_COUNT).map((p) => (
        <div key={p} className="flex min-w-0 items-center gap-1.5 font-mono text-caption text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={p}>{p}</span>
        </div>
      ))}
      {paths.length > MAX_FILE_PREVIEW_COUNT && (
        <p className="text-caption text-muted-foreground/60">
          ...{t('rewind.moreFiles', { count: paths.length - MAX_FILE_PREVIEW_COUNT, defaultValue: '还有 {{count}} 个文件' })}
        </p>
      )}
    </div>
  </div>
)
