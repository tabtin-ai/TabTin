import React from 'react'
import { FileText } from 'lucide-react'
import { SharedSessionFilePreviewPane } from '@/components/chat/shared-view/preview/SharedSessionFilePreviewPane'
import { SHARED_SESSION_FILE_TAB_TYPE } from '@/components/chat/shared-view/preview/sharedSessionFileTab'
import type { ContextTypeHandler } from '../types'
import { metaStr } from '../homeSections/metaFieldUtils'

export const sharedSessionFileHandler: ContextTypeHandler = {
  type: SHARED_SESSION_FILE_TAB_TYPE,
  persistOnly: true,

  getTabLabel: item => metaStr(item.meta, 'filename') || item.title || item.id,
  getTabIcon: () => <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />,
  getDragPayload: () => null,
  renderPane: item => {
    const sessionId = metaStr(item.meta, 'shared_session_id')
    const shareId = metaStr(item.meta, 'session_share_id')
    const relativePath = metaStr(item.meta, 'relative_path')
    if (!sessionId || !shareId || !relativePath) return null
    return (
      <SharedSessionFilePreviewPane
        target={{
          sessionId,
          shareId,
          relativePath,
          title: metaStr(item.meta, 'filename') || item.title,
        }}
      />
    )
  },
}
