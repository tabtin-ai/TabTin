import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Input,
  Label,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@tabtin/smartsheet-ui'
import type {
  Field,
  ViewCreateRequest,
  ViewMeta,
  ViewType,
  ViewUpdateRequest,
} from '@tabtin/table-core'
import {
  isKanbanGroupableFieldType,
  isViewCoverFieldType,
  useViewEditorForm,
} from '@tabtin/table-ui'

type FormMode = 'create' | 'edit'

interface WebViewEditorDialogProps {
  mode: FormMode
  open: boolean
  onOpenChange: (open: boolean) => void
  fields: Field[]
  isSubmitting?: boolean
  initialView?: ViewMeta | null
  onSubmit: (payload: ViewCreateRequest | ViewUpdateRequest) => Promise<void> | void
}

const VIEW_TYPES: ViewType[] = ['grid', 'kanban', 'calendar', 'gallery', 'flashcard']

export function WebViewEditorDialog({
  mode,
  open,
  onOpenChange,
  fields,
  isSubmitting = false,
  initialView = null,
  onSubmit,
}: WebViewEditorDialogProps) {
  const { t } = useTranslation(['view', 'common'])

  const form = useViewEditorForm({
    open,
    mode,
    initialView: initialView ?? null,
    fields,
    translate: t,
  })

  const dateFields = form.selectableFields.filter((field) => field.field_type === 'date')
  const kanbanGroupFields = form.selectableFields.filter((field) =>
    isKanbanGroupableFieldType(field.field_type),
  )
  const coverFields = form.selectableFields.filter((field) => isViewCoverFieldType(field.field_type))

  const handleSubmit = async () => {
    const result = form.buildAndValidate()
    if (result.error !== null) {
      form.setError(result.error)
      return
    }
    form.setError(null)
    await onSubmit(result.payload)
  }

  const renderSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: Field[],
    allowEmpty = false
  ) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-body"
      >
        {allowEmpty && <option value="">{t('editor.noField')}</option>}
        {!allowEmpty && <option value="" disabled>{label}</option>}
        {options.map((field) => (
          <option key={field.id} value={field.id}>
            {field.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        className="flex w-[min(520px,100vw)] max-w-full flex-col overflow-hidden p-0 shadow-2xl sm:max-w-[520px]"
        onFocusOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-body">
            {mode === 'create' ? t('editor.createTitle') : t('editor.editTitle')}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {mode === 'create' ? t('editor.createTitle') : t('editor.editTitle')}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-5 px-4 py-4">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-1.5">
                <Label>{t('editor.name')}</Label>
                <Input
                  value={form.name}
                  onChange={(event) => form.setName(event.target.value)}
                  placeholder={t('editor.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('editor.type')}</Label>
                <select
                  value={form.viewType}
                  disabled={mode === 'edit'}
                  onChange={(event) => form.setViewType(event.target.value as ViewType)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-body disabled:opacity-60"
                >
                  {VIEW_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`types.${type}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('editor.description')}</Label>
              <Input
                value={form.description}
                onChange={(event) => form.setDescription(event.target.value)}
                placeholder={t('editor.descriptionPlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('editor.visibleFields')}</Label>
              <div className="max-h-48 space-y-2 overflow-auto rounded-md border border-border p-3">
                {form.selectableFields.map((field) => {
                  const checked = form.visibleFieldIds.includes(field.id)
                  const disabled = field.is_primary && form.lockPrimaryVisibility
                  return (
                    <label key={field.id} className="flex items-center gap-2 text-body">
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => form.toggleVisibleField(field.id)}
                      />
                      <span className="flex-1">{field.name}</span>
                      <span className="text-body uppercase text-muted-foreground">{field.field_type}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            {form.viewType === 'kanban' && (
              <div className="grid grid-cols-1 gap-4">
                {renderSelect(t('editor.groupField'), form.kanban.groupField ?? '', (v) => form.kanban.setGroupField(v || undefined), kanbanGroupFields)}
                {renderSelect(t('editor.titleField'), form.kanban.titleField ?? '', (v) => form.kanban.setTitleField(v || undefined), form.selectableFields)}
                {renderSelect(t('editor.coverField'), form.kanban.coverField ?? '', (v) => form.kanban.setCoverField(v || undefined), coverFields, true)}
              </div>
            )}

            {form.viewType === 'calendar' && (
              <div className="grid grid-cols-1 gap-4">
                {renderSelect(t('editor.dateField'), form.calendar.dateField ?? '', (v) => form.calendar.setDateField(v || undefined), dateFields)}
                {renderSelect(t('editor.titleField'), form.calendar.titleField ?? '', (v) => form.calendar.setTitleField(v || undefined), form.selectableFields)}
              </div>
            )}

            {form.viewType === 'gallery' && (
              <div className="grid grid-cols-1 gap-4">
                {renderSelect(t('editor.titleField'), form.gallery.titleField ?? '', (v) => form.gallery.setTitleField(v || undefined), form.selectableFields)}
                {renderSelect(t('editor.descriptionField'), form.gallery.descriptionField ?? '', (v) => form.gallery.setDescriptionField(v || undefined), form.selectableFields, true)}
                {renderSelect(t('editor.coverField'), form.gallery.coverField ?? '', (v) => form.gallery.setCoverField(v || undefined), coverFields, true)}
                <div className="space-y-1.5">
                  <Label>{t('editor.galleryCardSize')}</Label>
                  <select
                    value={form.gallery.cardSize}
                    onChange={(event) => form.gallery.setCardSize(event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-body"
                  >
                    <option value="small">{t('editor.gallerySizeSmall')}</option>
                    <option value="medium">{t('editor.gallerySizeMedium')}</option>
                    <option value="large">{t('editor.gallerySizeLarge')}</option>
                  </select>
                </div>
              </div>
            )}

            {form.viewType === 'flashcard' && (
              <>
                <div className="grid grid-cols-1 gap-4">
                  {renderSelect(t('editor.frontField'), form.flashcard.frontField ?? '', (v) => form.flashcard.setFrontField(v || undefined), form.selectableFields)}
                  {renderSelect(t('editor.backField'), form.flashcard.backField ?? '', (v) => form.flashcard.setBackField(v || undefined), form.selectableFields)}
                  <div className="space-y-1.5">
                    <Label>{t('editor.masteryField')}</Label>
                    <select
                      value={form.flashcard.masteryField ?? ''}
                      onChange={(event) => form.flashcard.setMasteryField(event.target.value || undefined)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-body"
                    >
                      <option value="">{t('editor.masteryNone')}</option>
                      {form.selectableFields.filter((f) => f.field_type === 'checkbox').map((field) => (
                        <option key={field.id} value={field.id}>{field.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('editor.tagsField')}</Label>
                    <select
                      value={form.flashcard.tagsField ?? ''}
                      onChange={(event) => form.flashcard.setTagsField(event.target.value || undefined)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-body"
                    >
                      <option value="">{t('editor.tagsNone')}</option>
                      {form.selectableFields.filter((f) => f.field_type === 'select' || f.field_type === 'multi_select').map((field) => (
                        <option key={field.id} value={field.id}>{field.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 text-body">
                    <Checkbox
                      checked={form.flashcard.autoShuffle}
                      onCheckedChange={(v) => form.flashcard.setAutoShuffle(!!v)}
                    />
                    {t('editor.autoShuffle')}
                  </label>
                  <label className="flex items-center gap-2 text-body">
                    <Checkbox
                      checked={form.flashcard.showProgress}
                      onCheckedChange={(v) => form.flashcard.setShowProgress(!!v)}
                    />
                    {t('editor.showProgress')}
                  </label>
                </div>
              </>
            )}

            {form.error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {form.error}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <SheetFooter className="shrink-0 border-t px-4 py-3 sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={isSubmitting}>
            {mode === 'create' ? t('editor.create') : t('editor.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
