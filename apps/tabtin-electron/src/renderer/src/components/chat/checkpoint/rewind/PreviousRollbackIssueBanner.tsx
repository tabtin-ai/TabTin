import React from 'react'
import { AlertTriangle } from 'lucide-react'
import type { SessionRollbackState } from '@tabtin/chat-client'
import type { getRollbackResourceDetailsFromState } from '../../../../stores/chat/checkpoint/utils/rollbackResult'
import {
  derivePreviousRollbackIssueMessage,
  deriveRollbackFilesLayerLabel,
  deriveRollbackResourceLayerLabel,
} from './rewindPreviewFullPanelLogic'

interface PreviousRollbackIssueBannerProps {
  rollbackState: SessionRollbackState | null | undefined
  latestRollbackResourceDetails: ReturnType<typeof getRollbackResourceDetailsFromState>
  latestRollbackHasFileFailure: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const PreviousRollbackIssueBanner: React.FC<PreviousRollbackIssueBannerProps> = ({
  rollbackState,
  latestRollbackResourceDetails,
  latestRollbackHasFileFailure,
  t,
}) => {
  const message = derivePreviousRollbackIssueMessage({
    latestRollbackResourceDetails,
    latestRollbackHasFileFailure,
    t,
  })
  const resourceLayerLabel = deriveRollbackResourceLayerLabel({ latestRollbackResourceDetails, t })
  const filesLayerLabel = deriveRollbackFilesLayerLabel({ latestRollbackHasFileFailure, t })

  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2">
      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
      <div className="space-y-1 min-w-0">
        <span className="text-body text-warning">{message}</span>
        {rollbackState?.last_apply_result === 'partial_success' && (
          <ul className="text-caption text-muted-foreground space-y-0.5">
            <li>
              {t('checkpoint.layerConversation', { defaultValue: '对话' })}：
              {t('checkpoint.layerConversationRolledBack', { defaultValue: '已回退' })}
            </li>
            <li>
              {t('checkpoint.layerFiles', { defaultValue: '文件' })}：{filesLayerLabel}
            </li>
            {resourceLayerLabel && (
              <li>
                {t('checkpoint.layerResources', { defaultValue: '资源' })}：{resourceLayerLabel}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
