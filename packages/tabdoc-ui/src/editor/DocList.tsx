import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileInput, Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ScrollArea,
  ConfirmDialog,
  toast,
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
} from '@tabtin/smartsheet-ui'
import type { TabdocDocument, TabdocSearchItem } from '../api-client'
import { trashDocument, restoreDocumentFromTrash, createDocument, importDocumentFileDraft, importMarkdown, updateDocument } from '../api-client'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { useTabDocHostActions } from '../TabDocHostActionsContext'
import { useTabDocEditorConfigOptional } from '../TabDocEditorConfigContext'
import {
  IMPORT_FILE_ACCEPT,
  buildImportedImageMarkdown,
  getTabDocImportMaxBytes,
  getTabDocImportFileKind,
  stripTabDocImportExtension,
} from './import-file-utils'

export interface DocListProps {
  documents: TabdocDocument[]
  searchItems: TabdocSearchItem[]
  isSearchMode: boolean
  visibleDocuments: TabdocDocument[]
  selectedDocumentId: string | null
  isLoading: boolean
  isLoadingMore?: boolean
  isSearching: boolean
  isCreating: boolean
  searchInput: string
  searchTotal: number
  searchPage: number
  searchTotalPages: number
  hasMore?: boolean
  /** BIZ-024: 加载错误信息 */
  error?: string | null
  onSearchInputChange: (value: string) => void
  onSearchPageChange: (page: number) => void
  onSelectDocument: (id: string) => void
  onRefresh: () => void
  onLoadMore?: () => void
  onCreate: () => void
  organizationId?: string
  spaceId?: string
  loadingSkeleton?: React.ReactNode
}

const toTimeText = (value: string | null): string => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  // Use undefined locale to respect the user's system setting
  return date.toLocaleString(undefined, { hour12: false })
}

