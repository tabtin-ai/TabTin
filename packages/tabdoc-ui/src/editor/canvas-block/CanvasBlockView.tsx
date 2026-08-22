import React, { useCallback } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Presentation, Trash2, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { useTabDocHostActions } from '../../TabDocHostActionsContext'

export const CanvasBlockView: React.FC<NodeViewProps> = ({
  node,
  deleteNode,
  selected,
}) => {
  const { t } = useTranslation('tabdoc')
  const hostActions = useTabDocHostActions()

  const attrs = node.attrs ?? {}
  const canvasId = typeof attrs.canvasId === 'string' ? attrs.canvasId : ''
  const title = typeof attrs.title === 'string' ? attrs.title : ''

  const handleOpenInTab = useCallback(() => {
    if (!canvasId) return
    void hostActions.openResource({
      resourceType: 'tabwhiteboard',
      resourceId: canvasId,
      title,
    }).catch((error: unknown) => {
      toast({
        title: t('canvasBlock.navigateFailed', {
          defaultValue: '无法打开画布',
        }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    })
  }, [hostActions, canvasId, t, title])

  return (
    <NodeViewWrapper
      data-type="tabwhiteboard"
      className={`tabwhiteboard-block my-2 rounded-lg border ${
        selected ? 'border-primary ring-1 ring-primary/30' : 'border-muted'
      } bg-muted/30 transition-colors`}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Presentation className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-body truncate">
            {title || t('canvasBlock.untitled', { defaultValue: '未命名画布' })}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            onClick={handleOpenInTab}
            title={t('canvasBlock.openInTab', { defaultValue: '在新标签中打开' })}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            onClick={deleteNode}
            title={t('canvasBlock.delete', { defaultValue: '删除' })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </NodeViewWrapper>
  )
}
