import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Loader2,
  Lock,
} from 'lucide-react'
import {
  Button,
  toast,
  cn,
} from '@tabtin/smartsheet-ui'
import type { FormFieldMeta, FormViewControllerResult } from '@tabtin/table-ui'
import { toOrganizationMembers } from '@tabtin/table-ui'
import {
  buildTableApiUrl,
  ViewApiService,
} from '@tabtin/table-core'
import type { FieldDefaultValue } from '@tabtin/table-core'
import type { WorkspaceMemberInfo } from '@tabtin/table-ui'
import { electronFetch } from '@/services/electronFetch'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { FormField, validateFieldValue } from './FormField'
import { FormLinkPicker } from './FormLinkPicker'
import { getDraftKey, readDraft, writeDraft, clearDraft } from './formDraftUtils'
import {
  buildPublicFormSubmitHeaders,
  buildSubmitValues,
  resolveFormCreatorId,
} from './formSubmitValues'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateFormValues(
  formFields: FormFieldMeta[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of formFields) {
    const val = values[field.id]
    const empty =
      field.field_type === 'checkbox'
        ? val !== true
        : val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)

    if (!empty) {
      const formatError = validateFieldValue(field.field_type, val)
      if (formatError) {
        errors[field.id] = formatError
      }
    }
  }
  return errors
}

function normalizeFieldDefaultValue(raw: unknown): FieldDefaultValue | null | undefined {
  if (raw == null) return raw as null | undefined
  if (typeof raw !== 'object') return undefined
  const spec = raw as { mode?: unknown }
  if (
    spec.mode === 'literal' ||
    spec.mode === 'created_time' ||
    spec.mode === 'last_modified_time' ||
    spec.mode === 'creator'
  ) {
    return raw as FieldDefaultValue
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Share helper
// ---------------------------------------------------------------------------

async function ensureShareId(viewId: string): Promise<{ shareId: string; hasPassword: boolean }> {
  const result = await ViewApiService.createFormShare(viewId)
  const shareId = result?.share?.share_id
  if (!shareId) throw new Error('form-share returned no share_id')
  const hasPassword = Boolean(
    (result?.share as unknown as Record<string, unknown>)?.has_password ?? result?.share?.password,
  )
  return { shareId, hasPassword }
}

// 主进程代理（electronFetch）不透传 AbortSignal，无法靠 AbortController 做客户端
// 超时；这里用 Promise 竞速保留原有的提交超时 UX（超时抛 SUBMIT_TIMEOUT，由
// 调用方转成提示）。底层请求仍受主进程代理自身超时兜底。
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SUBMIT_TIMEOUT')), timeoutMs)
    electronFetch(url, init).then(
      (res) => { clearTimeout(timer); resolve(res) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

async function verifyFormPassword(
  shareId: string,
  password: string,
): Promise<{ ok: boolean; error?: string; formMeta?: Record<string, unknown> }> {
  const url = buildTableApiUrl(`/tabdata/forms/${shareId}/verify`)
  const res = await electronFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const envelope = await res.json().catch(() => ({}))
  if (res.ok) {
    return { ok: true, formMeta: envelope?.data ?? envelope }
  }
  return { ok: false, error: envelope?.message || envelope?.data?.message || '密码错误' }
}

const SUBMIT_TIMEOUT_MS = 30_000

async function submitForm(
  shareId: string,
  fields: Record<string, unknown>,
  password?: string,
  accessToken?: string | null,
): Promise<{ message: string; redirect_url: string; staleShare?: boolean }> {
  const url = buildTableApiUrl(`/tabdata/forms/${shareId}/submit`)
  const headers = buildPublicFormSubmitHeaders(password, accessToken)

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    },
    SUBMIT_TIMEOUT_MS,
  )

  if (res.status === 404 || res.status === 410) {
    return { message: '', redirect_url: '', staleShare: true }
  }
  const envelope = await res.json()
  if (!res.ok) {
    const errMsg = envelope?.message || envelope?.data?.message || envelope?.detail
    throw new Error(errMsg || `submit failed: ${res.status}`)
  }
  const data = envelope?.data ?? envelope
  return {
    message: data?.message ?? '',
    redirect_url: data?.redirect_url ?? '',
  }
}

async function submitFormDirect(
  tableId: string,
  viewId: string,
  fields: Record<string, unknown>,
): Promise<{ message: string; redirect_url: string }> {
  const url = buildTableApiUrl(`/tabdata/tables/${tableId}/views/${viewId}/form-submit`)
  const token = useAuthStore.getState().accessToken
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    },
    SUBMIT_TIMEOUT_MS,
  )
  const envelope = await res.json()
  if (!res.ok) {
    const errMsg = envelope?.message || envelope?.data?.message || envelope?.detail
    throw new Error(errMsg || `submit failed: ${res.status}`)
  }
  const data = envelope?.data ?? envelope
  return {
    message: data?.message ?? '',
    redirect_url: data?.redirect_url ?? '',
  }
}