export function DocList({
  searchItems,
  isSearchMode,
  visibleDocuments,
  selectedDocumentId,
  isLoading,
  isLoadingMore,
  isSearching,
  isCreating,
  searchInput,
  searchTotal,
  searchPage,
  searchTotalPages,
  hasMore,
  onSearchInputChange,
  onSearchPageChange,
  onSelectDocument,
  onRefresh,
  onLoadMore,
  onCreate,
  error,
  organizationId,
  spaceId,
  loadingSkeleton,
}: DocListProps) {
  const { t } = useTranslation('tabdoc')
  const client = useAppHostClient()
  const hostActions = useTabDocHostActions()
  const editorConfig = useTabDocEditorConfigOptional()
  const searchItemMap = new Map(searchItems.map(item => [item.document.id, item]))

  // BIZ-027: IntersectionObserver 哨兵，滚动到列表底部时自动加载下一页
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMore || !onLoadMore || isSearchMode) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore()
      },
      { rootMargin: '100px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, isSearchMode])

  // Inline rename state
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Archive confirmation
  const [archiveTarget, setArchiveTarget] = useState<TabdocDocument | null>(null)

  // Shared context menu state (single instance for all doc items)
  const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number; doc: TabdocDocument | null }>({ open: false, x: 0, y: 0, doc: null })
  const closeCtxMenu = useCallback(() => setCtxMenu(s => ({ ...s, open: false })), [])

  const startRename = useCallback((doc: TabdocDocument) => {
    setEditingDocId(doc.id)
    setEditingTitle(doc.title)
    // Focus input on next tick
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }, [])

  const commitRename = useCallback(async () => {
    if (!editingDocId || !editingTitle.trim()) {
      setEditingDocId(null)
      return
    }
    // UI-14: 传入 baseVersion/baseUpdatedAt，后端冲突时提示用户
    const targetDoc = visibleDocuments.find(d => d.id === editingDocId)
    try {
      await updateDocument(client, editingDocId, {
        title: editingTitle.trim(),
        baseVersion: targetDoc?.latest_version ?? undefined,
        baseUpdatedAt: targetDoc?.updated_at ?? undefined,
      })
      toast({ title: t('renameSuccess') })
      onRefresh()
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status
      if (status === 409) {
        toast({
          title: t('renameConflict', { defaultValue: '重命名冲突' }),
          description: t('renameConflictDesc', { defaultValue: '该文档已被他人修改，请刷新后重试' }),
          variant: 'destructive',
        })
        onRefresh()
      } else {
        toast({
          title: t('renameFailed'),
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        })
      }
    } finally {
      setEditingDocId(null)
    }
  }, [client, editingDocId, editingTitle, visibleDocuments, onRefresh, t])

  const handleArchive = useCallback(async (doc: TabdocDocument) => {
    try {
      await trashDocument(client, doc.id)
      onRefresh()
      toast({
        title: t('trashSuccess'),
        action: (
          <button
            type="button"
            className="text-body font-medium text-accent hover:underline"
            onClick={async () => {
              try {
                await restoreDocumentFromTrash(client, doc.id)
                onRefresh()
                toast({ title: t('restoreSuccess') })
              } catch {
                toast({ title: t('restoreFailed'), variant: 'destructive' })
              }
            }}
          >
            {t('undo')}
          </button>
        ),
      })
    } catch {
      toast({
        title: t('trashFailed'),
        variant: 'destructive',
      })
    }
  }, [client, onRefresh, t])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !organizationId) return

    const importKind = getTabDocImportFileKind(file.name, file.type)
    if (importKind === 'unsupported') {
      toast({
        title: t('importInvalidType', { defaultValue: '不支持的文件类型' }),
        description: t('importInvalidTypeDesc', {
          defaultValue: '仅支持 .md、.markdown、.mark、.txt、.doc、.docx',
        }),
        variant: 'destructive',
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    if (importKind === 'document' && !hostActions.uploadImportFile) {
      toast({
        title: t('importDocumentUploadUnavailableTitle', { defaultValue: '当前环境暂不支持导入此文件类型' }),
        description: t('importDocumentUploadUnavailable', {
          defaultValue: '请在桌面端导入 .md / .markdown / .mark / .txt / .doc / .docx。',
        }),
        variant: 'destructive',
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    if (importKind === 'image' && !editorConfig?.imageUpload) {
      toast({
        title: t('importDocumentUploadUnavailableTitle', { defaultValue: '当前环境暂不支持导入此文件类型' }),
        description: t('importDocumentUploadUnavailable', {
          defaultValue: '请在桌面端导入图片文件。',
        }),
        variant: 'destructive',
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    const maxImportSize = getTabDocImportMaxBytes(file.name, file.type)
    if (file.size > maxImportSize) {
      const maxImportSizeMb = Math.round(maxImportSize / 1024 / 1024)
      toast({
        title: t('importFileTooLarge', { defaultValue: '文件过大' }),
        description: t('importFileTooLargeByLimitDesc', {
          maxMb: maxImportSizeMb,
          defaultValue: `导入文件大小不能超过 ${maxImportSizeMb} MB，请精简内容后重试`,
        }),
        variant: 'destructive',
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    // BIZ-040: 0 字节文件过滤
    if (file.size === 0) {
      toast({
        title: t('importEmptyFile', { defaultValue: '文件为空' }),
        description: t('importEmptyFileDesc', { defaultValue: '无法导入空文件' }),
        variant: 'destructive',
      })
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    try {
      if (importKind === 'image') {
        const imageUpload = editorConfig!.imageUpload
        if (imageUpload.validate) {
          const validation = imageUpload.validate(file)
          if (!validation.valid) {
            toast({
              title: t(
                validation.reason?.startsWith('fileTooLarge') ? 'imageTooLarge' : 'imageTypeNotSupported',
                { maxSize: validation.maxSizeLabel },
              ),
              variant: 'destructive',
            })
            return
          }
        }
        const uploaded = await imageUpload.upload(file, {
          folder: 'tabdoc/images',
          module: 'tabdoc',
          contextType: 'document',
        })
        if (!uploaded.url) {
          throw new Error(t('imageUploadReturnedEmptyUrl', {
            defaultValue: '上传完成但没有返回可用的图片地址',
          }))
        }
        const title = stripTabDocImportExtension(file.name) || t('untitledDocument')
        const markdown = buildImportedImageMarkdown(file.name, uploaded.url)
        // ：建文档只挂 Organization
        const created = await createDocument(client, {
          organizationId,
          title,
          markdown,
          pmJson: {},
          plaintext: title,
        })
        toast({ title: t('importSuccess', { defaultValue: '导入成功' }) })
        await new Promise<void>(resolve => { onRefresh(); setTimeout(resolve, 100) })
        if (created.document?.id) {
          onSelectDocument(created.document.id)
        }
        return
      }

      let originalText = ''
      const parsed = importKind === 'text'
        ? await (async () => {
          // BIZ-040: 尝试用 UTF-8 解码，检测非 UTF-8 编码的乱码特征
          const rawBuffer = await file.arrayBuffer()
          const decoder = new TextDecoder('utf-8', { fatal: false })
          const text = decoder.decode(rawBuffer)
          originalText = text
          if (text.includes('\uFFFD')) {
            toast({
              title: t('importEncodingWarning', { defaultValue: '编码提示' }),
              description: t('importEncodingWarningDesc', { defaultValue: '文件可能不是 UTF-8 编码，部分字符可能显示为乱码' }),
            })
          }
          return importMarkdown(client, { organizationId, markdown: text })
        })()
        : await importDocumentFileDraft(client, {
          organizationId,
          fileRecordId: (await hostActions.uploadImportFile!({
            file,
            organizationId,
            spaceId,
          })).fileRecordId,
        })

      const importedTitle = importKind === 'document'
        ? ((parsed as { title?: string }).title ?? '')
        : ''
      const title = importedTitle || stripTabDocImportExtension(file.name) || t('untitledDocument')

      // BIZ-041: 验证 pmJson 基本结构
      const pmJson = parsed.pmJson ?? {}
      const validPmJson = (
        typeof pmJson === 'object' &&
        pmJson !== null &&
        (!('type' in pmJson) || (pmJson as Record<string, unknown>).type === 'doc')
      ) ? pmJson : {}

      const created = await createDocument(client, {
        organizationId,
        title,
        markdown: parsed.markdown ?? originalText,
        pmJson: validPmJson,
        plaintext: parsed.plaintext ?? '',
      })
      const skippedImageCount = parsed.skippedImages ?? 0
      toast({
        title: skippedImageCount > 0
          ? t('importPartialSuccess', { defaultValue: '已导入部分内容' })
          : t('importSuccess', { defaultValue: '导入成功' }),
        description: skippedImageCount > 0
          ? t('importSkippedImagesDesc', {
            count: skippedImageCount,
            defaultValue: `${skippedImageCount} 张图片未能导入，已以文字占位保留。`,
          })
          : undefined,
      })

      if (importKind === 'text') {
        // BIZ-053: 检测 roundtrip 可能受影响的 Markdown 结构，提前告知用户
        const hasComplexMarkdown =
          /\\\|/.test(originalText) ||            // 转义 pipe（表格差异）
          /^>\s*[-*]\s/m.test(originalText) ||    // 引用内嵌套列表
          /^\s*- \[[ x]\]/m.test(originalText)    // task list mixed with bullets
        if (hasComplexMarkdown) {
          toast({
            title: t('importRoundtripWarning', { defaultValue: '格式提示' }),
            description: t('importRoundtripWarningDesc', {
              defaultValue: '文档包含复杂 Markdown 结构（转义表格、嵌套引用等），编辑后再导出可能出现结构微调',
            }),
            duration: 6000,
          })
        }

        const hasStaticTable = /^\s*\|.+\|/m.test(originalText) && /^\s*\|[\s:-]+\|/m.test(originalText)
        const hasTabdataBlock = /:::tabdata\{/.test(originalText)
        if (hasStaticTable && !hasTabdataBlock) {
          toast({
            title: t('importTableLinkLost', {
              defaultValue: '表格关联已丢失',
            }),
            description: t('importTableLinkLostDesc', {
              defaultValue: '导入的文档包含静态表格，与 TabData 的关联已丢失。如需恢复关联，请在编辑器中手动重新插入 TabData 表格块。',
            }),
          })
        }
      }

      // BIZ-042: 先刷新列表完成后再选中新文档，避免竞态
      await new Promise<void>(resolve => { onRefresh(); setTimeout(resolve, 100) })
      if (created.document?.id) {
        onSelectDocument(created.document.id)
      }
    } catch (err) {
      toast({
        title: t('importFailed', { defaultValue: '导入失败' }),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [client, editorConfig, hostActions, organizationId, spaceId, onRefresh, onSelectDocument, t])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-body font-medium text-foreground">
          {t('documentList')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title={t('importDocumentFile', { defaultValue: '导入文档文件' })}
          >
            <FileInput className="h-3.5 w-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_FILE_ACCEPT}
            className="hidden"
            onChange={(e) => void handleImportFile(e)}
          />
          <button
            type="button"
            onClick={onCreate}
            disabled={isCreating}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {isCreating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchInput}
            onChange={e => onSearchInputChange(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-7 w-full rounded border bg-background pl-7 pr-7 text-body outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => onSearchInputChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {isSearchMode && (
          <div className="mt-1 text-caption text-muted-foreground">
            {isSearching
              ? t('searching')
              : t('searchResultCount', { count: searchTotal })}
          </div>
        )}
      </div>

      {/* Document list with ScrollArea */}
      <ScrollArea className="flex-1">
        {error && !isLoading ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-body text-muted-foreground">
            <span className="text-destructive">{error}</span>
            <button
              type="button"
              onClick={onRefresh}
              className="rounded px-2 py-1 text-body text-primary hover:bg-muted"
            >
              {t('retry', { defaultValue: '重试' })}
            </button>
          </div>
        ) : isLoading && !isSearchMode && visibleDocuments.length === 0 ? (
          loadingSkeleton ?? (
            <div className="px-3 py-6 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 rounded bg-muted/40 animate-pulse" />
              ))}
            </div>
          )
        ) : visibleDocuments.length === 0 ? (
          <div className="px-3 py-6 text-center text-body text-muted-foreground">
            {isSearchMode
              ? t('noSearchResults')
              : t('noDocuments')}
          </div>
        ) : (
          <div className="py-1">
            {visibleDocuments.map(doc => {
              const isSelected = doc.id === selectedDocumentId
              const searchItem = searchItemMap.get(doc.id)
              const isEditing = editingDocId === doc.id

              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => onSelectDocument(doc.id)}
                  onDoubleClick={() => startRename(doc)}
                  onKeyDown={(e) => {
                    if (e.key === 'F2' || (e.key === 'Enter' && !isEditing)) {
                      e.preventDefault()
                      startRename(doc)
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtxMenu({ open: true, x: e.clientX, y: e.clientY, doc })
                  }}
                  className={`w-full px-3 py-2 text-left text-body transition-colors ${
                    isSelected
                      ? 'bg-primary/10 text-foreground'
                      : 'text-foreground/80 hover:bg-muted/50'
                  }`}
                >
                  {isEditing ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={editingTitle}
                      onChange={e => setEditingTitle(e.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commitRename()
                        if (e.key === 'Escape') setEditingDocId(null)
                      }}
                      className="w-full rounded border bg-background px-1 py-0.5 text-body font-medium outline-none focus:border-primary"
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <div className="line-clamp-1 font-medium">{doc.title}</div>
                  )}
                  <div className="mt-0.5 text-caption text-muted-foreground">
                    v{doc.latest_version} · {toTimeText(doc.updated_at)}
                  </div>
                  {isSearchMode && searchItem && (
                    <div className="mt-1 line-clamp-2 text-caption text-muted-foreground">
                      {searchItem.snippet || ''}
                    </div>
                  )}
                </button>
              )
            })}
            {/* BIZ-023/027: 分页哨兵 + 加载更多 */}
            {!isSearchMode && hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-2">
                {isLoadingMore ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <button
                    type="button"
                    onClick={onLoadMore}
                    className="text-caption text-muted-foreground hover:text-foreground"
                  >
                    {t('loadMore', { defaultValue: '加载更多' })}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Search pagination */}
      {isSearchMode && searchTotalPages > 1 && (
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-caption text-muted-foreground">
          <span>{searchPage}/{searchTotalPages}</span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={searchPage <= 1 || isSearching}
              onClick={() => onSearchPageChange(Math.max(1, searchPage - 1))}
              className="rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            >
              {'\u2039'}
            </button>
            <button
              type="button"
              disabled={searchPage >= searchTotalPages || isSearching}
              onClick={() => onSearchPageChange(Math.min(searchTotalPages, searchPage + 1))}
              className="rounded px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            >
              {'\u203a'}
            </button>
          </div>
        </div>
      )}

      {/* Document context menu (single shared instance) */}
      <ContextMenu open={ctxMenu.open} onClose={closeCtxMenu} anchorPosition={{ x: ctxMenu.x, y: ctxMenu.y }}>
        <ContextMenuItem
          label={t('rename')}
          onClick={() => { if (ctxMenu.doc) startRename(ctxMenu.doc) }}
        />
        <ContextMenuDivider />
        <ContextMenuItem
          icon={<Trash2 className="h-4 w-4" />}
          label={t('moveToTrash')}
          danger
          onClick={() => { if (ctxMenu.doc) setArchiveTarget(ctxMenu.doc) }}
        />
      </ContextMenu>

      {/* Archive confirmation dialog */}
      {archiveTarget && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
          title={t('confirmTrashTitle')}
          description={t('confirmTrashDesc', { title: archiveTarget.title })}
          onConfirm={() => {
            void handleArchive(archiveTarget)
          }}
        />
      )}
    </div>
  )
}
