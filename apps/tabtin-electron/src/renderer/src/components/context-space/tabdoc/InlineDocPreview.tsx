/**
 * InlineDocPreview — 「当前中间产物」内嵌只读文档预览
 *
 * 任务详情停留时，责任人与成员直接在页面内看到在线文档正文，而不必先点卡片
 * 再弹出全局的 CloudDocumentPreviewModal。
 *
 * 取内容走 REST 快照（getDocument）+ DocRenderer 只读渲染：轻量、不建协作连接，
 * 适合同一区域多卡片场景。后端 ACL 拒绝或网络失败时优雅降级为提示 + 重试，
 * 不整区白屏。live 能否看到正文取决于后端 doc 读取 ACL。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, FileText, Loader2, RefreshCw } from 'lucide-react'
import { DocRenderer } from '@tabtin/tabdoc-ui/editor'
import { getDocument } from '@tabtin/tabdoc-ui/api-client'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('inlineDocPreview')

interface InlineDocPreviewProps {
  documentId: string
  /** 外层容器 className（默认带滚动上限，避免长文档撑爆任务详情） */
  className?: string
}

type PreviewSnapshot = {
  contentJson: Record<string, unknown> | null
  contentMarkdown: string | null
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: PreviewSnapshot; isEmpty: boolean }
  | { status: 'error'; message: string }

function hasRenderableContent(snapshot: PreviewSnapshot): boolean {
  const { contentJson, contentMarkdown } = snapshot
  if (
    contentJson
    && typeof contentJson === 'object'
    && Array.isArray((contentJson as { content?: unknown[] }).content)
    && ((contentJson as { content: unknown[] }).content.length > 0)
  ) {
    return true
  }
  return Boolean(contentMarkdown && contentMarkdown.trim().length > 0)
}

export function InlineDocPreview({ documentId, className }: InlineDocPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    log.info('load inline doc snapshot', { documentId })
    getDocument(getSharedAppHostClient(), documentId)
      .then(result => {
        if (cancelled) return
        const snapshot: PreviewSnapshot = {
          contentJson: result.content?.description_json ?? null,
          contentMarkdown: result.content?.description_markdown ?? null,
        }
        setState({
          status: 'ready',
          snapshot,
          isEmpty: !hasRenderableContent(snapshot),
        })
      })
      .catch(cause => {
        if (cancelled) return
        log.warn('load inline doc snapshot failed', { documentId, cause })
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '无法加载文档预览',
        })
      })
    return () => {
      cancelled = true
    }
  }, [documentId, reloadKey])

  const retry = useCallback(() => setReloadKey(key => key + 1), [])

  const containerClassName = cn(
    'rounded-[10px] border border-foreground/[0.08] bg-background',
    className,
  )

  if (state.status === 'loading') {
    return (
      <div
        className={cn(containerClassName, 'flex min-h-40 items-center justify-center')}
        role="status"
        aria-label="正在加载文档预览"
      >
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" aria-hidden />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={cn(containerClassName, 'flex min-h-40 flex-col items-center justify-center gap-3 px-6 text-center')}>
        <AlertCircle className="h-5 w-5 text-muted-foreground/60" aria-hidden />
        <p className="text-caption text-muted-foreground/80">
          暂时无法加载文档正文。请稍后重试或检查网络连接。
        </p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center gap-1.5 rounded-interactive border border-foreground/[0.12] px-2.5 py-1 text-caption text-foreground/80 transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          重试
        </button>
      </div>
    )
  }

  if (state.isEmpty) {
    return (
      <div className={cn(containerClassName, 'flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center')}>
        <FileText className="h-5 w-5 text-muted-foreground/60" aria-hidden />
        <p className="text-caption text-muted-foreground/80">这个文档还没有正文内容。</p>
      </div>
    )
  }

  return (
    <div className={cn(containerClassName, 'max-h-[32rem] overflow-auto px-5 py-4')}>
      <DocRenderer
        contentJson={state.snapshot.contentJson}
        contentMarkdown={state.snapshot.contentMarkdown}
      />
    </div>
  )
}

export default InlineDocPreview
