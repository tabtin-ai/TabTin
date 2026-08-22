import React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import type { SessionRollbackState } from '@tabtin/chat-client'
import {
  getRollbackResourceDetailsFromState,
  hasWorkspaceFilesFailure,
} from '../../../../stores/chat/checkpoint/utils/rollbackResult'
import type { CheckpointSemanticFeedback } from './deriveRewindPreviewUi'
import { RewindDecisionSummary, RewindNoImpactNotice } from './RewindDecisionSummary'
import { PreviousRollbackIssueBanner } from './PreviousRollbackIssueBanner'
import { RewindPreviewImpactSections } from './RewindPreviewImpactSections'

interface RewindPreviewLoadedContentProps {
  preview: RollbackPreviewResult
  noImpact: boolean
  rollbackState: SessionRollbackState | null | undefined
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  hasLatestRollbackOpenIssues: boolean
  showFileImpact: boolean
  excludedResources: Set<string>
  onToggleResource: (key: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  i18nLanguage: string
}

export const RewindPreviewLoadedContent: React.FC<RewindPreviewLoadedContentProps> = ({
  preview,
  noImpact,
  rollbackState,
  checkpointSemanticFeedback,
  hasLatestRollbackOpenIssues,
  showFileImpact,
  excludedResources,
  onToggleResource,
  t,
  i18nLanguage,
}) => {
  const latestRollbackResourceDetails = getRollbackResourceDetailsFromState(rollbackState)
  const latestRollbackHasFileFailure = hasWorkspaceFilesFailure(rollbackState?.partial_success_details)

  return (
    <>
      {preview.target_timestamp && !noImpact && (
        <div className="text-body text-muted-foreground">
          {t('rewind.willRewindTo', { defaultValue: '将回到：' })}
          <span className="font-medium text-foreground">
            {new Date(preview.target_timestamp).toLocaleString(i18nLanguage || 'zh-CN')}
          </span>
        </div>
      )}

      {!noImpact && preview.effective_checkpoint && (
        <RewindDecisionSummary checkpointRecord={preview.effective_checkpoint} t={t} />
      )}

      {noImpact && <RewindNoImpactNotice t={t} />}

      {checkpointSemanticFeedback && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
          <span className="text-body text-muted-foreground">{checkpointSemanticFeedback.summary}</span>
        </div>
      )}

      {hasLatestRollbackOpenIssues && (
        <PreviousRollbackIssueBanner
          rollbackState={rollbackState}
          latestRollbackResourceDetails={latestRollbackResourceDetails}
          latestRollbackHasFileFailure={latestRollbackHasFileFailure}
          t={t}
        />
      )}

      <RewindPreviewImpactSections
        preview={preview}
        noImpact={noImpact}
        showFileImpact={showFileImpact}
        excludedResources={excludedResources}
        checkpointSemanticFeedback={checkpointSemanticFeedback}
        onToggleResource={onToggleResource}
        t={t}
      />

      {(preview.unrestorable_items?.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
          <div className="space-y-1">
            {(preview.unrestorable_items ?? []).map((item, i) => (
              <p key={i} className="text-body text-warning">{item}</p>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
