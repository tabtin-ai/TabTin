import React, { useMemo, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
  Button,
  Input,
  Label,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Checkbox,
  ScrollArea,
  ScrollBar,
  Textarea,
  cn,
} from '@tabtin/smartsheet-ui'
import { Check, ChevronDown } from 'lucide-react'
import type {
  Field,
  ViewType,
  ViewCreateRequest,
  ViewUpdateRequest,
  ViewMeta,
} from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import {
  isKanbanGroupableFieldType,
  isViewCoverFieldType,
  useViewEditorForm,
} from '@tabtin/table-ui'

type FormMode = 'create' | 'edit'

type ViewEditorFocus = 'full' | 'typeConfig'

interface ViewEditorDialogProps {
  mode: FormMode
  open: boolean
  onOpenChange: (open: boolean) => void
  fields: Field[]
  isSubmitting?: boolean
  initialView?: ViewMeta | null
  trigger?: React.ReactNode
  /** full = 完整编辑；typeConfig = 仅类型专属配置（卡片/日历配置入口） */
  focus?: ViewEditorFocus
  onSubmit: (payload: ViewCreateRequest | ViewUpdateRequest) => Promise<void> | void
}

const CALENDAR_DATE_FIELD_TYPES = new Set(['date', 'created_time', 'last_modified_time'])

const isKanbanGroupField = (field: Field) => isKanbanGroupableFieldType(field.field_type)
const isCalendarDateField = (field: Field) => CALENDAR_DATE_FIELD_TYPES.has(field.field_type)
const isCoverField = (field: Field) => isViewCoverFieldType(field.field_type)

/* ------------------------------------------------------------------ */
/*  ComboboxSelect — reusable Popover+Command selector                 */
/* ------------------------------------------------------------------ */

interface ComboboxSelectProps {
  value: string | undefined
  options: { value: string; label: string }[]
  onSelect: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyLabel?: string
  disabled?: boolean
  className?: string
}

