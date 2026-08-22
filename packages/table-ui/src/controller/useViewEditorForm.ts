import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Field,
  ViewType,
  ViewCreateRequest,
  ViewUpdateRequest,
  ViewMeta,
} from '../types'
import {
  getViewVisibilitySnapshot,
  isPrimaryVisibilityLocked,
  ensurePrimaryVisibleFieldIds,
} from '../utils/viewVisibility'

type FormMode = 'create' | 'edit'

export interface UseViewEditorFormOptions {
  open: boolean
  mode: FormMode
  initialView: ViewMeta | null
  fields: Field[]
  translate: (key: string, options?: Record<string, unknown>) => string
}

function readConfig(view: ViewMeta | null, key: string): unknown {
  if (!view?.config || typeof view.config !== 'object') return undefined
  return (view.config as Record<string, unknown>)[key]
}

function readConfigString(view: ViewMeta | null, key: string): string | undefined {
  const v = readConfig(view, key)
  return typeof v === 'string' ? v : undefined
}

function readConfigBool(view: ViewMeta | null, key: string, fallback: boolean): boolean {
  const v = readConfig(view, key)
  return typeof v === 'boolean' ? v : fallback
}

function readConfigStringFallback(view: ViewMeta | null, key: string, fallback: string): string {
  return readConfigString(view, key) ?? fallback
}

