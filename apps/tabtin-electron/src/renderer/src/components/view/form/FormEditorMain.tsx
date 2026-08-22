import React, { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  ImagePlus,
  X,
  Settings2,
  Pencil,
} from 'lucide-react'
import {
  Button,
  cn,
  Input,
  Textarea,
  ScrollArea,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Label,
  toast,
} from '@tabtin/smartsheet-ui'
import type { FormViewConfig } from '@tabtin/table-core'
import type { FormFieldMeta } from '@tabtin/table-ui'
import { useUpload } from '@/hooks/useUpload'
import { useFieldSettingStore } from '@/stores/useFieldSettingStore'
import { SortableItem } from './SortableItem'
import { DroppableContainer } from './DroppableContainer'
import { FormFieldEditor } from './FormFieldEditor'
import { FORM_EDITOR_DROPPABLE_ID } from './constant'

export interface FormEditorMainProps {
  formConfig: FormViewConfig
  formFields: FormFieldMeta[]
  viewName?: string
  updateFormConfig: (patch: Partial<FormViewConfig>) => Promise<void>
  setFieldVisible: (fieldId: string, visible: boolean) => Promise<void>
  activeFieldId?: string | null
}

export const FormEditorMain: React.FC<FormEditorMainProps> = ({
  formConfig,
  formFields,
  viewName,
  updateFormConfig,
  setFieldVisible,
  activeFieldId,
}) => {
  const { t } = useTranslation('view')
  const openForEdit = useFieldSettingStore(s => s.openForEdit)

  // ── Cover image upload ──
  const coverInputRef = useRef<HTMLInputElement>(null)
  const coverUploader = useUpload({
    module: 'tabdata',
    folder: 'form-covers',
    preset: 'IMAGE',
    trackInQueue: false,
  })

  const handleCoverSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const result = await coverUploader.upload(file)
        await updateFormConfig({ cover_url: result.accessUrl })
      } catch {
        toast.error(t('form.uploadFailed'))
      }
      if (coverInputRef.current) coverInputRef.current.value = ''
    },
    [coverUploader, updateFormConfig, t],
  )

  const handleCoverReset = useCallback(async () => {
    await updateFormConfig({ cover_url: undefined })
  }, [updateFormConfig])

  // ── Logo upload ──
  const logoInputRef = useRef<HTMLInputElement>(null)
  const logoUploader = useUpload({
    module: 'tabdata',
    folder: 'form-logos',
    preset: 'IMAGE',
    trackInQueue: false,
  })

  const handleLogoSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        const result = await logoUploader.upload(file)
        await updateFormConfig({ logo_url: result.accessUrl })
      } catch {
        toast.error(t('form.uploadFailed'))
      }
      if (logoInputRef.current) logoInputRef.current.value = ''
    },
    [logoUploader, updateFormConfig, t],
  )

  const handleLogoReset = useCallback(async () => {
    await updateFormConfig({ logo_url: undefined })
  }, [updateFormConfig])

  // ── Title (inline editing, save on blur) ──
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const titleValue = titleDraft ?? formConfig.title ?? viewName ?? ''

  const handleTitleBlur = useCallback(async () => {
    if (titleDraft === null) return
    const trimmed = titleDraft.trim()
    if (trimmed !== (formConfig.title ?? '')) {
      await updateFormConfig({ title: trimmed || undefined })
    }
    setTitleDraft(null)
  }, [titleDraft, formConfig.title, updateFormConfig])

  // ── Description (textarea, save on blur) ──
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const descValue = descDraft ?? formConfig.description ?? ''

  const handleDescBlur = useCallback(async () => {
    if (descDraft === null) return
    const trimmed = descDraft.trim()
    if (trimmed !== (formConfig.description ?? '')) {
      await updateFormConfig({ description: trimmed || undefined })
    }
    setDescDraft(null)
  }, [descDraft, formConfig.description, updateFormConfig])

  // ── Submit label (Popover editing) ──
  const [submitLabelDraft, setSubmitLabelDraft] = useState<string | null>(null)
  const [submitPopoverOpen, setSubmitPopoverOpen] = useState(false)
  const submitLabelValue = submitLabelDraft ?? formConfig.submit_label ?? ''

  const handleSubmitLabelSave = useCallback(async () => {
    if (submitLabelDraft === null) {
      setSubmitPopoverOpen(false)
      return
    }
    const trimmed = submitLabelDraft.trim()
    if (trimmed !== (formConfig.submit_label ?? '')) {
      await updateFormConfig({ submit_label: trimmed || undefined })
    }
    setSubmitLabelDraft(null)
    setSubmitPopoverOpen(false)
  }, [submitLabelDraft, formConfig.submit_label, updateFormConfig])

  // ── Field actions ──
  const handleHideField = useCallback(
    (fieldId: string) => {
      setFieldVisible(fieldId, false)
    },
    [setFieldVisible],
  )

  const sortableIds = formFields.map(f => f.id)

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {/* ── Cover Image ── */}
        <div className="group relative mb-6">
          {formConfig.cover_url ? (
            <div className="relative overflow-hidden rounded-xl">
              <img
                src={formConfig.cover_url}
                alt=""
                className="h-48 w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={coverUploader.isUploading}
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  {coverUploader.isUploading
                    ? t('form.uploadingCover')
                    : t('form.coverReplace')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleCoverReset}
                >
                  <X className="h-3.5 w-3.5" />
                  {t('form.coverReset')}
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                'flex h-32 w-full items-center justify-center rounded-xl border-2 border-dashed border-border',
                'text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/30',
              )}
              onClick={() => coverInputRef.current?.click()}
              disabled={coverUploader.isUploading}
            >
              <div className="flex items-center gap-2 text-body">
                <ImagePlus className="h-5 w-5" />
                {coverUploader.isUploading
                  ? t('form.uploadingCover')
                  : t('form.coverUpload')}
              </div>
            </button>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleCoverSelect}
          />
        </div>

        {/* ── Logo ── */}
        <div className="group relative mb-6 flex items-start gap-4">
          {formConfig.logo_url ? (
            <div className="relative shrink-0">
              <img
                src={formConfig.logo_url}
                alt=""
                className="h-16 w-16 rounded-lg object-cover ring-1 ring-border"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-1 rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={logoUploader.isUploading}
                  aria-label={t('form.logoReplace')}
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleLogoReset}
                  aria-label={t('form.logoReset')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                'flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-border',
                'text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/30',
              )}
              onClick={() => logoInputRef.current?.click()}
              disabled={logoUploader.isUploading}
            >
              {logoUploader.isUploading ? (
                <span className="text-caption">{t('form.uploadingLogo')}</span>
              ) : (
                <ImagePlus className="h-5 w-5" />
              )}
            </button>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleLogoSelect}
          />

          {/* ── Title + Description (next to logo) ── */}
          <div className="min-w-0 flex-1">
            <input
              className={cn(
                'w-full border-0 bg-transparent text-heading font-semibold outline-none',
                'placeholder:text-muted-foreground/40',
                'focus:ring-0',
              )}
              value={titleValue}
              placeholder={t('form.titlePlaceholder')}
              onChange={e => setTitleDraft(e.target.value)}
              onFocus={() => setTitleDraft(formConfig.title ?? '')}
              onBlur={handleTitleBlur}
            />
            <Textarea
              className={cn(
                'mt-2 resize-none border-0 bg-transparent p-0 text-body shadow-none',
                'placeholder:text-muted-foreground/40',
                'focus-visible:ring-0',
              )}
              value={descValue}
              placeholder={t('form.descriptionPlaceholder')}
              rows={2}
              onChange={e => setDescDraft(e.target.value)}
              onFocus={() => setDescDraft(descValue)}
              onBlur={handleDescBlur}
            />
          </div>
        </div>

        {/* ── Sortable Fields ── */}
        {formFields.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
            <Settings2 className="h-8 w-8" />
            <p className="text-body">{t('form.noFields')}</p>
            <p className="text-caption">{t('form.noFieldsHint')}</p>
          </div>
        ) : (
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <DroppableContainer id={FORM_EDITOR_DROPPABLE_ID}>
              <div className="space-y-3">
                {formFields.map((field, index) => (
                  <SortableItem
                    key={field.id}
                    id={field.id}
                    index={index}
                    field={field}
                    draggingClassName="opacity-40"
                    onClick={() => openForEdit(field.id)}
                  >
                    <FormFieldEditor
                      field={field}
                      onHide={handleHideField}
                      isActive={activeFieldId === field.id}
                    />
                  </SortableItem>
                ))}
              </div>
            </DroppableContainer>
          </SortableContext>
        )}

        {/* ── Submit Button + Label Editor ── */}
        {formFields.length > 0 && (
          <div className="mt-8">
            <Popover open={submitPopoverOpen} onOpenChange={setSubmitPopoverOpen}>
              <PopoverTrigger asChild>
                <div className="group relative cursor-pointer">
                  <Button className="w-full pointer-events-none" size="form" tabIndex={-1}>
                    {formConfig.submit_label || t('form.defaultSubmitLabel')}
                  </Button>
                  <button
                    type="button"
                    className={cn(
                      'absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center',
                      'rounded-full border border-border bg-background shadow-sm',
                      'text-muted-foreground opacity-0 transition-opacity hover:text-foreground',
                      'group-hover:opacity-100',
                    )}
                    onClick={e => {
                      e.stopPropagation()
                      setSubmitPopoverOpen(true)
                    }}
                    aria-label={t('form.editSubmitLabel')}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-72" align="center" side="top">
                <div className="space-y-3">
                  <Label className="text-body font-medium">
                    {t('form.submitButtonText')}
                  </Label>
                  <Input
                    value={submitLabelValue}
                    placeholder={t('form.submitLabelPlaceholder')}
                    onChange={e => setSubmitLabelDraft(e.target.value)}
                    onFocus={() => {
                      if (submitLabelDraft === null) {
                        setSubmitLabelDraft(formConfig.submit_label ?? '')
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        handleSubmitLabelSave()
                      }
                    }}
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleSubmitLabelSave}>
                      {t('actions.save')}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

export default FormEditorMain
