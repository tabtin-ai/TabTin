import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import { calcGalleryColumns } from '@tabtin/table-ui'
import { LayoutGrid, Image as ImageIcon, Loader2 } from 'lucide-react'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { CollabStatus } from '@tabtin/collab-core'
import { shouldProjectViewRecordsFromCollabYdoc, useTableCollab } from '@components/table/TableCollabContext'
import { extractViewCoverUrl } from '@tabtin/table-ui'
import { useTranslation } from 'react-i18next'
import { CellValueRenderer, ViewLoadingOverlay, ViewPaginationBar } from './ViewShared'
import { useGalleryViewController } from './controller/useGalleryViewController'
import { RecordFormContainer } from '@components/record/RecordFormContainer'
import { RecordCommentCountBadge } from './RecordCommentCountBadge'

/** Gallery 封面使用 aspect-ratio 自适应容器宽度，替代固定 180px */
const COVER_ASPECT = '16/9'
const GALLERY_LOAD_MORE_THRESHOLD_PX = 320
const GALLERY_LOAD_MORE_PAGE_SIZE = 200

const GalleryView: React.FC<{ embedded?: boolean; isReadonly?: boolean }> = ({ embedded, isReadonly = false }) => {
  const { t } = useTranslation('view')
  const { isCollabRuntime, collabBridge } = useTableCollab()
  const isTruncated = collabBridge.collab.isTruncated
  const isCollabProjectionReady =
    isCollabRuntime && collabBridge.collab.status === CollabStatus.SYNCED
  const viewStoreApi = useViewStoreApi()
  const currentViewRecords = useViewStore(s => s.currentViewRecords)
  const isRecordsLoading = useViewStore(s => s.isRecordsLoading)
  const isLoadingMoreRecords = useViewStore(s => s.isLoadingMoreRecords)
  const recordsQuery = useViewStore(s => s.recordsQuery)
  const setViewPage = useViewStore(s => s.setPage)
  const loadMoreCurrentViewRecords = useViewStore(s => s.loadMoreCurrentViewRecords)
  const views = useViewStore(s => s.views)
  const currentViewId = useViewStore(s => s.currentViewId)
  const fields = useTableStore(s => s.fields)
  const selectedTable = useTableStore(s => s.selectedTable)

  const {
    records, galleryVisibleFieldIds, fieldMap, imageErrors, cardSize,
    coverField, coverFieldName,
    getRecordFieldValue, getRecordTitle, getRecordDescription, getGalleryCardFieldIds, handleImageError,
  } = useGalleryViewController({ views, currentViewId, currentViewRecords, fields })

  const [selectedRecord, setSelectedRecord] = useState<any>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const onCardClick = useCallback((rec: any) => {
    setSelectedRecord({
      id: rec.id ?? rec._id ?? rec.__id,
      table_id: selectedTable?.id ?? '',
      data: rec.data ?? {},
      created_at: rec.created_at ?? '',
      updated_at: rec.updated_at ?? '',
      created_by_id: rec.created_by_id ?? '',
    })
    setIsDialogOpen(true)
  }, [selectedTable?.id])

  const onDialogChange = useCallback((open: boolean) => {
    if (!open) { setIsDialogOpen(false); setSelectedRecord(null) }
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadMoreInFlightRef = useRef(false)
  const [cols, setCols] = useState(4)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const applyColumns = () => setCols(calcGalleryColumns(el.offsetWidth, cardSize))
    const ro = new ResizeObserver(applyColumns)
    ro.observe(el)
    applyColumns()
    return () => ro.disconnect()
  }, [cardSize])

  const currentPage = Math.max(1, currentViewRecords?.page ?? recordsQuery.page ?? 1)
  const pageSize = Math.max(1, currentViewRecords?.page_size ?? recordsQuery.page_size ?? 100)
  const totalCount = Math.max(0, currentViewRecords?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const loadedCount = currentViewRecords?.records?.length ?? 0
  const hasMoreRecords = loadedCount < Math.max(0, currentViewRecords?.matched_total ?? totalCount)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const handleScroll = () => {
      if (!hasMoreRecords || isRecordsLoading || isLoadingMoreRecords || loadMoreInFlightRef.current) {
        return
      }
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      if (distanceToBottom > GALLERY_LOAD_MORE_THRESHOLD_PX) {
        return
      }
      loadMoreInFlightRef.current = true
      if (shouldProjectViewRecordsFromCollabYdoc(isCollabRuntime, isTruncated, isCollabProjectionReady)) {
        const nextPageSize = Math.min(
          Math.max(recordsQuery.page_size, loadedCount) + GALLERY_LOAD_MORE_PAGE_SIZE,
          Math.max(loadedCount, currentViewRecords?.matched_total ?? totalCount),
        )
        if (nextPageSize > recordsQuery.page_size) {
          viewStoreApi.setState(state => ({
            recordsQuery: {
              ...state.recordsQuery,
              page: 1,
              page_size: nextPageSize,
            },
          }))
        }
        queueMicrotask(() => {
          loadMoreInFlightRef.current = false
        })
        return
      }
      void loadMoreCurrentViewRecords().finally(() => {
        loadMoreInFlightRef.current = false
      })
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [currentViewRecords?.matched_total, hasMoreRecords, isCollabProjectionReady, isCollabRuntime, isTruncated, isLoadingMoreRecords, isRecordsLoading, loadMoreCurrentViewRecords, loadedCount, recordsQuery, recordsQuery.page_size, totalCount, viewStoreApi])

  const hasCover = Boolean(coverField || coverFieldName)

  return (
    <>
      <ScrollArea className="size-full" scrollBar="both" viewportRef={viewportRef}><div ref={containerRef} className="relative p-4">
        {isRecordsLoading && records.length === 0 && <ViewLoadingOverlay />}
        {records.length === 0 && !isRecordsLoading ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 p-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
              <LayoutGrid className="size-7 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-body font-medium text-muted-foreground">{t('gallery.empty')}</p>
              <p className="mt-1 text-caption text-muted-foreground/60">{t('gallery.emptyHint')}</p>
            </div>
          </div>
        ) : records.length === 0 ? null : (
          <div className="grid gap-x-4 gap-y-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {records.map((rec: any, idx: number) => {
              const recordId = rec.id ?? rec._id ?? rec.__id
              const key = recordId ?? idx
              const title = getRecordTitle(rec)
              const coverRaw = getRecordFieldValue(rec, coverFieldName ?? coverField)
              const coverUrl = extractViewCoverUrl(coverRaw)
              const hasErr = imageErrors.has(String(key))
              const showImg = coverUrl && !hasErr
              const description = getRecordDescription(rec)
              const titleStr = String(title)

              return (
                <div
                  key={key}
                  className="overflow-hidden rounded-md shadow-sm transition-shadow duration-200 ease-out hover:shadow-lg"
                >
                  <div
                    onClick={() => onCardClick(rec)}
                    className="size-full cursor-pointer overflow-hidden rounded-md border border-input bg-card hover:border-primary/15"
                  >
                    {hasCover && (
                      showImg ? (
                        <div className="overflow-hidden border-b" style={{ aspectRatio: COVER_ASPECT }}>
                          <img
                            src={coverUrl} alt=""
                            loading="lazy"
                            className="size-full object-cover"
                            onError={() => handleImageError(String(key))}
                          />
                        </div>
                      ) : (
                        <div className="flex w-full items-center justify-center border-b bg-muted" style={{ aspectRatio: COVER_ASPECT }}>
                          <ImageIcon className="size-20 text-muted-foreground" />
                        </div>
                      )
                    )}

                    <div className="flex min-w-0 flex-col gap-1 px-3 py-2">
                      <div className="flex min-w-0 pb-2 text-subtitle font-semibold" style={{ minHeight: 32 }}>
                        <span className="min-w-0 line-clamp-2 break-words">{titleStr || t('labels.emptyValue')}</span>
                      </div>

                      {/* Description：与标题同源或同文案时不重复展示 */}
                      {description && (
                        <p className="mb-1 min-w-0 line-clamp-2 text-body text-muted-foreground">{description}</p>
                      )}

                      {/* Fields — 仅展示非标题字段的值；标题已在上方粗体区展示 */}
                      {getGalleryCardFieldIds(rec).slice(0, 6).map(fid => {
                        const field = fieldMap.get(fid)
                        if (!field) return null
                        const val = getRecordFieldValue(rec, field.id)
                        if (val === null || val === undefined || val === '') return null

                        return (
                          <div key={fid} className="mb-2 min-w-0">
                            <div className="mb-1 flex items-center space-x-1 text-muted-foreground">
                              <span className="truncate text-body">{field.name}</span>
                            </div>
                            <CellValueRenderer field={field} value={val} ellipsis />
                          </div>
                        )
                      })}

                      <div className="flex justify-end">
                        <RecordCommentCountBadge
                          recordId={typeof recordId === 'string' ? recordId : null}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {isLoadingMoreRecords && records.length > 0 && (
          <div className="flex items-center justify-center gap-2 py-4 text-body text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>{t('pagination.loadingMore', { defaultValue: 'Loading more…' })}</span>
          </div>
        )}

        {!embedded && (
          <ViewPaginationBar
            currentPage={currentPage} totalPages={totalPages}
            totalCount={totalCount} isLoading={isRecordsLoading}
            onPageChange={setViewPage}
          />
        )}
      </div></ScrollArea>

      <RecordFormContainer
        open={isDialogOpen}
        onOpenChange={onDialogChange}
        mode="edit"
        record={selectedRecord ?? undefined}
        isReadonly={isReadonly}
      />
    </>
  )
}

export default GalleryView
