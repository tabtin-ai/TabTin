import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays, ImageIcon, Table2, PanelsTopLeft, ClipboardList } from 'lucide-react'
import {
  DEFAULT_UNTITLED_RECORD_TITLE,
  extractViewCoverUrl,
  formatFieldDisplayValue,
  resolveConfiguredCardTitle,
  toTitleText,
  useCalendarViewController,
  useGalleryViewController,
  useKanbanViewController,
  useFormViewController,
  type GalleryCardSize,
  type ViewMeta,
  type ViewRecordsResponse,
} from '@tabtin/table-ui'
import type { Field } from '@tabtin/table-core'
import { createLooseTranslate } from '@/types/table-adapters'
import {
  readGridEmbedFieldValue,
  resolveGridEmbedVisibleFields,
} from './webGridEmbedProjection'

const GALLERY_GRID_CLASS: Record<GalleryCardSize, string> = {
  small: 'grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-5',
  medium: 'grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4',
  large: 'grid gap-4 grid-cols-1 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3',
}

interface WebViewRendererProps {
  currentView: ViewMeta | null
  currentViewId: string | null
  views: ViewMeta[]
  fields: Field[]
  currentViewRecords: ViewRecordsResponse | null
}

const Empty = ({ text }: { text: string }) => (
  <div className="flex h-full items-center justify-center text-body text-muted-foreground">{text}</div>
)

export function WebViewRenderer({
  currentView,
  currentViewId,
  views,
  fields,
  currentViewRecords,
}: WebViewRendererProps) {
  const type = currentView?.view_type ?? 'grid'

  if (type === 'kanban') {
    return (
      <KanbanView
        currentView={currentView}
        views={views}
        currentViewId={currentViewId}
        currentViewRecords={currentViewRecords}
        fields={fields}
      />
    )
  }

  if (type === 'calendar') {
    return (
      <CalendarView
        currentView={currentView}
        views={views}
        currentViewId={currentViewId}
        currentViewRecords={currentViewRecords}
        fields={fields}
      />
    )
  }

  if (type === 'gallery') {
    return (
      <GalleryView
        views={views}
        currentViewId={currentViewId}
        currentViewRecords={currentViewRecords}
        fields={fields}
      />
    )
  }

  if (type === 'flashcard') {
    return (
      <FlashcardView
        currentView={currentView}
        currentViewRecords={currentViewRecords}
        fields={fields}
      />
    )
  }

  if (type === 'form') {
    return (
      <FormViewPreview
        views={views}
        currentViewId={currentViewId}
        currentViewRecords={currentViewRecords}
        fields={fields}
      />
    )
  }

  return <GridView currentView={currentView} currentViewRecords={currentViewRecords} fields={fields} />
}