// InlineFieldEditor removed — FormField now uses shared FieldValueEditor from @tabtin/smartsheet-ui

// ---------------------------------------------------------------------------
// Share collaborators fetcher
// ---------------------------------------------------------------------------

async function fetchShareCollaborators(
  shareId: string,
  password?: string | null,
): Promise<{ data: WorkspaceMemberInfo[] | null; error: boolean }> {
  const url = buildTableApiUrl(`/tabdata/forms/${shareId}/collaborators?page_size=200`)
  const headers: Record<string, string> = {}
  if (password) headers['X-Form-Password'] = password
  try {
    const res = await electronFetch(url, { headers })
    if (!res.ok) return { data: null, error: true }
    const envelope = await res.json().catch(() => ({}))
    const list: Array<{ id: string; name: string; avatar_url?: string }> =
      envelope?.data?.collaborators ?? []
    return {
      data: list.map(c => ({
        id: c.id,
        name: c.name,
        avatarUrl: c.avatar_url || undefined,
      })),
      error: false,
    }
  } catch {
    return { data: null, error: true }
  }
}

// ---------------------------------------------------------------------------
// Success view
// ---------------------------------------------------------------------------

const SuccessView: React.FC<{
  message: string
  redirectUrl: string
  allowMultiple: boolean
  onFillAgain: () => void
}> = ({ message, redirectUrl, allowMultiple, onFillAgain }) => {
  const { t } = useTranslation('view')

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto">
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
        </div>

        <h2 className="mb-2 text-heading font-semibold">{t('form.submitted')}</h2>
        <p className="mb-8 text-body text-muted-foreground">
          {message || t('form.defaultSuccessMessage')}
        </p>

        <div className="flex flex-col gap-3">
          {allowMultiple && (
            <Button variant="outline" size="form" className="w-full" onClick={onFillAgain}>
              {t('form.submitAnother')}
            </Button>
          )}
          {redirectUrl && (
            <Button
              variant="secondary"
              size="form"
              className="w-full gap-1.5"
              onClick={() => window.open(redirectUrl, '_blank')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('form.goToRedirect')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Password gate (for password-protected forms)
// ---------------------------------------------------------------------------

const PasswordGate: React.FC<{
  title: string
  shareId: string
  onVerified: (password: string, formMeta?: Record<string, unknown>) => void
}> = ({ title, shareId, onVerified }) => {
  const { t } = useTranslation('view')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)

  const handleVerify = async () => {
    if (!password.trim()) {
      setError(t('form.passwordRequired', '请输入密码'))
      return
    }
    setVerifying(true)
    setError('')
    const result = await verifyFormPassword(shareId, password)
    setVerifying(false)
    if (result.ok) {
      onVerified(password, result.formMeta)
    } else {
      setError(result.error || t('form.passwordIncorrect', '密码错误'))
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto">
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Lock className="h-8 w-8 text-muted-foreground" />
        </div>
        <h2 className="mb-2 text-heading font-semibold">{title}</h2>
        <p className="mb-6 text-body text-muted-foreground">
          {t('form.passwordProtectedHint', '此表单需要密码才能访问')}
        </p>
        <div className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError('') }}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && void handleVerify()}
            placeholder={t('form.enterPassword', '请输入访问密码')}
            className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-body outline-none focus:ring-2 focus:ring-ring"
          />
          {error && <p className="text-caption text-destructive">{error}</p>}
          <Button size="form" className="w-full" onClick={() => void handleVerify()} disabled={verifying}>
            {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('form.verifyPassword', '验证密码')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FormPreviewer
// ---------------------------------------------------------------------------

export interface FormPreviewerProps {
  ctrl: FormViewControllerResult
  className?: string
  /** 公开分享场景的 shareId（已知时直接传入，无需 ensureShareId 创建） */
  shareId?: string
  /** 密码保护表单的密码 */
  formPassword?: string
}

export const FormPreviewer: React.FC<FormPreviewerProps> = ({ ctrl, className, shareId: shareIdProp, formPassword }) => {
  const { t } = useTranslation('view')
  const { currentView, formConfig, formFields, fieldMap } = ctrl

  const viewId = currentView?.id ?? null
  const tableId = currentView?.table_id ?? null

  // ── Organization members (for user / created_by / last_modified_by fields) ──
  // In public share mode, fetch collaborators from API instead of local store
  const wsMembers = useOrganizationStore((s) => s.members)
  const localOrganizationMembers = useMemo(() => toOrganizationMembers(wsMembers), [wsMembers])
  const [shareCollaborators, setShareCollaborators] = useState<WorkspaceMemberInfo[] | null>(null)
  const [shareCollabLoading, setShareCollabLoading] = useState(false)

  const effectiveShareId = shareIdProp || (formConfig as Record<string, unknown>).share_id as string | undefined

  useEffect(() => {
    if (!effectiveShareId) {
      setShareCollaborators(null)
      setShareCollabLoading(false)
      return
    }
    let cancelled = false
    setShareCollabLoading(true)
    fetchShareCollaborators(effectiveShareId, formPassword ?? null).then(result => {
      if (cancelled) return
      setShareCollabLoading(false)
      if (result.error) {
        setShareCollaborators([])
      } else {
        setShareCollaborators(result.data)
      }
    })
    return () => { cancelled = true }
  }, [effectiveShareId, formPassword])

  // In share mode: use API result (empty array while loading to avoid showing wrong local members)
  // In editor mode (no shareId): use local organization store
  const organizationMembers = effectiveShareId
    ? (shareCollabLoading ? [] : shareCollaborators ?? [])
    : localOrganizationMembers

  // ── Current user id (for draft isolation) ──
  const userId = useAuthStore(s => s.user?.id ?? null)
  const isAuthenticated = useAuthStore(selectIsAuthenticated)

  // ── Form values state ──
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submittedResult, setSubmittedResult] = useState<{
    message: string
    redirect_url: string
  } | null>(null)

  const shareIdRef = useRef<string | null>(shareIdProp ?? null)
  if (shareIdProp && shareIdRef.current !== shareIdProp) {
    shareIdRef.current = shareIdProp
  }
  const draftWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Password protection ──
  const [localPassword, setLocalPassword] = useState<string | null>(formPassword ?? null)
  const localPasswordRef = useRef<string | null>(formPassword ?? null)
  localPasswordRef.current = localPassword
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [verifiedFormMeta, setVerifiedFormMeta] = useState<Record<string, unknown> | null>(null)

  const hasPasswordFromConfig = Boolean((formConfig as Record<string, unknown>).has_password)
  const shareIdFromConfig = (formConfig as Record<string, unknown>).share_id as string | undefined

  const effectiveFormFields = useMemo<FormFieldMeta[]>(() => {
    if (verifiedFormMeta?.fields) {
      return (verifiedFormMeta.fields as Array<Record<string, unknown>>).map(f => ({
        id: String(f.id),
        name: String(f.name ?? ''),
        field_type: String(f.field_type ?? 'text'),
        config: (f.config ?? {}) as Record<string, unknown>,
        description: String(f.description ?? ''),
        default_value: normalizeFieldDefaultValue(f.default_value),
      }))
    }
    return formFields
  }, [verifiedFormMeta, formFields])

  const effectiveFormConfig = useMemo((): typeof formConfig => {
    if (!verifiedFormMeta) return formConfig
    return { ...formConfig, ...verifiedFormMeta } as typeof formConfig
  }, [verifiedFormMeta, formConfig])

  const loginRequired = Boolean(effectiveFormConfig.login_required)
  const isPublicShare = Boolean(effectiveShareId)
  const formCreatorId = resolveFormCreatorId({
    currentUserId: userId,
    isAuthenticated,
    isPublicShare,
    loginRequired,
  })

  const resolveFieldDefault = useCallback((raw: unknown, fieldType?: string): unknown => {
    if (!raw || typeof raw !== 'object') return undefined
    const spec = raw as { mode?: string; value?: unknown }
    if (spec.mode === 'literal') return spec.value
    if (spec.mode === 'created_time' || spec.mode === 'last_modified_time') {
      const now = new Date().toISOString()
      return now
    }
    if (spec.mode === 'creator' && formCreatorId) return formCreatorId
    return undefined
  }, [formCreatorId])

  // ── Draft key ──
  const draftKey = useMemo(
    () => (tableId && viewId ? getDraftKey({ tableId, viewId, userId, namespace: 'editor' }) : null),
    [tableId, viewId, userId],
  )

  // ── Initialize default values + restore draft ──
  useEffect(() => {
    const defaults: Record<string, unknown> = {}
    for (const field of effectiveFormFields) {
      const value = resolveFieldDefault(field.default_value, field.field_type)
      if (value !== undefined) defaults[field.id] = value
    }

    if (draftKey) {
      const draft = readDraft(draftKey)
      if (draft) {
        setFormValues({ ...defaults, ...draft })
        toast.info(t('form.draftRestored'))
        return
      }
    }

    setFormValues(defaults)
  // Re-initialize when the view or trusted actor changes, not on every formFields reference change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, draftKey, verifiedFormMeta, formCreatorId])

  // ── Persist draft on value change (debounced) ──
  useEffect(() => {
    if (!draftKey) return
    if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current)
    draftWriteTimerRef.current = setTimeout(() => {
      writeDraft(draftKey, formValues)
    }, 500)
    return () => {
      if (draftWriteTimerRef.current) clearTimeout(draftWriteTimerRef.current)
    }
  }, [formValues, draftKey])

  // ── Field value change handler ──
  const handleFieldChange = useCallback((fieldId: string, value: unknown) => {
    setFormValues(prev => ({ ...prev, [fieldId]: value }))
    setErrors(prev => {
      if (!prev[fieldId]) return prev
      const next = { ...prev }
      delete next[fieldId]
      return next
    })
  }, [])

  // ── Field extra accessor ──
  const formValuesRef = useRef(formValues)
  formValuesRef.current = formValues
  const getFieldExtra = useCallback((key: string) => formValuesRef.current[key], [])

  // ── Submit ──
  const handleSubmit = useCallback(async () => {
    if (!viewId || isSubmitting) return

    const validationErrors = validateFormValues(effectiveFormFields, formValues)
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      const firstErrorId = effectiveFormFields.find(f => validationErrors[f.id])?.id
      if (firstErrorId) {
        document.getElementById(`form-field-${firstErrorId}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
      }
      return
    }

    setIsSubmitting(true)
    try {
      // formValues only contains defaults and fields the user interacted with. Keep explicit
      // empty values so the server can distinguish "cleared" from "missing" and does not
      // re-apply a field default after the user clears it.
      const submitValues = buildSubmitValues(formValues, effectiveFormFields)

      let result: { message: string; redirect_url: string; staleShare?: boolean }

      const useDirectSubmit = isAuthenticated && tableId && !effectiveShareId
      if (useDirectSubmit) {
        result = await submitFormDirect(tableId, viewId, submitValues)
      } else {
        if (!shareIdRef.current) {
          const { shareId, hasPassword } = await ensureShareId(viewId)
          shareIdRef.current = shareId
          if (hasPassword && !localPasswordRef.current) {
            setPasswordRequired(true)
            setIsSubmitting(false)
            return
          }
        }

        const accessToken = loginRequired ? useAuthStore.getState().accessToken : undefined
        result = await submitForm(
          shareIdRef.current,
          submitValues,
          localPasswordRef.current || undefined,
          accessToken,
        )

        if (result.staleShare) {
          const { shareId } = await ensureShareId(viewId)
          shareIdRef.current = shareId
          result = await submitForm(
            shareIdRef.current,
            submitValues,
            localPasswordRef.current || undefined,
            accessToken,
          )
          if (result.staleShare) {
            throw new Error(t('form.submitFailed'))
          }
        }
      }

      if (draftKey) clearDraft(draftKey)
      setSubmittedResult({
        message: result.message || effectiveFormConfig.success_message || t('form.defaultSuccessMessage'),
        redirect_url: result.redirect_url || effectiveFormConfig.redirect_url || '',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'SUBMIT_TIMEOUT') {
        toast.error(t('form.submitTimeout'))
      } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
        toast.error(t('form.networkError'))
      } else {
        toast.error(msg || t('form.submitFailed'))
      }
    } finally {
      setIsSubmitting(false)
    }
  }, [viewId, tableId, isSubmitting, isAuthenticated, effectiveShareId, effectiveFormFields, formValues, draftKey, effectiveFormConfig, loginRequired, t])

  // ── Fill again (reset form) ──
  const handleFillAgain = useCallback(() => {
    if (draftKey) clearDraft(draftKey)
    if (draftWriteTimerRef.current) {
      clearTimeout(draftWriteTimerRef.current)
      draftWriteTimerRef.current = null
    }
    setSubmittedResult(null)
    setErrors({})
    const defaults: Record<string, unknown> = {}
    for (const field of effectiveFormFields) {
      const value = resolveFieldDefault(field.default_value, field.field_type)
      if (value !== undefined) defaults[field.id] = value
    }
    setFormValues(defaults)
  }, [effectiveFormFields, draftKey, resolveFieldDefault])

  // ── Link field editing ──
  const [linkEditState, setLinkEditState] = useState<{
    fieldId: string
    fieldName: string
    currentValue: Array<{ id: string; title?: string }>
  } | null>(null)

  const handleLinkEdit = useCallback((fieldId: string, fieldName: string, currentValue: unknown) => {
    const normalized: Array<{ id: string; title?: string }> = Array.isArray(currentValue)
      ? currentValue
      : currentValue
        ? [currentValue as { id: string; title?: string }]
        : []
    setLinkEditState({ fieldId, fieldName, currentValue: normalized })
  }, [])

  const handleLinkSave = useCallback((fieldId: string, newValue: unknown) => {
    handleFieldChange(fieldId, newValue)
    setLinkEditState(null)
  }, [handleFieldChange])

  // ── Derived ──
  const title = effectiveFormConfig.title || currentView?.name || t('form.untitledForm')
  const description = effectiveFormConfig.description ?? ''
  const submitLabel = effectiveFormConfig.submit_label || t('form.defaultSubmitLabel')

  // ── Success view ──
  if (submittedResult) {
    return (
      <SuccessView
        message={submittedResult.message}
        redirectUrl={submittedResult.redirect_url}
        allowMultiple={effectiveFormConfig.allow_multiple_submit !== false}
        onFillAgain={handleFillAgain}
      />
    )
  }

  // ── Password gate ──
  const needsPassword = (hasPasswordFromConfig || passwordRequired) && localPassword === null
  if (needsPassword) {
    const gateShareId = shareIdRef.current || shareIdFromConfig || ''
    if (gateShareId) {
      return (
        <PasswordGate
          title={title}
          shareId={gateShareId}
          onVerified={(pwd, formMeta) => {
            setLocalPassword(pwd)
            setPasswordRequired(false)
            if (formMeta) setVerifiedFormMeta(formMeta)
          }}
        />
      )
    }
  }

  // ── Login gate (login_required + 未登录) ──
  if (loginRequired && !isAuthenticated) {
    return (
      <div className={cn('flex-1 overflow-auto', className)}>
        <div className="flex min-h-full items-center justify-center">
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Lock className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-heading font-semibold">{t('form.loginRequiredTitle')}</h2>
            <p className="mb-8 text-body text-muted-foreground">
              {t('form.loginRequiredDesc')}
            </p>
            <Button
              className="w-full"
              onClick={() => {
                window.location.hash = '#/login'
              }}
            >
              {t('form.loginRequiredButton')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex-1 overflow-auto', className)}>
      <div className="mx-auto max-w-2xl px-6 py-8">
        {/* Cover image */}
        {effectiveFormConfig.cover_url ? (
          <div className="mb-6 overflow-hidden rounded-xl">
            <img
              src={effectiveFormConfig.cover_url}
              alt=""
              className="h-48 w-full object-cover"
            />
          </div>
        ) : (
          <div className="mb-6 h-36 w-full rounded-xl bg-gradient-to-tr from-green-400 via-teal-400 to-cyan-500" />
        )}

        {/* Logo + Title + Description */}
        <div className="mb-8">
          {effectiveFormConfig.logo_url && (
            <div className="mb-3">
              <img
                src={effectiveFormConfig.logo_url}
                alt=""
                className="h-12 w-12 rounded-lg object-cover"
              />
            </div>
          )}
          <div className="flex items-center gap-3 mb-2">
            <ClipboardList className="h-6 w-6 text-primary" />
            <h1 className="text-heading font-semibold">{title}</h1>
          </div>
          {description && (
            <p className="text-body text-muted-foreground mt-1">{description}</p>
          )}
        </div>

        {/* Form fields */}
        <div className="space-y-6">
          {effectiveFormFields.map(field => {
            const errCode = errors[field.id]
            let errMsg: string | undefined
            if (errCode === 'invalidEmail') errMsg = t('form.invalidEmail', '请输入有效的邮箱地址')
            else if (errCode === 'invalidUrl') errMsg = t('form.invalidUrl', '请输入有效的网址')
            else if (errCode === 'invalidPhone') errMsg = t('form.invalidPhone', '请输入有效的电话号码')
            else if (errCode === 'invalidNumber') errMsg = t('form.invalidNumber', '请输入有效的数字')
            else if (errCode) errMsg = errCode

            return (
              <div key={field.id} id={`form-field-${field.id}`}>
                <FormField
                  field={field}
                  fieldDef={fieldMap.get(field.id)}
                  value={formValues[field.id]}
                  onChange={handleFieldChange}
                  error={errMsg}
                  disabled={isSubmitting}
                  organizationMembers={organizationMembers}
                  getFieldExtra={getFieldExtra}
                  onLinkEdit={handleLinkEdit}
                />
              </div>
            )
          })}
        </div>

        {/* Submit button */}
        <div className="mt-8">
          <Button
            className="w-full"
            size="lg"
            disabled={isSubmitting}
            onClick={() => void handleSubmit()}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('form.submitting')}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      </div>

      {/* Link field picker dialog */}
      {linkEditState && tableId && (
        <FormLinkPicker
          open
          onClose={() => setLinkEditState(null)}
          tableId={tableId}
          fieldId={linkEditState.fieldId}
          fieldName={linkEditState.fieldName}
          currentValue={linkEditState.currentValue}
          onSave={(val) => handleLinkSave(linkEditState.fieldId, val)}
          shareId={shareIdRef.current ?? undefined}
          formPassword={localPasswordRef.current || formPassword}
          multiple={(() => {
            const def = fieldMap.get(linkEditState.fieldId)
            if (!def) {
              console.warn(
                `[FormPreviewer] fieldDef missing for link field "${linkEditState.fieldName}" (${linkEditState.fieldId}), defaulting to single-select`,
              )
              return false
            }
            const rel = (def.options as Record<string, unknown> | undefined)?.relationship as string | undefined
            return rel !== 'OneOne' && rel !== 'ManyOne'
          })()}
        />
      )}
    </div>
  )
}