export function useViewEditorForm({
  open,
  mode,
  initialView,
  fields,
  translate: t,
}: UseViewEditorFormOptions) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [viewType, setViewType] = useState<ViewType>('grid')
  const [visibleFieldIds, setVisibleFieldIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const [kanbanGroupField, setKanbanGroupField] = useState<string | undefined>()
  const [kanbanTitleField, setKanbanTitleField] = useState<string | undefined>()
  const [kanbanCoverField, setKanbanCoverField] = useState<string | undefined>()

  const [calendarDateField, setCalendarDateField] = useState<string | undefined>()
  const [calendarTitleField, setCalendarTitleField] = useState<string | undefined>()

  const [galleryTitleField, setGalleryTitleField] = useState<string | undefined>()
  const [galleryDescriptionField, setGalleryDescriptionField] = useState<string | undefined>()
  const [galleryCoverField, setGalleryCoverField] = useState<string | undefined>()
  const [galleryCardSize, setGalleryCardSize] = useState('medium')

  const [flashcardFrontField, setFlashcardFrontField] = useState<string | undefined>()
  const [flashcardBackField, setFlashcardBackField] = useState<string | undefined>()
  const [flashcardMasteryField, setFlashcardMasteryField] = useState<string | undefined>()
  const [flashcardTagsField, setFlashcardTagsField] = useState<string | undefined>()
  const [flashcardAutoShuffle, setFlashcardAutoShuffle] = useState(false)
  const [flashcardShowProgress, setFlashcardShowProgress] = useState(true)

  const [formPublishConfig, setFormPublishConfig] = useState<Record<string, unknown>>({})

  // 仅在「打开会话 / 切换目标视图 / 字段身份变化」时灌入草稿。
  // 打开期间 store/collab 刷新会给 initialView、fields 新引用，不能把用户正在选的配置打回打开时的旧值。
  const fieldIdentityKey = useMemo(
    () =>
      fields
        .map(field => `${field.id}:${field.is_primary ? 'primary' : 'normal'}:${field.is_hidden ? 'hidden' : 'visible'}`)
        .join('|'),
    [fields],
  )
  const initializedDraftKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      initializedDraftKeyRef.current = null
      return
    }

    const draftKey = [
      mode,
      initialView?.id ?? 'create',
      initialView?.view_type ?? 'grid',
      fieldIdentityKey,
    ].join('::')
    if (initializedDraftKeyRef.current === draftKey) return
    initializedDraftKeyRef.current = draftKey

    setName(initialView?.name ?? '')
    setDescription(initialView?.description ?? '')
    setViewType(initialView?.view_type ?? 'grid')
    const { visibleFieldIds: snapshot } = getViewVisibilitySnapshot(initialView ?? null, fields)
    setVisibleFieldIds(snapshot)

    setKanbanGroupField(readConfigString(initialView, 'group_by_field'))
    setKanbanTitleField(readConfigString(initialView, 'card_title_field'))
    setKanbanCoverField(readConfigString(initialView, 'card_cover_field') || undefined)

    setCalendarDateField(readConfigString(initialView, 'date_field'))
    setCalendarTitleField(readConfigString(initialView, 'title_field'))

    setGalleryTitleField(readConfigString(initialView, 'title_field'))
    setGalleryDescriptionField(readConfigString(initialView, 'description_field') || undefined)
    setGalleryCoverField(readConfigString(initialView, 'cover_field') || undefined)
    setGalleryCardSize(readConfigStringFallback(initialView, 'card_size', 'medium'))

    setFlashcardFrontField(readConfigString(initialView, 'front_field'))
    setFlashcardBackField(readConfigString(initialView, 'back_field'))
    setFlashcardMasteryField(readConfigString(initialView, 'mastery_field') || undefined)
    setFlashcardTagsField(readConfigString(initialView, 'tags_field') || undefined)
    setFlashcardAutoShuffle(readConfigBool(initialView, 'auto_shuffle', false))
    setFlashcardShowProgress(readConfigBool(initialView, 'show_progress', true))

    const icfg =
      initialView?.config && typeof initialView.config === 'object'
        ? (initialView.config as Record<string, unknown>)
        : {}
    setFormPublishConfig({
      title: typeof icfg.title === 'string' ? icfg.title : '',
      description: typeof icfg.description === 'string' ? icfg.description : '',
      submit_label: typeof icfg.submit_label === 'string' ? icfg.submit_label : '',
      success_message: typeof icfg.success_message === 'string' ? icfg.success_message : '',
      allow_multiple_submit:
        typeof icfg.allow_multiple_submit === 'boolean' ? icfg.allow_multiple_submit : true,
      login_required: typeof icfg.login_required === 'boolean' ? icfg.login_required : false,
    })

    setError(null)
  }, [open, mode, initialView, fields, fieldIdentityKey])

  const selectableFields = useMemo(
    () => fields.filter(field => !field.is_hidden),
    [fields],
  )

  const lockPrimaryVisibility = isPrimaryVisibilityLocked(viewType)

  useEffect(() => {
    setVisibleFieldIds(prev => ensurePrimaryVisibleFieldIds(viewType, selectableFields, prev))
  }, [viewType, selectableFields])

  const toggleVisibleField = (fieldId: string) => {
    setVisibleFieldIds(prev => {
      const field = selectableFields.find(item => item.id === fieldId)
      if (field?.is_primary && lockPrimaryVisibility) {
        return prev.includes(fieldId) ? prev : [...prev, fieldId]
      }
      return prev.includes(fieldId) ? prev.filter(id => id !== fieldId) : [...prev, fieldId]
    })
  }

  const buildAndValidate = (): {
    payload: ViewCreateRequest | ViewUpdateRequest
    error: null
  } | {
    payload: null
    error: string
  } => {
    const normalizedVisibleFieldIds = ensurePrimaryVisibleFieldIds(
      viewType,
      selectableFields,
      visibleFieldIds,
    )

    if (!name.trim()) {
      return { payload: null, error: t('view:editor.errors.nameRequired') }
    }
    if (normalizedVisibleFieldIds.length === 0) {
      return { payload: null, error: t('view:editor.errors.visibleRequired') }
    }

    const base: ViewCreateRequest | ViewUpdateRequest = {
      name: name.trim(),
      description: description.trim() || undefined,
      visible_fields: normalizedVisibleFieldIds,
      field_order: normalizedVisibleFieldIds,
      config: {},
    }

    if (mode === 'create') {
      (base as ViewCreateRequest).view_type = viewType
    }

    switch (viewType) {
      case 'kanban': {
        if (!kanbanGroupField) return { payload: null, error: t('view:editor.errors.kanbanGroupRequired') }
        if (!kanbanTitleField) return { payload: null, error: t('view:editor.errors.kanbanTitleRequired') }
        base.config = {
          group_by_field: kanbanGroupField,
          card_title_field: kanbanTitleField,
          card_cover_field: kanbanCoverField,
          visible_fields: normalizedVisibleFieldIds,
        }
        break
      }
      case 'calendar': {
        if (!calendarDateField) return { payload: null, error: t('view:editor.errors.calendarDateRequired') }
        base.config = {
          date_field: calendarDateField,
          ...(calendarTitleField ? { title_field: calendarTitleField } : {}),
        }
        break
      }
      case 'gallery': {
        base.config = {
          ...(galleryTitleField ? { title_field: galleryTitleField } : {}),
          description_field: galleryDescriptionField,
          cover_field: galleryCoverField,
          card_size: galleryCardSize,
          visible_fields: normalizedVisibleFieldIds,
        }
        break
      }
      case 'flashcard': {
        if (!flashcardFrontField) return { payload: null, error: t('view:editor.errors.flashcardFrontRequired') }
        if (!flashcardBackField) return { payload: null, error: t('view:editor.errors.flashcardBackRequired') }
        if (flashcardFrontField === flashcardBackField) {
          return { payload: null, error: t('view:editor.errors.flashcardSameField') }
        }
        base.config = {
          front_field: flashcardFrontField,
          back_field: flashcardBackField,
          mastery_field: flashcardMasteryField,
          tags_field: flashcardTagsField,
          auto_shuffle: flashcardAutoShuffle,
          show_progress: flashcardShowProgress,
        }
        break
      }
      case 'form': {
        base.config = {
          ...formPublishConfig,
          visible_fields: normalizedVisibleFieldIds,
          field_order: normalizedVisibleFieldIds,
        }
        break
      }
      default: {
        base.config = {
          visible_fields: normalizedVisibleFieldIds,
          field_order: normalizedVisibleFieldIds,
        }
        break
      }
    }

    return { payload: base, error: null }
  }

  return {
    name, setName,
    description, setDescription,
    viewType, setViewType,
    visibleFieldIds, toggleVisibleField,
    error, setError,
    selectableFields,
    lockPrimaryVisibility,

    kanban: {
      groupField: kanbanGroupField, setGroupField: setKanbanGroupField,
      titleField: kanbanTitleField, setTitleField: setKanbanTitleField,
      coverField: kanbanCoverField, setCoverField: setKanbanCoverField,
    },
    calendar: {
      dateField: calendarDateField, setDateField: setCalendarDateField,
      titleField: calendarTitleField, setTitleField: setCalendarTitleField,
    },
    gallery: {
      titleField: galleryTitleField, setTitleField: setGalleryTitleField,
      descriptionField: galleryDescriptionField, setDescriptionField: setGalleryDescriptionField,
      coverField: galleryCoverField, setCoverField: setGalleryCoverField,
      cardSize: galleryCardSize, setCardSize: setGalleryCardSize,
    },
    flashcard: {
      frontField: flashcardFrontField, setFrontField: setFlashcardFrontField,
      backField: flashcardBackField, setBackField: setFlashcardBackField,
      masteryField: flashcardMasteryField, setMasteryField: setFlashcardMasteryField,
      tagsField: flashcardTagsField, setTagsField: setFlashcardTagsField,
      autoShuffle: flashcardAutoShuffle, setAutoShuffle: setFlashcardAutoShuffle,
      showProgress: flashcardShowProgress, setShowProgress: setFlashcardShowProgress,
    },

    config: formPublishConfig,
    setConfig: (patch: Record<string, unknown>) => {
      setFormPublishConfig(prev => ({ ...prev, ...patch }))
    },

    buildAndValidate,
  }
}

export type ViewEditorFormReturn = ReturnType<typeof useViewEditorForm>
