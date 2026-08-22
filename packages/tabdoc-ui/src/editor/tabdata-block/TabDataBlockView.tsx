import React, { useCallback, useId, useRef } from 'react'
import { TABDATA_MIN_HEIGHT, TABDATA_DEFAULT_HEIGHT, TABDATA_MAX_HEIGHT } from './constants'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useInViewport } from './useInViewport'
import { useResizeHandle } from './useResizeHandle'
import { toast } from '@tabtin/smartsheet-ui'
import { useTabDocHostActions } from '../../TabDocHostActionsContext'
import { useTabDocSurface } from '../../TabDocSurfaceContext'
import { resolveTabDataBlockSurfaceState } from './tabDataBlockSurface'

/**
 * TabDataBlockView — 宿主无关的 TabData 嵌入块 NodeView。
 *
 * 渲染嵌入表格的占位/容器 UI。实际的表格渲染通过
 * renderTableEmbed 回调注入，由宿主（Electron/Web）提供。
 *
 * 设计说明：table store (useTableStore/useViewStore/useRecordStore) 属于宿主层，
 * 此组件不直接依赖它们，而是通过 renderTableEmbed 将渲染委托给宿主。
 */

export interface TabDataBlockRenderProps {
  tableId: string
  viewId: string | null
  title: string
  maxHeight: number
  onOpenInTab: () => void
  onDelete: () => void
  onUpdateAttributes: (attrs: Record<string, unknown>) => void
  /** 当前嵌入位置的运行时身份，不写入文档内容。 */
  surfaceId: string
  /** 父 TabDoc 当前允许该 block 接管输入与 awareness。 */
  isSurfaceActive: boolean
}

export interface TabDataBlockViewConfig {
  renderTableEmbed?: (props: TabDataBlockRenderProps) => React.ReactNode
}

let _tabDataBlockViewConfig: TabDataBlockViewConfig = {}

export function configureTabDataBlockView(config: TabDataBlockViewConfig) {
  _tabDataBlockViewConfig = config
}

export const TabDataBlockView: React.FC<NodeViewProps> = ({
  node,
  deleteNode,
  updateAttributes,
  selected,
}) => {
  const { t } = useTranslation('tabdoc')
  const hostActions = useTabDocHostActions()
  const hostSurface = useTabDocSurface()
  const blockInstanceId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const isInViewport = useInViewport(containerRef)
  const surfaceId = `${hostSurface.documentId ?? 'tabdoc'}:${blockInstanceId}`
  const surfaceState = resolveTabDataBlockSurfaceState({
    inViewport: isInViewport,
    hostVisible: hostSurface.isVisible,
    paneActive: hostSurface.isPaneActive,
  })

  const attrs = node.attrs ?? {}
  const tableId = typeof attrs.tableId === 'string' ? attrs.tableId : ''
  const viewId = typeof attrs.viewId === 'string' ? attrs.viewId : null
  const title = typeof attrs.title === 'string' ? attrs.title : ''
  const maxHeight = typeof attrs.maxHeight === 'number' && Number.isFinite(attrs.maxHeight) ? Math.max(TABDATA_MIN_HEIGHT, attrs.maxHeight) : TABDATA_DEFAULT_HEIGHT

  const handleOpenInTab = useCallback(() => {
    if (!tableId) return
    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement
      && containerRef.current?.contains(activeElement)
    ) {
      activeElement.blur()
    }
    void Promise.resolve()
      .then(() => hostActions.openResource({
        resourceType: 'tabdata',
        resourceId: tableId,
        title,
      }))
      .catch((error: unknown) => {
        toast({
          title: t('tabdataBlock.navigateFailed', {
            defaultValue: '无法打开表格',
          }),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      })
  }, [hostActions, tableId, t, title])

  const handleDelete = useCallback(() => deleteNode(), [deleteNode])

  const handleUpdateAttributes = useCallback(
    (attrs: Record<string, unknown>) => updateAttributes(attrs),
    [updateAttributes],
  )

  const handleHeightChange = useCallback(
    (height: number) => updateAttributes({ maxHeight: height }),
    [updateAttributes],
  )

  const stopPointerPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 表格是独立编辑面：导航、删除、回车、输入法与快捷键均应由内部处理。
    // 显式“离开表格”由表格自己的边缘导航命令负责，不能把原始事件交给 ProseMirror。
    e.stopPropagation()
  }, [])

  const { currentHeight, isDragging, handleMouseDown, handleTouchStart, handleKeyDown: handleResizeKeyDown } = useResizeHandle({
    initialHeight: maxHeight,
    minHeight: TABDATA_MIN_HEIGHT,
    maxHeight: TABDATA_MAX_HEIGHT,
    onHeightChange: handleHeightChange,
  })

  const renderTableEmbed = _tabDataBlockViewConfig.renderTableEmbed

  return (
    <NodeViewWrapper
      className={`tabdata-block-wrapper my-4 ${selected ? 'ProseMirror-selectednode' : ''}`}
      data-type="tabdata-block"
    >
      <div
        ref={containerRef}
        className={`
          group relative rounded-lg border transition-colors
          ${selected ? 'border-primary/40 ring-2 ring-primary/20' : 'border-border/60 hover:border-border'}
          bg-card overflow-hidden
        `}
        style={{ height: currentHeight }}
        onMouseDown={stopPointerPropagation}
        onClick={stopPointerPropagation}
        onDoubleClick={stopPointerPropagation}
        onContextMenu={stopPointerPropagation}
        onKeyDown={handleKeyDown}
        onBeforeInput={stopPointerPropagation}
        onPaste={stopPointerPropagation}
        onCopy={stopPointerPropagation}
        onCut={stopPointerPropagation}
        onCompositionStart={stopPointerPropagation}
        onCompositionEnd={stopPointerPropagation}
      >
        {tableId && surfaceState.shouldRender ? (
          renderTableEmbed ? (
            renderTableEmbed({
              tableId,
              viewId,
              title,
              maxHeight: currentHeight,
              onOpenInTab: handleOpenInTab,
              onDelete: handleDelete,
              onUpdateAttributes: handleUpdateAttributes,
              surfaceId,
              isSurfaceActive: surfaceState.isInteractive,
            })
          ) : (
            <div className="flex h-full items-center justify-center text-body text-muted-foreground">
              <span>{title || tableId}</span>
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {!tableId ? (
              <span>{t('tabdataBlock.noTable', { defaultValue: '未关联表格' })}</span>
            ) : (
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                <span>{t('tabdataBlock.loading', { defaultValue: '加载表格中...' })}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div
        className={`tabdata-resize-handle ${isDragging ? 'is-dragging' : ''}`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleResizeKeyDown}
        role="slider"
        aria-label={t('tabdataBlock.resizeHint', { defaultValue: '拖拽调整高度' })}
        aria-valuemin={TABDATA_MIN_HEIGHT}
        aria-valuemax={TABDATA_MAX_HEIGHT}
        aria-valuenow={currentHeight}
        aria-orientation="vertical"
        tabIndex={0}
      />
    </NodeViewWrapper>
  )
}

TabDataBlockView.displayName = 'TabDataBlockView'
