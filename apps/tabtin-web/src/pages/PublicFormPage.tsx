import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ClipboardList,
  Lock,
  CheckCircle2,
  Loader2,
  AlertCircle,
  ExternalLink,
  ChevronDown,
  Check,
} from 'lucide-react'
import { resolveChoiceTagColors } from '@tabtin/smartsheet-ui'
import { API_BASE_URL } from '@/config/api'

interface FormFieldMeta {
  id: string
  name: string
  field_type: string
  config: Record<string, unknown>
  description: string
  default_value?: unknown
}

interface FormMeta {
  share_id: string
  title: string
  description: string
  cover_url: string
  submit_label: string
  success_message: string
  redirect_url: string
  allow_multiple_submit: boolean
  login_required: boolean
  has_password: boolean
  fields: FormFieldMeta[]
}

type PageState = 'loading' | 'password' | 'form' | 'submitted' | 'error'

async function apiFetch(path: string, options?: RequestInit) {
  const base = API_BASE_URL || `${window.location.origin}/api`
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok && res.status >= 500) {
    throw new Error(`HTTP ${res.status}`)
  }
  return res.json()
}

export function PublicFormPage() {
  const { shareId } = useParams<{ shareId: string }>()
  const { t } = useTranslation('view')

  const [pageState, setPageState] = useState<PageState>('loading')
  const [formMeta, setFormMeta] = useState<FormMeta | null>(null)
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [redirectUrl, setRedirectUrl] = useState('')

  const draftKey = shareId ? `tabtin-form-${shareId}` : null

  const readDraft = useCallback(
    (meta: FormMeta): Record<string, unknown> | null => {
      if (!draftKey) return null
      try {
        const raw = localStorage.getItem(draftKey)
        if (!raw) return null
        const draft = JSON.parse(raw) as { values?: Record<string, unknown>; updatedAt?: number }
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
        if (draft.updatedAt && Date.now() - draft.updatedAt > TWENTY_FOUR_HOURS) {
          localStorage.removeItem(draftKey)
          return null
        }
        if (!draft.values || typeof draft.values !== 'object') return null
        const validFieldIds = new Set(meta.fields.map(f => f.id))
        const restored: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(draft.values)) {
          if (validFieldIds.has(key)) restored[key] = val
        }
        return Object.keys(restored).length > 0 ? restored : null
      } catch {
        return null
      }
    },
    [draftKey],
  )

  const clearDraft = useCallback(() => {
    if (!draftKey) return
    try {
      localStorage.removeItem(draftKey)
    } catch {
      /* storage unavailable */
    }
  }, [draftKey])

  useEffect(() => {
    if (pageState !== 'form' || !draftKey) return
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ values: formValues, updatedAt: Date.now() }),
      )
    } catch {
      /* storage full or unavailable */
    }
  }, [formValues, pageState, draftKey])

  useEffect(() => {
    if (!shareId) return
    loadForm()
  }, [shareId])

  const loadForm = useCallback(async () => {
    setPageState('loading')
    try {
      const data = await apiFetch(`/tabdata/forms/${shareId}`)
      if (!data.success) {
        setPageState('error')
        return
      }
      const meta = data.data
      if (meta.has_password && !meta.fields) {
        setPageState('password')
        setFormMeta({ ...meta, fields: [] } as FormMeta)
        return
      }
      setFormMeta(meta)
      initDefaults(meta)
      const draft = readDraft(meta)
      if (draft) {
        setFormValues(prev => ({ ...prev, ...draft }))
      }
      setPageState('form')
    } catch {
      setPageState('error')
    }
  }, [shareId, readDraft])

  const initDefaults = (meta: FormMeta) => {
    const defaults: Record<string, unknown> = {}
    for (const field of meta.fields) {
      if (field.default_value != null) {
        defaults[field.id] = field.default_value
      }
    }
    setFormValues(defaults)
  }

  const handlePasswordSubmit = useCallback(async () => {
    if (!shareId || !password) return
    setPasswordError('')
    try {
      const data = await apiFetch(`/tabdata/forms/${shareId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      if (!data.success) {
        setPasswordError(data.message || t('form.passwordIncorrect'))
        return
      }
      setFormMeta(data.data)
      initDefaults(data.data)
      const draft = readDraft(data.data)
      if (draft) {
        setFormValues(prev => ({ ...prev, ...draft }))
      }
      setPageState('form')
    } catch {
      setPasswordError(t('form.networkError'))
    }
  }, [shareId, password, t, readDraft])

  const handleFieldChange = useCallback((fieldId: string, value: unknown) => {
    setFormValues(prev => ({ ...prev, [fieldId]: value }))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!shareId || !formMeta) return
    setSubmitError('')

    setSubmitting(true)
    try {
      const headers: Record<string, string> = {}
      if (password) {
        headers['X-Form-Password'] = password
      }
      const data = await apiFetch(`/tabdata/forms/${shareId}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ fields: formValues }),
      })
      if (!data.success) {
        setSubmitError(data.message || data.detail || t('form.submitFailed'))
        return
      }
      clearDraft()
      setSuccessMessage(data.data?.message || formMeta.success_message || t('form.defaultSuccessMessage'))
      setRedirectUrl(data.data?.redirect_url || formMeta.redirect_url || '')
      setPageState('submitted')
    } catch {
      setSubmitError(t('form.networkError'))
    } finally {
      setSubmitting(false)
    }
  }, [shareId, formMeta, formValues, password, t, clearDraft])

  const handleSubmitAnother = useCallback(() => {
    if (!formMeta) return
    clearDraft()
    initDefaults(formMeta)
    setSubmitError('')
    setPageState('form')
  }, [formMeta, clearDraft])

  if (pageState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'hsl(var(--canvas))' }}>
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (pageState === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: 'hsl(var(--canvas))' }}>
        <div className="text-center space-y-4 max-w-sm">
          <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground/40" />
          <h1 className="text-title font-semibold text-foreground">{t('form.notFound')}</h1>
          <p className="text-body text-muted-foreground">{t('form.notFoundDesc')}</p>
        </div>
      </div>
    )
  }

  if (pageState === 'password') {
    return (
      <div className="flex min-h-screen items-center justify-center p-4" style={{ background: 'hsl(var(--canvas))' }}>
        <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-background p-8 shadow-lg">
          <div className="text-center">
            <Lock className="mx-auto mb-3 h-10 w-10 text-primary/60" />
            <h1 className="text-title font-semibold">{formMeta?.title || t('form.protectedForm')}</h1>
            <p className="mt-1 text-body text-muted-foreground">{t('form.enterPassword')}</p>
          </div>
          <div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePasswordSubmit()}
              placeholder={t('form.passwordPlaceholder')}
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-body outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {passwordError && (
              <p className="mt-1.5 text-caption text-destructive">{passwordError}</p>
            )}
          </div>
          <button
            onClick={handlePasswordSubmit}
            className="w-full rounded-md bg-primary py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('form.unlockForm')}
          </button>
        </div>
      </div>
    )
  }

  if (pageState === 'submitted') {
    return (
      <div className="flex min-h-screen items-center justify-center p-4" style={{ background: 'hsl(var(--canvas))' }}>
        <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-background p-8 shadow-lg text-center">
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
          <h1 className="text-title font-semibold">{t('form.submitted')}</h1>
          <p className="text-body text-muted-foreground">{successMessage}</p>
          <div className="flex flex-col gap-3">
            {formMeta?.allow_multiple_submit && (
              <button
                onClick={handleSubmitAnother}
                className="w-full rounded-md border border-border py-2 text-body font-medium text-foreground hover:bg-accent/50 transition-colors"
              >
                {t('form.submitAnother')}
              </button>
            )}
            {redirectUrl && (
              <a
                href={redirectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-body font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('form.goToLink')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen py-8 px-4" style={{ background: 'hsl(var(--canvas))' }}>
      <div className="mx-auto max-w-xl">
        <div className="rounded-xl border border-border bg-background shadow-sm overflow-hidden">
          {formMeta?.cover_url && (
            <img
              src={formMeta.cover_url}
              alt=""
              className="w-full h-48 object-cover"
            />
          )}

          <div className="p-6 sm:p-8">
            {/* 头部 */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-2">
                <ClipboardList className="h-6 w-6 text-primary" />
                <h1 className="text-heading font-semibold text-foreground">
                  {formMeta?.title || t('form.untitledForm')}
                </h1>
              </div>
              {formMeta?.description && (
                <p className="text-body text-muted-foreground">{formMeta.description}</p>
              )}
            </div>

            {/* 字段列表 */}
            <div className="space-y-6">
              {(formMeta?.fields ?? []).map(field => (
                <FormField
                  key={field.id}
                  field={field}
                  value={formValues[field.id]}
                  onChange={val => handleFieldChange(field.id, val)}
                />
              ))}
            </div>

            {/* 错误 */}
            {submitError && (
              <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-body text-destructive">
                {submitError}
              </div>
            )}

            {/* 提交按钮 */}
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="mt-8 w-full rounded-md bg-primary py-2.5 text-body font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('form.submitting')}
                </span>
              ) : (
                formMeta?.submit_label || t('form.defaultSubmitLabel')
              )}
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-caption text-muted-foreground/60">
          Powered by TabTin
        </p>
      </div>
    </div>
  )
}

function FormField({
  field,
  value,
  onChange,
}: {
  field: FormFieldMeta
  value: unknown
  onChange: (val: unknown) => void
}) {
  const { t } = useTranslation('view')
  const strVal = value != null ? String(value) : ''

  const selectOptions: { value: string; label: string; color?: string }[] = useMemo(() => {
    const opts = (field.config?.options ?? []) as Array<{ value?: string; name?: string; label?: string; color?: string }>
    return opts.map(o => ({
      value: o.value ?? o.name ?? '',
      label: o.label ?? o.name ?? o.value ?? '',
      color: o.color,
    }))
  }, [field.config])

  const inputBorderClass = 'border-border focus:border-primary focus:ring-primary'

  const renderEditor = () => {
    if (field.field_type === 'long_text') {
      return (
        <textarea
          value={strVal}
          onChange={e => onChange(e.target.value)}
          rows={4}
          className={`w-full resize-none rounded-md border bg-transparent px-3 py-2 text-body outline-none focus:ring-1 ${inputBorderClass}`}
          placeholder={field.name}
        />
      )
    }

    if (field.field_type === 'checkbox') {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={e => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <span className="text-body text-foreground">{field.name}</span>
        </label>
      )
    }

    if (field.field_type === 'select') {
      return (
        <FormSelectDropdown
          value={strVal}
          options={selectOptions}
          placeholder={t('form.selectPlaceholder')}
          onChange={onChange}
        />
      )
    }

    if (field.field_type === 'multi_select') {
      return (
        <div className="flex flex-wrap gap-2">
          {selectOptions.map(opt => {
            const selected = Array.isArray(value) && value.includes(opt.value)
            const tagColors = resolveChoiceTagColors(opt)
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  const arr = Array.isArray(value) ? [...value] : []
                  const newVal = selected
                    ? arr.filter(v => v !== opt.value)
                    : [...arr, opt.value]
                  onChange(newVal)
                }}
                className="rounded-full border px-3 py-1 text-caption transition-all"
                style={
                  selected
                    ? { backgroundColor: tagColors.backgroundColor, color: tagColors.color, borderColor: tagColors.backgroundColor }
                    : { borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )
    }

    if (field.field_type === 'number' || field.field_type === 'currency' || field.field_type === 'percent') {
      return (
        <input
          type="number"
          value={strVal}
          onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
          className={`w-full rounded-md border bg-transparent px-3 py-2 text-body outline-none focus:ring-1 ${inputBorderClass}`}
          placeholder={field.name}
        />
      )
    }

    if (field.field_type === 'date') {
      return (
        <input
          type="date"
          value={strVal}
          onChange={e => onChange(e.target.value)}
          className={`w-full rounded-md border bg-transparent px-3 py-2 text-body outline-none focus:ring-1 ${inputBorderClass}`}
        />
      )
    }

    if (field.field_type === 'rating') {
      const maxStars = (typeof field.config?.max === 'number' && field.config.max > 0)
        ? field.config.max
        : 5
      return (
        <div className="flex gap-1">
          {Array.from({ length: maxStars }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onChange(i + 1)}
              className={`text-xl transition-colors ${
                typeof value === 'number' && value > i ? 'text-amber-400' : 'text-muted-foreground/30'
              }`}
            >
              ★
            </button>
          ))}
        </div>
      )
    }

    return (
      <input
        type={field.field_type === 'email' ? 'email' : field.field_type === 'url' ? 'url' : field.field_type === 'phone' ? 'tel' : 'text'}
        value={strVal}
        onChange={e => onChange(e.target.value)}
        className={`w-full rounded-md border bg-transparent px-3 py-2 text-body outline-none focus:ring-1 ${inputBorderClass}`}
        placeholder={field.name}
      />
    )
  }

  return (
    <div className="space-y-1.5">
      <label className="text-body font-medium text-foreground">
        {field.name}
      </label>
      {field.description && (
        <p className="text-caption text-muted-foreground">{field.description}</p>
      )}
      {renderEditor()}
    </div>
  )
}

function FormSelectDropdown({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: { value: string; label: string; color?: string }[]
  placeholder: string
  onChange: (val: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(o => o.value === value)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const borderClass = open ? 'border-primary ring-1 ring-primary' : 'border-border'

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-body outline-none transition-colors ${borderClass}`}
      >
        <span className={selectedOption ? 'text-foreground' : 'text-muted-foreground'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-md border border-border bg-background shadow-lg">
          {value && (
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false) }}
              className="flex w-full items-center px-3 py-2 text-body text-muted-foreground hover:bg-accent/50 transition-colors"
            >
              {placeholder}
            </button>
          )}
          {options.map(opt => {
            const isSelected = opt.value === value
            const tagColors = opt.color ? resolveChoiceTagColors(opt) : null
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-body transition-colors ${
                  isSelected ? 'bg-accent/60 text-foreground' : 'text-foreground hover:bg-accent/50'
                }`}
              >
                {tagColors && (
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tagColors.backgroundColor }}
                  />
                )}
                <span className="flex-1 text-left">{opt.label}</span>
                {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
