import { useState } from 'react'
import { History, Loader2, RotateCcw, Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { sanitizeSchema, rehypeSanitizeCss } from '../rehypeSanitizeSchema'
import {
  ScrollArea,
  ConfirmDialog,
} from '@tabtin/smartsheet-ui'
import type { TabdocRevision } from '../api-client'
import type { SaveState } from '../useDocEditor'

interface DocRevisionPanelProps {
  revisions: TabdocRevision[]
  currentVersion: number | null
  isLoading: boolean
  restoringVersion: number | null
  saveState: SaveState
  onRefresh: () => void
  onRestore: (version: number) => void
}

const toTimeText = (value: string | null): string => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  // Use undefined locale to respect the user's system setting
  return date.toLocaleString(undefined, { hour12: false })
}

export function DocRevisionPanel({
  revisions,
  currentVersion,
  isLoading,
  restoringVersion,
  saveState,
  onRefresh,
  onRestore,
}: DocRevisionPanelProps) {
  const { t } = useTranslation('tabdoc')
  const [previewRevision, setPreviewRevision] = useState<TabdocRevision | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-body font-medium text-foreground">
          {t('revisionHistory')}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <History className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Revisions list */}
      <ScrollArea className={previewRevision ? 'h-1/2' : 'flex-1'}>
        {revisions.length === 0 ? (
          <div className="px-3 py-6 text-center text-body text-muted-foreground">
            {t('noRevisions')}
          </div>
        ) : (
          <div className="py-1">
            {revisions.map(rev => {
              const isCurrent = currentVersion === rev.version
              const isPreviewing = previewRevision?.id === rev.id
              return (
                <div
                  key={rev.id}
                  className={`border-b px-3 py-2 ${isCurrent ? 'bg-primary/5' : ''} ${isPreviewing ? 'ring-1 ring-primary/30' : ''}`}
                >
                  <div className="flex items-center justify-between text-body">
                    <span className="font-medium">
                      v{rev.version}
                      {isCurrent && (
                        <span className="ml-1 text-primary">
                          ({t('current')})
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground">{toTimeText(rev.created_at)}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-caption text-muted-foreground">
                    {(rev.content_plaintext || rev.content_markdown || '').trim().slice(0, 100) || t('emptyContent')}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    {/* Preview button */}
                    <button
                      type="button"
                      onClick={() => setPreviewRevision(isPreviewing ? null : rev)}
                      className="flex items-center gap-1.5 rounded px-2 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Eye className="h-3 w-3" />
                      {isPreviewing
                        ? t('closePreview')
                        : t('preview')}
                    </button>
                    {/* Restore button */}
                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => setRestoreTarget(rev.version)}
                        disabled={restoringVersion !== null || saveState === 'saving'}
                        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {restoringVersion === rev.version ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        {t('restoreVersion')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Markdown preview pane */}
      {previewRevision && (
        <div className="flex flex-col border-t">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t('previewVersion')} v{previewRevision.version}
            </span>
            <button
              type="button"
              onClick={() => setPreviewRevision(null)}
              className="text-caption text-muted-foreground hover:text-foreground"
            >
              {'\u2715'}
            </button>
          </div>
          <ScrollArea className="h-1/2 max-h-48">
            <div className="prose prose-xs dark:prose-invert max-w-none px-3 pb-3 text-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeSanitizeCss]}>
                {previewRevision.content_markdown || t('emptyContent')}
              </ReactMarkdown>
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Restore confirmation dialog */}
      {restoreTarget !== null && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setRestoreTarget(null) }}
          title={t('confirmRestoreTitle')}
          description={t('confirmRestoreDesc', { version: restoreTarget })}
          onConfirm={() => {
            onRestore(restoreTarget)
          }}
        />
      )}
    </div>
  )
}