const ComboboxSelect: React.FC<ComboboxSelectProps> = ({
  value,
  options,
  onSelect,
  placeholder = '',
  searchPlaceholder = '',
  emptyLabel = '',
  disabled,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const selected = options.find(o => o.value === value)
  const label = selected ? selected.label : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-9 w-full justify-between gap-1 px-3 text-body font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            containerClassName="h-9 focus-within:!outline-none focus-within:!ring-0 focus-within:!ring-offset-0"
            className="!outline-none !ring-0 !ring-offset-0 focus:!outline-none focus:!ring-0 focus:!ring-offset-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0"
          />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onSelect(option.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5',
                      value === option.value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const ViewEditorDialog: React.FC<ViewEditorDialogProps> = ({
  mode,
  open,
  onOpenChange,
  fields,
  isSubmitting = false,
  initialView = null,
  trigger,
  focus = 'full',
  onSubmit,
}) => {
  const { t, i18n } = useTranslation(['view', 'common', 'field'])
  const comboboxSearchPlaceholder = String(t('view:editor.searchPlaceholder'))
  const comboboxNoResults = String(t('view:editor.noResults'))
  const isTypeConfigFocus = focus === 'typeConfig'

  const form = useViewEditorForm({
    open,
    mode,
    initialView: initialView ?? null,
    fields,
    translate: t,
  })

  const viewTypeOptions = useMemo(
    () => [
      { label: String(t('view:types.grid')), value: 'grid' as ViewType },
      { label: String(t('view:types.kanban')), value: 'kanban' as ViewType },
      { label: String(t('view:types.calendar')), value: 'calendar' as ViewType },
      { label: String(t('view:types.gallery')), value: 'gallery' as ViewType },
    ],
    [t, i18n.language]
  )

  /* ---- Field option helpers ---- */
  const fieldOptions = useMemo(
    () => form.selectableFields.map(f => ({ value: f.id, label: f.name })),
    [form.selectableFields],
  )
  const kanbanGroupFieldOptions = useMemo(
    () => form.selectableFields.filter(isKanbanGroupField).map(f => ({
      value: f.id,
      label: `${f.name}  (${String(t(`field:types.${f.field_type}`, { defaultValue: f.field_type }))})`,
    })),
    [form.selectableFields, t],
  )
  const calendarDateFieldOptions = useMemo(
    () => form.selectableFields.filter(isCalendarDateField).map(f => ({
      value: f.id,
      label: `${f.name}  (${String(t(`field:types.${f.field_type}`, { defaultValue: f.field_type }))})`,
    })),
    [form.selectableFields, t],
  )
  const coverFieldOptions = useMemo(
    () => form.selectableFields.filter(isCoverField).map(f => ({
      value: f.id,
      label: `${f.name}  (${String(t(`field:types.${f.field_type}`, { defaultValue: f.field_type }))})`,
    })),
    [form.selectableFields, t],
  )
  const noneOption = { value: '__none__', label: String(t('view:editor.kanban.coverNone')) }

  const handleSubmit = async () => {
    const result = form.buildAndValidate()
    if (result.error !== null) {
      form.setError(result.error)
      return
    }
    form.setError(null)
    await onSubmit(result.payload)
  }

  const renderTypeSpecificFields = () => {
    if (form.viewType === 'kanban') {
      return (
        <div className="space-y-3">
          {!isTypeConfigFocus && (
            <div className="space-y-1.5">
              <Label>{t('view:editor.kanban.groupLabel')}</Label>
              <ComboboxSelect
                value={form.kanban.groupField}
                options={kanbanGroupFieldOptions}
                onSelect={v => form.kanban.setGroupField(v)}
                placeholder={String(t('view:editor.kanban.groupPlaceholder'))}
                searchPlaceholder={comboboxSearchPlaceholder}
                emptyLabel={String(t('view:editor.kanban.groupEmpty'))}
              />
              {kanbanGroupFieldOptions.length === 0 && (
                <p className="text-caption text-muted-foreground/80">{t('view:editor.kanban.groupHint')}</p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t('view:editor.kanban.titleLabel')}</Label>
            <ComboboxSelect
              value={form.kanban.titleField}
              options={fieldOptions}
              onSelect={v => form.kanban.setTitleField(v)}
              placeholder={String(t('view:editor.kanban.titlePlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.kanban.coverLabel')}</Label>
            <ComboboxSelect
              value={form.kanban.coverField ?? '__none__'}
              options={[noneOption, ...coverFieldOptions]}
              onSelect={v => form.kanban.setCoverField(v === '__none__' ? undefined : v)}
              placeholder={String(t('view:editor.kanban.coverPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={String(t('view:editor.kanban.coverEmpty'))}
            />
            {coverFieldOptions.length === 0 && (
              <p className="text-caption text-muted-foreground/80">{t('view:editor.kanban.coverHint')}</p>
            )}
          </div>
        </div>
      )
    }

    if (form.viewType === 'calendar') {
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('view:editor.calendar.dateLabel')}</Label>
            <ComboboxSelect
              value={form.calendar.dateField}
              options={calendarDateFieldOptions}
              onSelect={v => form.calendar.setDateField(v)}
              placeholder={String(t('view:editor.calendar.datePlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={String(t('view:editor.calendar.dateEmpty'))}
            />
            {calendarDateFieldOptions.length === 0 && (
              <p className="text-caption text-muted-foreground/80">{t('view:editor.calendar.dateHint')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.calendar.titleLabel')}</Label>
            <ComboboxSelect
              value={form.calendar.titleField}
              options={fieldOptions}
              onSelect={v => form.calendar.setTitleField(v)}
              placeholder={String(t('view:editor.calendar.titlePlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
        </div>
      )
    }

    if (form.viewType === 'gallery') {
      const gallerySizeOptions = [
        { value: 'small', label: String(t('view:editor.gallery.sizeSmall')) },
        { value: 'medium', label: String(t('view:editor.gallery.sizeMedium')) },
        { value: 'large', label: String(t('view:editor.gallery.sizeLarge')) },
      ]

      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('view:editor.gallery.titleLabel')}</Label>
            <ComboboxSelect
              value={form.gallery.titleField}
              options={fieldOptions}
              onSelect={v => form.gallery.setTitleField(v)}
              placeholder={String(t('view:editor.gallery.titlePlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.gallery.descriptionLabel')}</Label>
            <ComboboxSelect
              value={form.gallery.descriptionField ?? '__none__'}
              options={[{ value: '__none__', label: String(t('view:editor.gallery.descriptionNone')) }, ...fieldOptions]}
              onSelect={v => form.gallery.setDescriptionField(v === '__none__' ? undefined : v)}
              placeholder={String(t('view:editor.gallery.descriptionPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.gallery.coverLabel')}</Label>
            <ComboboxSelect
              value={form.gallery.coverField ?? '__none__'}
              options={[{ value: '__none__', label: String(t('view:editor.gallery.coverNone')) }, ...coverFieldOptions]}
              onSelect={v => form.gallery.setCoverField(v === '__none__' ? undefined : v)}
              placeholder={String(t('view:editor.gallery.coverPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={String(t('view:editor.gallery.coverEmpty'))}
            />
            {coverFieldOptions.length === 0 && (
              <p className="text-caption text-muted-foreground/80">{t('view:editor.gallery.coverHint')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.gallery.sizeLabel')}</Label>
            <ComboboxSelect
              value={form.gallery.cardSize}
              options={gallerySizeOptions}
              onSelect={v => form.gallery.setCardSize(v)}
              placeholder={String(t('view:editor.gallery.sizePlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
        </div>
      )
    }

    if (form.viewType === 'flashcard') {
      const checkboxFields = form.selectableFields.filter(f => f.field_type === 'checkbox')
      const checkboxFieldOptions = checkboxFields.map(f => ({ value: f.id, label: f.name }))
      const tagFieldTypes = ['select', 'multi_select']
      const tagFields = form.selectableFields.filter(f => tagFieldTypes.includes(f.field_type))
      const tagFieldOptions = tagFields.map(f => ({ value: f.id, label: f.name }))

      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('view:editor.flashcard.frontLabel')}</Label>
            <ComboboxSelect
              value={form.flashcard.frontField}
              options={fieldOptions}
              onSelect={v => form.flashcard.setFrontField(v)}
              placeholder={String(t('view:editor.flashcard.frontPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.flashcard.backLabel')}</Label>
            <ComboboxSelect
              value={form.flashcard.backField}
              options={fieldOptions}
              onSelect={v => form.flashcard.setBackField(v)}
              placeholder={String(t('view:editor.flashcard.backPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.flashcard.masteryLabel')}</Label>
            <ComboboxSelect
              value={form.flashcard.masteryField ?? '__none__'}
              options={[{ value: '__none__', label: String(t('view:editor.flashcard.masteryNone')) }, ...checkboxFieldOptions]}
              onSelect={v => form.flashcard.setMasteryField(v === '__none__' ? undefined : v)}
              placeholder={String(t('view:editor.flashcard.masteryPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.flashcard.tagsLabel')}</Label>
            <ComboboxSelect
              value={form.flashcard.tagsField ?? '__none__'}
              options={[{ value: '__none__', label: String(t('view:editor.flashcard.tagsNone')) }, ...tagFieldOptions]}
              onSelect={v => form.flashcard.setTagsField(v === '__none__' ? undefined : v)}
              placeholder={String(t('view:editor.flashcard.tagsPlaceholder'))}
              searchPlaceholder={comboboxSearchPlaceholder}
              emptyLabel={comboboxNoResults}
            />
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={form.flashcard.autoShuffle}
                onCheckedChange={v => form.flashcard.setAutoShuffle(!!v)}
              />
              {t('view:editor.flashcard.autoShuffle')}
            </label>
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={form.flashcard.showProgress}
                onCheckedChange={v => form.flashcard.setShowProgress(!!v)}
              />
              {t('view:editor.flashcard.showProgress')}
            </label>
          </div>
        </div>
      )
    }

    if (form.viewType === 'form') {
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('view:editor.form.titleLabel')}</Label>
            <Input
              value={String(form.config.title ?? '')}
              onChange={e => form.setConfig({ ...form.config, title: e.target.value })}
              placeholder={String(t('view:editor.form.titlePlaceholder'))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.form.descriptionLabel')}</Label>
            <Textarea
              value={String(form.config.description ?? '')}
              onChange={e => form.setConfig({ ...form.config, description: e.target.value })}
              placeholder={String(t('view:editor.form.descriptionPlaceholder'))}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.form.submitLabelLabel')}</Label>
            <Input
              value={String(form.config.submit_label ?? '')}
              onChange={e => form.setConfig({ ...form.config, submit_label: e.target.value })}
              placeholder={String(t('view:editor.form.submitLabelPlaceholder'))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('view:editor.form.successMessageLabel')}</Label>
            <Textarea
              value={String(form.config.success_message ?? '')}
              onChange={e => form.setConfig({ ...form.config, success_message: e.target.value })}
              placeholder={String(t('view:editor.form.successMessagePlaceholder'))}
              rows={2}
            />
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={form.config.allow_multiple_submit !== false}
                onCheckedChange={v => form.setConfig({ ...form.config, allow_multiple_submit: !!v })}
              />
              {t('view:editor.form.allowMultipleSubmit')}
            </label>
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={Boolean(form.config.login_required)}
                onCheckedChange={v => form.setConfig({ ...form.config, login_required: !!v })}
              />
              {t('view:editor.form.loginRequired')}
            </label>
          </div>
        </div>
      )
    }

    return null
  }

  const panelTitle = (() => {
    if (isTypeConfigFocus) {
      if (form.viewType === 'calendar') return t('view:editor.titleCalendarConfig')
      return t('view:editor.titleCardConfig')
    }
    return mode === 'create' ? t('view:editor.titleCreate') : t('view:editor.titleEdit')
  })()
  const panelDescription = (() => {
    if (isTypeConfigFocus) {
      if (form.viewType === 'calendar') return t('view:editor.descriptionCalendarConfig')
      return t('view:editor.descriptionCardConfig')
    }
    return mode === 'create'
      ? t('view:editor.descriptionCreate')
      : t('view:editor.descriptionEdit')
  })()

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent
        side="right"
        overlay={false}
        className="flex w-[520px] max-w-[520px] flex-col overflow-hidden p-0 shadow-2xl sm:max-w-[520px]"
        onFocusOutside={(event) => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="text-body">{panelTitle}</SheetTitle>
          <SheetDescription className="text-body">{panelDescription}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 px-4 py-4">
            {!isTypeConfigFocus && (
              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="view-name">{t('view:editor.fields.nameLabel')}</Label>
                    <Input
                      id="view-name"
                      value={form.name}
                      onChange={(event) => form.setName(event.target.value)}
                      placeholder={String(t('view:editor.fields.namePlaceholder'))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="view-description">{t('view:editor.fields.descriptionLabel')}</Label>
                    <Input
                      id="view-description"
                      value={form.description}
                      onChange={(event) => form.setDescription(event.target.value)}
                      placeholder={String(t('view:editor.fields.descriptionPlaceholder'))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>{t('view:editor.fields.typeLabel')}</Label>
                    <ComboboxSelect
                      value={form.viewType}
                      options={viewTypeOptions}
                      onSelect={v => form.setViewType(v as ViewType)}
                      placeholder={String(t('view:editor.fields.typePlaceholder'))}
                      searchPlaceholder={comboboxSearchPlaceholder}
                      emptyLabel={comboboxNoResults}
                      disabled={mode === 'edit'}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>{t('view:editor.fields.visibleFieldsLabel')}</Label>
                  <div className="rounded-md border border-border/60">
                    <ScrollArea className="h-40">
                      <div className="space-y-2 p-3">
                        {form.selectableFields.map(field => {
                          const checked = form.visibleFieldIds.includes(field.id)
                          const fieldTypeKey = `field:types.${field.field_type}`
                          const fieldTypeLabel = i18n.exists(fieldTypeKey)
                            ? String(t(fieldTypeKey))
                            : String(t('view:editor.fields.unknownType', { type: field.field_type }))
                          return (
                            <label
                              key={field.id}
                              className={cn(
                                'flex items-center gap-2 rounded-md px-2 py-1.5 text-body transition',
                                checked
                                  ? 'bg-accent/20 text-foreground'
                                  : 'text-muted-foreground hover:bg-accent/10'
                              )}
                            >
                              <Checkbox
                                checked={checked}
                                disabled={field.is_primary && form.lockPrimaryVisibility}
                                onCheckedChange={() => form.toggleVisibleField(field.id)}
                              />
                              <span className="flex-1">{field.name}</span>
                              <span className="text-body uppercase text-muted-foreground">
                                {fieldTypeLabel}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      <ScrollBar />
                    </ScrollArea>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-lg border border-dashed border-border/60 bg-muted/40 p-4">
              {!isTypeConfigFocus && (
                <h4 className="mb-3 text-body font-medium text-foreground">
                  {viewTypeOptions.find(option => option.value === form.viewType)?.label}
                </h4>
              )}
              {renderTypeSpecificFields() || (
                <p className="text-body text-muted-foreground">
                  {t('view:editor.grid.description')}
                </p>
              )}
            </div>

            {form.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {form.error}
              </div>
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="shrink-0 border-t border-border/40 px-4 py-3 sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('common:cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {mode === 'create' ? t('view:editor.actions.create') : t('view:editor.actions.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