function GridView({
  currentView,
  currentViewRecords,
  fields,
}: Pick<WebViewRendererProps, 'currentView' | 'currentViewRecords' | 'fields'>) {
  const { t } = useTranslation('view')
  const visibleFields = useMemo(
    () => resolveGridEmbedVisibleFields(currentView, fields),
    [currentView, fields],
  )
  const records = currentViewRecords?.records ?? []

  if (visibleFields.length === 0) return <Empty text={t('renderer.empty')} />

  return (
    <div className="h-full overflow-auto" role="region" aria-label={t('types.grid')}>
      <table className="w-full min-w-max border-separate border-spacing-0 text-body">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            {visibleFields.map((field) => (
              <th
                key={field.id}
                scope="col"
                className="min-w-36 max-w-60 border-b border-r border-border/60 bg-muted/30 px-3 py-2 text-left font-medium text-foreground last:border-r-0"
              >
                <span className="block truncate" title={field.name}>{field.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="hover:bg-muted/20">
              {visibleFields.map((field) => {
                const display = formatFieldDisplayValue(
                  readGridEmbedFieldValue(record, field),
                  field,
                  { emptyLabel: '-' },
                )
                return (
                  <td
                    key={field.id}
                    className="min-w-36 max-w-60 border-b border-r border-border/50 px-3 py-2 text-foreground last:border-r-0"
                  >
                    <span className="block truncate" title={display}>{display}</span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {records.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-body text-muted-foreground">
          <Table2 className="h-4 w-4" />
          {t('renderer.empty')}
        </div>
      ) : null}
    </div>
  )
}

function KanbanView({
  currentView,
  views,
  currentViewId,
  currentViewRecords,
  fields,
}: WebViewRendererProps) {
  const { t } = useTranslation('view')
  const tl = createLooseTranslate(t)
  const state = useKanbanViewController({
    views,
    currentViewId,
    currentViewOverride: currentView,
    currentViewRecords,
    fields,
    selectedTableId: null,
    t: tl,
  })

  if (!state.groups.length) {
    return <Empty text={t('renderer.empty')} />
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex min-w-max gap-4">
        {state.groups.map((group) => (
          <div key={group.id} className="w-72 shrink-0 rounded-xl border border-border bg-muted/30">
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-3">
              <PanelsTopLeft className="h-4 w-4 text-muted-foreground" />
              <div className="truncate text-body font-medium">{group.label}</div>
              <div className="ml-auto text-body text-muted-foreground">
                {t('renderer.cardCount', { count: group.count })}
              </div>
            </div>
            <div className="space-y-3 p-3">
              {group.records.map((record, index) => {
                const titleFieldRef = state.cardTitleFieldName ?? state.kanbanConfig.cardTitleField
                const title = titleFieldRef
                  ? resolveConfiguredCardTitle(state.getRecordFieldValue(record, titleFieldRef))
                  : (
                      toTitleText(state.getRecordFieldValue(record, 'name'))
                      ?? toTitleText(state.getRecordFieldValue(record, 'title'))
                      ?? DEFAULT_UNTITLED_RECORD_TITLE
                    )
                return (
                  <div key={record.id ?? `${group.id}-${index}`} className="rounded-lg border border-border bg-background p-3 shadow-sm">
                    <div className="font-medium">{title}</div>
                    <div className="mt-2 space-y-1 text-body text-muted-foreground">
                      {state.visibleFieldIds.slice(0, 4).map((fieldId) => {
                        const field = state.fieldIdToFieldMap.get(fieldId)
                        if (!field) return null
                        const raw = state.getRecordFieldValue(record, field.id)
                        if (raw == null || raw === '') return null
                        return (
                          <div key={fieldId} className="flex items-start justify-between gap-2">
                            <span className="truncate">{field.name}</span>
                            <span className="max-w-[140px] truncate">
                              {formatFieldDisplayValue(raw, field, { emptyLabel: '-' })}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CalendarView({
  currentView,
  views,
  currentViewId,
  currentViewRecords,
  fields,
}: WebViewRendererProps) {
  const { t } = useTranslation('view')
  const tl = createLooseTranslate(t)
  const state = useCalendarViewController({
    views,
    currentViewId,
    currentViewOverride: currentView,
    currentViewRecords,
    fields,
    t: tl,
  })

  if (!state.groupedByDate.length) {
    return <Empty text={t('renderer.empty')} />
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="space-y-6">
        {state.groupedByDate.map(([date, events]) => (
          <div key={date} className="space-y-3">
            <div className="flex items-center gap-2 text-body font-medium">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              {date}
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {events.map((event) => (
                <div key={event.id} className="rounded-xl border border-border bg-background p-4 shadow-sm">
                  <div className="font-medium">{event.title}</div>
                  <div className="mt-2 space-y-1 text-body text-muted-foreground">
                    {state.calendarVisibleFieldIds.slice(0, 4).map((fieldId) => {
                      const field = fields.find((item) => item.id === fieldId)
                      if (!field) return null
                      const raw = state.getEventFieldValue(event, fieldId)
                      if (raw == null || raw === '') return null
                      return (
                        <div key={fieldId} className="flex items-start justify-between gap-2">
                          <span className="truncate">{field.name}</span>
                          <span className="max-w-[140px] truncate">
                            {formatFieldDisplayValue(raw, field, { emptyLabel: '-' })}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function GalleryView({
  views,
  currentViewId,
  currentViewRecords,
  fields,
}: Omit<WebViewRendererProps, 'currentView'>) {
  const { t } = useTranslation('view')
  const state = useGalleryViewController({
    views,
    currentViewId,
    currentViewRecords,
    fields,
  })

  if (!state.records.length) {
    return <Empty text={t('renderer.empty')} />
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className={GALLERY_GRID_CLASS[state.cardSize]}>
        {state.records.map((record, index) => {
          const recordId = String(record.id ?? index)
          const title = state.getRecordTitle(record)
          const coverUrl = extractViewCoverUrl(
            state.getRecordFieldValue(record, state.coverFieldName ?? state.coverField),
          )
          const hasCoverField = Boolean(state.coverField || state.coverFieldName)
          return (
            <div key={recordId} className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              {hasCoverField && (
                <div className="flex aspect-[4/3] items-center justify-center bg-muted/30">
                  {coverUrl && !state.imageErrors.has(recordId) ? (
                    <img
                      src={coverUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      onError={() => state.handleImageError(recordId)}
                    />
                  ) : (
                    <ImageIcon className="h-8 w-8 text-muted-foreground/60" />
                  )}
                </div>
              )}
              <div className="space-y-2 p-3">
                <div className="font-medium">{title}</div>
                <div className="space-y-1 text-body text-muted-foreground">
                  {state.getGalleryCardFieldIds(record).slice(0, 4).map((fieldId) => {
                    const field = state.fieldMap.get(fieldId)
                    if (!field) return null
                    const raw = state.getRecordFieldValue(record, field.id)
                    if (raw == null || raw === '') return null
                    return (
                      <div key={fieldId} className="flex items-start justify-between gap-2">
                        <span className="truncate">{field.name}</span>
                        <span className="max-w-[140px] truncate">
                          {formatFieldDisplayValue(raw, field, { emptyLabel: '-' })}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FlashcardView({
  currentView,
  currentViewRecords,
  fields,
}: Pick<WebViewRendererProps, 'currentView' | 'currentViewRecords' | 'fields'>) {
  const { t } = useTranslation('view')
  const config = (currentView?.config ?? {}) as Record<string, unknown>
  const frontFieldId = typeof config.front_field === 'string' ? config.front_field : ''
  const backFieldId = typeof config.back_field === 'string' ? config.back_field : ''
  const frontField = fields.find((field) => field.id === frontFieldId)
  const backField = fields.find((field) => field.id === backFieldId)

  const cards = useMemo(() => {
    return (currentViewRecords?.records ?? []).map((record, index) => {
      const front = frontField
        ? record.fields?.[frontField.id] ?? record.data?.[frontField.name]
        : undefined
      const back = backField
        ? record.fields?.[backField.id] ?? record.data?.[backField.name]
        : undefined
      return {
        id: record.id ?? String(index),
        front,
        back,
      }
    })
  }, [currentViewRecords?.records, frontField, backField])

  if (!cards.length) {
    return <Empty text={t('renderer.empty')} />
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <div key={card.id} className="grid min-h-56 grid-rows-2 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="flex items-center justify-center border-b border-border bg-muted/20 p-4 text-center">
              <div>
                <div className="mb-2 text-body uppercase tracking-wide text-muted-foreground">{t('editor.frontField')}</div>
                <div className="text-body font-medium">
                  {frontField ? formatFieldDisplayValue(card.front, frontField, { emptyLabel: t('renderer.unset') }) : t('renderer.unset')}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-center p-4 text-center">
              <div>
                <div className="mb-2 text-body uppercase tracking-wide text-muted-foreground">{t('editor.backField')}</div>
                <div className="text-body">
                  {backField ? formatFieldDisplayValue(card.back, backField, { emptyLabel: t('renderer.unset') }) : t('renderer.unset')}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FormViewPreview({
  views,
  currentViewId,
  currentViewRecords,
  fields,
}: Omit<WebViewRendererProps, 'currentView'>) {
  const { t } = useTranslation('view')
  const state = useFormViewController({
    views,
    currentViewId,
    currentViewRecords,
    fields,
  })

  const { formConfig, formFields } = state
  const title = formConfig.title || state.currentView?.name || t('form.untitledForm')

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-5 w-5 text-primary" />
          <h2 className="text-subtitle font-semibold">{title}</h2>
        </div>
        {formConfig.description && (
          <p className="text-body text-muted-foreground">{formConfig.description}</p>
        )}
        {formFields.length === 0 ? (
          <Empty text={t('renderer.empty')} />
        ) : (
          <div className="space-y-5">
            {formFields.map(field => (
              <div key={field.id} className="space-y-1">
                <div className="text-body font-medium">
                  {field.name}
                </div>
                {field.description && (
                  <p className="text-caption text-muted-foreground">{field.description}</p>
                )}
                <div className="h-9 rounded-md border border-border bg-muted/30" />
              </div>
            ))}
          </div>
        )}
        {formFields.length > 0 && (
          <button
            disabled
            className="w-full rounded-md bg-primary/50 py-2 text-body font-medium text-primary-foreground"
          >
            {formConfig.submit_label || t('form.defaultSubmitLabel')}
          </button>
        )}
      </div>
    </div>
  )
}
