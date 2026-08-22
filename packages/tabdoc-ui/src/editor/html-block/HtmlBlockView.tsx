import React, { useCallback, useEffect, useMemo } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Code2, ExternalLink, Loader2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import {
  sanitizeHtmlBlockSrc,
  normalizeHtmlBlockHeight,
  HTML_BLOCK_DEFAULT_TITLE,
} from '@tabtin/doc-editor'
import { useTabDocHostActionsOptional } from '../../TabDocHostActionsContext'
import { useHtmlBlockAccess } from './HtmlBlockAccessContext'
import { useHtmlBlockObjectUrl } from './useHtmlBlockObjectUrl'

function createHtmlBlockId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `htmlblk_${Date.now().toString(36)}`
}

/**
 * HtmlBlockView — 宿主无关的 HTML 嵌入块 NodeView（编辑器内富渲染）。
 *
 * ：优先用 fileId + 授权 loader 拉 Blob 渲染；持久化 src 仅作历史公开块回退。
 * ：「在浏览器打开」走稳定网页地址（documentId + blockId），权限继承文档；
 * 文档内 iframe 仍用 Blob / legacy src，不改嵌入渲染。
 * 安全红线：sandbox 固定 `allow-scripts allow-popups`，绝不含 allow-same-origin。
 */
export const HtmlBlockView: React.FC<NodeViewProps> = ({
  node,
  deleteNode,
  selected,
  editor,
  updateAttributes,
}) => {
  const { t } = useTranslation('tabdoc')
  const hostActions = useTabDocHostActionsOptional()
  const access = useHtmlBlockAccess()

  const attrs = node.attrs ?? {}
  const fileId = typeof attrs.fileId === 'string' ? attrs.fileId : ''
  const blockId = typeof attrs.blockId === 'string' ? attrs.blockId.trim() : ''
  const rawSrc = typeof attrs.src === 'string' ? attrs.src : ''
  const legacySrc = useMemo(() => sanitizeHtmlBlockSrc(rawSrc), [rawSrc])
  const title = typeof attrs.title === 'string' ? attrs.title : ''
  const height = normalizeHtmlBlockHeight(attrs.height)

  const { iframeSrc, loading, error } = useHtmlBlockObjectUrl({
    fileId,
    legacySrc,
    documentId: access.documentId,
    shareId: access.shareId,
    password: access.password,
    revokeEpoch: access.revokeEpoch,
  })

  const displayTitle =
    title || t('htmlBlock.untitled', { defaultValue: HTML_BLOCK_DEFAULT_TITLE })

  const editable = editor?.isEditable ?? false

  // 历史块 / 旧插入路径可能缺 blockId；可编辑时补齐，否则「在浏览器打开」无法定位块。
  useEffect(() => {
    if (blockId || !editable) return
    updateAttributes({ blockId: createHtmlBlockId() })
  }, [blockId, editable, updateAttributes])

  // 稳定 URL 打开：需要 documentId + blockId + 宿主实现；不依赖 iframe Blob 是否已就绪。
  const canOpenExternally = Boolean(
    access.documentId &&
      blockId &&
      hostActions?.openHtmlArtifactInBrowser,
  )

  const handleDelete = useCallback(() => deleteNode(), [deleteNode])

  const handleOpenInBrowser = useCallback(() => {
    if (!access.documentId || !blockId || !hostActions?.openHtmlArtifactInBrowser) return

    void hostActions
      .openHtmlArtifactInBrowser({
        documentId: access.documentId,
        blockId,
        // 协作未落库时服务端靠 fileId + FileUsage 做成员 ACL 短期兜底
        fileId: fileId || undefined,
        title: displayTitle,
      })
      .catch((openError: unknown) => {
        toast({
          title: t('htmlBlock.openInBrowserFailed', { defaultValue: '无法在浏览器中打开' }),
          description: openError instanceof Error ? openError.message : undefined,
          variant: 'destructive',
        })
      })
  }, [access.documentId, blockId, fileId, displayTitle, hostActions, t])

  return (
    <NodeViewWrapper
      data-type="html-block"
      className={`html-block-wrapper my-4 ${selected ? 'ProseMirror-selectednode' : ''}`}
    >
      <div
        className={`
          group relative overflow-hidden rounded-lg border bg-card transition-colors
          ${selected ? 'border-primary/40 ring-2 ring-primary/20' : 'border-border/60 hover:border-border'}
        `}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Code2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-body truncate">{displayTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canOpenExternally ? (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleOpenInBrowser}
                title={t('htmlBlock.openInBrowser', { defaultValue: '在浏览器打开' })}
                data-testid="html-block-open-external"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {editable ? (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                onClick={handleDelete}
                title={t('htmlBlock.delete', { defaultValue: '删除' })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="relative" style={{ height }}>
          {iframeSrc ? (
            <>
              <iframe
                src={iframeSrc}
                title={displayTitle}
                loading="lazy"
                sandbox="allow-scripts allow-popups"
                style={{ width: '100%', height: '100%', border: 0 }}
              />
              {loading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-card/60 text-body text-muted-foreground backdrop-blur-[1px]">
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t('htmlBlock.loading', { defaultValue: '加载中...' })}</span>
                </div>
              )}
            </>
          ) : loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-body text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t('htmlBlock.loading', { defaultValue: '加载中...' })}</span>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <Code2 className="size-5 text-muted-foreground" />
              </div>
              <p className="text-body">
                {error
                  ? t('htmlBlock.loadFailed', { defaultValue: '无法加载 HTML 内容' })
                  : t('htmlBlock.empty', { defaultValue: '尚未关联 HTML 内容' })}
              </p>
            </div>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  )
}

HtmlBlockView.displayName = 'HtmlBlockView'
