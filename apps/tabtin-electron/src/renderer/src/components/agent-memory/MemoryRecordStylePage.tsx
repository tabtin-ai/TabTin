/**
 * MemoryRecordStylePage —— 组织服务中的「记忆偏好」设置。
 *
 * 承载记录风格、额外偏好与用户画像，可独立显示或嵌入组织服务设置。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Switch, toast, ConfirmDialog } from '@tabtin/smartsheet-ui'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import {
  RecordStyleApi,
  type RecordStyleConfig,
  type RecordStyleKind,
  type RecordStyleCustomConfig,
  type RecordDensity,
  type RecordDepth,
  type RecordTone,
  type RecordFocus,
} from '@/services/recordStyleApi'
import { cn } from '@utils/cn'
import { UserPortraitPanel } from '@components/space-settings/UserPortraitPanel'

interface StyleOption {
  kind: RecordStyleKind
  label: string
  desc: string
  example: string
  isDefault?: boolean
  recommended?: boolean
}

const STYLE_OPTIONS: StyleOption[] = [
  {
    kind: 'faithful',
    label: '忠实记录',
    desc: '记过程、结果、踩坑，偏客观',
    example: '梳理季度计划：定下先做 A、暂缓 B，按手头资源排了优先级。',
    isDefault: true,
  },
  {
    kind: 'minimal',
    label: '极简',
    desc: '惜字如金，只留结论',
    example: '季度计划：先做 A，暂缓 B。',
  },
  {
    kind: 'companion',
    label: '洞察伙伴',
    desc: '记判断与觉察，第一人称',
    example: '你犹豫后还是选了先做 A——你更看重尽快见到效果，下次我先帮你理出最快能落地的那条路。',
    recommended: true,
  },
  { kind: 'custom', label: '自定义', desc: '自己调记录维度', example: '' },
]

const VISIBLE_STYLE_OPTIONS = STYLE_OPTIONS.filter(opt => opt.kind !== 'custom')

const DENSITY_OPTIONS: { v: RecordDensity; l: string }[] = [
  { v: 'concise', l: '精简' },
  { v: 'moderate', l: '适中' },
  { v: 'detailed', l: '详尽' },
]
const DEPTH_OPTIONS: { v: RecordDepth; l: string }[] = [
  { v: 'facts_only', l: '只记事实' },
  { v: 'with_judgment', l: '也记判断' },
]
const TONE_OPTIONS: { v: RecordTone; l: string }[] = [
  { v: 'objective', l: '客观' },
  { v: 'natural', l: '自然' },
  { v: 'warm', l: '有温度' },
]
const FOCUS_OPTIONS: { v: RecordFocus; l: string }[] = [
  { v: 'outcome', l: '任务结果' },
  { v: 'method', l: '方法经验' },
  { v: 'about_user', l: '对你的理解' },
  { v: 'emotion', l: '情绪状态' },
]

const EXTRA_PREF_MAX = 1000

const PRESET_EQUIVALENT: Record<Exclude<RecordStyleKind, 'custom'>, RecordStyleCustomConfig> = {
  faithful: { density: 'moderate', depth: 'facts_only', tone: 'objective', focus: ['outcome', 'method'] },
  minimal: { density: 'concise', depth: 'facts_only', tone: 'objective', focus: ['outcome'] },
  companion: { density: 'moderate', depth: 'with_judgment', tone: 'warm', focus: ['about_user', 'method', 'outcome'] },
}

function isCustomEmpty(c?: RecordStyleCustomConfig): boolean {
  if (!c) return true
  return !c.density && !c.depth && !c.tone && (!c.focus || c.focus.length === 0)
}

function serializeCfg(c: RecordStyleConfig): string {
  return JSON.stringify({
    enabled: c.enabled,
    style: c.style,
    density: c.custom_config?.density ?? null,
    depth: c.custom_config?.depth ?? null,
    tone: c.custom_config?.tone ?? null,
    focus: [...(c.custom_config?.focus ?? [])].sort(),
    extra: c.extra_preference ?? '',
  })
}

function Segmented<T extends string>(props: {
  value: T | undefined
  options: { v: T; l: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}): React.ReactElement {
  const { value, options, onChange, disabled } = props
  return (
    <div className="inline-flex rounded-md border border-border/40 overflow-hidden">
      {options.map(opt => (
        <button
          key={opt.v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.v)}
          className={cn(
            'px-3 py-1.5 text-caption transition-colors',
            value === opt.v
              ? 'bg-accent/15 text-accent'
              : 'text-muted-foreground/80 hover:bg-muted/30',
            disabled && 'opacity-40 cursor-not-allowed',
          )}
        >
          {opt.l}
        </button>
      ))}
    </div>
  )
}

interface MemoryRecordStylePageProps {
  embedded?: boolean
}

export const MemoryRecordStylePage: React.FC<MemoryRecordStylePageProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation('agentMemory')
  const organizationId = useOrganizationStore(s => s.selectedOrganization?.id) ?? ''
  const organizationName = useOrganizationStore(s => s.selectedOrganization?.name) ?? ''

  const [cfg, setCfg] = useState<RecordStyleConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)

  const baselineRef = useRef<string>('')
  const reqIdRef = useRef(0)

  const loadCfg = useCallback(() => {
    if (!organizationId) return
    const myReq = ++reqIdRef.current
    setLoading(true)
    setError(false)
    RecordStyleApi.getRecordStyle(organizationId)
      .then(res => {
        if (reqIdRef.current !== myReq) return
        setCfg(res)
        baselineRef.current = serializeCfg(res)
      })
      .catch(() => {
        if (reqIdRef.current !== myReq) return
        setError(true)
      })
      .finally(() => {
        if (reqIdRef.current === myReq) setLoading(false)
      })
  }, [organizationId])

  useEffect(() => {
    if (!organizationId) return
    loadCfg()
  }, [organizationId, loadCfg])

  const patchCfg = useCallback((patch: Partial<RecordStyleConfig>) => {
    setCfg(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const patchCustom = useCallback((patch: Partial<RecordStyleCustomConfig>) => {
    setCfg(prev =>
      prev ? { ...prev, custom_config: { ...prev.custom_config, ...patch } } : prev,
    )
  }, [])

  const toggleFocus = useCallback((f: RecordFocus) => {
    setCfg(prev => {
      if (!prev) return prev
      const cur = prev.custom_config.focus ?? []
      const next = cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f]
      return { ...prev, custom_config: { ...prev.custom_config, focus: next } }
    })
  }, [])

  const selectStyle = useCallback((kind: RecordStyleKind) => {
    setCfg(prev => {
      if (!prev) return prev
      if (kind !== 'custom') return { ...prev, style: kind }
      const basePreset = prev.style !== 'custom' ? prev.style : 'faithful'
      const nextCustom = isCustomEmpty(prev.custom_config)
        ? { ...PRESET_EQUIVALENT[basePreset] }
        : prev.custom_config
      return { ...prev, style: 'custom', custom_config: nextCustom }
    })
  }, [])

  const handleToggleEnabled = useCallback((v: boolean) => {
    if (v) patchCfg({ enabled: true })
    else setConfirmDisable(true)
  }, [patchCfg])

  const handleSave = useCallback(async () => {
    if (!cfg || !organizationId) return
    setSaving(true)
    try {
      const saved = await RecordStyleApi.updateRecordStyle(organizationId, {
        enabled: cfg.enabled,
        style: cfg.style,
        custom_config: cfg.custom_config,
        extra_preference: cfg.extra_preference,
      })
      setCfg(saved)
      baselineRef.current = serializeCfg(saved)
      useMemoRecordStyleStore.getState().setEnabled(organizationId, saved.enabled)
      toast({ description: t('recordStyle.saved', { defaultValue: '已保存' }) })
    } catch {
      toast({
        variant: 'destructive',
        description: t('recordStyle.saveFailed', { defaultValue: '保存失败，请重试' }),
      })
    } finally {
      setSaving(false)
    }
  }, [cfg, organizationId, t])

  const enabled = cfg?.enabled ?? true
  const custom = cfg?.custom_config ?? {}
  const densityOptions = DENSITY_OPTIONS.map(o => ({ v: o.v, l: t(`recordStyle.densityOptions.${o.v}`, { defaultValue: o.l }) }))
  const depthOptions = DEPTH_OPTIONS.map(o => ({ v: o.v, l: t(`recordStyle.depthOptions.${o.v}`, { defaultValue: o.l }) }))
  const toneOptions = TONE_OPTIONS.map(o => ({ v: o.v, l: t(`recordStyle.toneOptions.${o.v}`, { defaultValue: o.l }) }))
  const focusOptions = FOCUS_OPTIONS.map(o => ({ v: o.v, l: t(`recordStyle.focusOptions.${o.v}`, { defaultValue: o.l }) }))
  const customEmpty = enabled && !!cfg && cfg.style === 'custom' && isCustomEmpty(cfg.custom_config)
  const canSave = !!cfg && !loading && !saving && !error && !customEmpty
  const isDirty = !!cfg && serializeCfg(cfg) !== baselineRef.current
  const showTrustNote =
    enabled &&
    !!cfg &&
    (cfg.style === 'companion' ||
      (cfg.style === 'custom' &&
        (custom.depth === 'with_judgment' || (custom.focus ?? []).includes('about_user'))))

  return (
    <div className={cn('w-full bg-background', embedded ? '' : 'h-full overflow-y-auto')}>
      <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-6', embedded ? '' : 'px-6 py-6')}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-accent" />
              <h1 className="text-title font-medium text-foreground">
                {t('recordStyle.title', { defaultValue: '记忆偏好' })}
              </h1>
            </div>
            <p className="mt-1 text-body text-muted-foreground/80">
              {t('recordStyle.scopeHint', {
                defaultValue:
                  '设置你的 Agent 怎么帮你记笔记。对你在「{{name}}」下的所有 Agent 生效——每个组织各一套，切换组织互不影响。',
                name: organizationName || '当前组织',
              })}
            </p>
          </div>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {isDirty
              ? t('recordStyle.save', { defaultValue: '保存' })
              : t('recordStyle.savedState', { defaultValue: '已保存' })}
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-xl border border-border/30 py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/30 py-16 text-center">
            <p className="text-body text-muted-foreground/80">
              {t('recordStyle.loadFailed', { defaultValue: '加载记忆偏好失败' })}
            </p>
            <Button variant="outline" size="sm" onClick={loadCfg}>
              {t('recordStyle.retry', { defaultValue: '重试' })}
            </Button>
          </div>
        ) : cfg ? (
          <div className="flex flex-col gap-6">
            <section className="rounded-xl border border-border/30 bg-card/30 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-body text-foreground">
                    {t('recordStyle.enableLabel', { defaultValue: '让 Agent 记笔记' })}
                  </div>
                  <div className="text-caption text-muted-foreground/60 mt-0.5">
                    {t('recordStyle.enableHint', {
                      defaultValue: '关闭后，你的 Agent 不再把对话蒸馏成笔记',
                    })}
                  </div>
                </div>
                <Switch checked={enabled} onCheckedChange={handleToggleEnabled} />
              </div>
            </section>

            <section className={cn('flex flex-col gap-3', !enabled && 'opacity-40 pointer-events-none')}>
              <div className="text-caption font-medium text-muted-foreground/80">
                {t('recordStyle.styleLabel', { defaultValue: '记录风格' })}
              </div>
              {VISIBLE_STYLE_OPTIONS.map(opt => {
                const active = cfg.style === opt.kind
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    onClick={() => selectStyle(opt.kind)}
                    className={cn(
                      'text-left rounded-xl border p-4 transition-colors',
                      active ? 'border-accent/60 bg-accent/5' : 'border-border/40 hover:border-accent/30',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-body text-foreground">
                        {t(`recordStyle.styleOptions.${opt.kind}.label`, { defaultValue: opt.label })}
                      </span>
                      {opt.isDefault && (
                        <span className="text-caption px-1.5 py-0.5 rounded-full bg-muted/40 text-muted-foreground/60">
                          {t('recordStyle.badgeDefault', { defaultValue: '默认' })}
                        </span>
                      )}
                      {opt.recommended && (
                        <span className="text-caption px-1.5 py-0.5 rounded-full bg-accent/15 text-accent">
                          {t('recordStyle.badgeRecommended', { defaultValue: '推荐' })}
                        </span>
                      )}
                    </div>
                    <div className="text-caption text-muted-foreground/60 mt-0.5">
                      {t(`recordStyle.styleOptions.${opt.kind}.desc`, { defaultValue: opt.desc })}
                    </div>
                    {opt.example && (
                      <div className="text-caption text-muted-foreground/40 mt-1 italic">
                        「{t(`recordStyle.styleOptions.${opt.kind}.example`, { defaultValue: opt.example })}」
                      </div>
                    )}
                  </button>
                )
              })}
            </section>

            {showTrustNote && (
              <div className="flex gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                <ShieldCheck className="h-4 w-4 text-amber-500/80 shrink-0 mt-0.5" />
                <p className="text-caption text-muted-foreground/80 leading-relaxed">
                  {t('recordStyle.trustNote', {
                    defaultValue:
                      '开启后，Agent 会把对你的判断与推测写成长期笔记，而不只是记事实。这些笔记记在你名下、跟着当前组织走（换组织是另一套、互不可见），默认只有你能看到；它们是 Agent 的主观推测、未必准确，你可以在「Agent 的记忆」里查看，不需要的随时删掉。',
                  })}
                </p>
              </div>
            )}

            {enabled && cfg.style === 'custom' && (
              <section className="flex flex-col gap-3 rounded-xl bg-muted/10 p-4">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-caption text-muted-foreground/80">
                    {t('recordStyle.density', { defaultValue: '记录密度' })}
                  </span>
                  <Segmented<RecordDensity> value={custom.density} options={densityOptions} onChange={v => patchCustom({ density: v })} />
                </div>
                <div className="flex items-start justify-between gap-3">
                  <span className="text-caption text-muted-foreground/80">
                    {t('recordStyle.depth', { defaultValue: '记录深度' })}
                  </span>
                  <Segmented<RecordDepth> value={custom.depth} options={depthOptions} onChange={v => patchCustom({ depth: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-caption text-muted-foreground/80">
                    {t('recordStyle.tone', { defaultValue: '口吻' })}
                  </span>
                  <Segmented<RecordTone> value={custom.tone} options={toneOptions} onChange={v => patchCustom({ tone: v })} />
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-caption text-muted-foreground/80">
                    {t('recordStyle.focus', { defaultValue: '关注侧重（可多选）' })}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {focusOptions.map(opt => {
                      const active = (custom.focus ?? []).includes(opt.v)
                      return (
                        <button
                          key={opt.v}
                          type="button"
                          onClick={() => toggleFocus(opt.v)}
                          className={cn(
                            'px-2.5 py-1 rounded-full text-caption transition-colors',
                            active ? 'bg-accent/15 text-accent' : 'bg-muted/30 text-muted-foreground/80 hover:bg-muted/60',
                          )}
                        >
                          {opt.l}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {customEmpty && (
                  <p className="text-caption text-amber-500">
                    {t('recordStyle.customEmptyHint', { defaultValue: '至少选一项，否则跟「忠实记录」没区别' })}
                  </p>
                )}
              </section>
            )}

            {enabled && (
              <section className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-muted-foreground/80">
                  {t('recordStyle.extraLabel', { defaultValue: '额外偏好（可选）' })}
                </span>
                <textarea
                  value={cfg.extra_preference}
                  maxLength={EXTRA_PREF_MAX}
                  onChange={e => patchCfg({ extra_preference: e.target.value })}
                  placeholder={t('recordStyle.extraPlaceholder', {
                    defaultValue:
                      '例如：\n· 别记技术细节，多关注我的决策习惯\n· 每条尽量短，一句话讲清\n· 多留意我提到的人名、书名和待办',
                  })}
                  className="min-h-[96px] resize-y rounded-md border border-border/40 bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-accent/60"
                />
              </section>
            )}

            {enabled && (
              <section className="flex flex-col gap-2 border-t border-border/20 pt-5">
                <span className="text-caption font-medium text-muted-foreground/80">
                  {t('recordStyle.portraitLabel', { defaultValue: '关于你（Agent 对你的理解）' })}
                </span>
                <UserPortraitPanel
                  enabled={enabled}
                  canManage
                  organizationId={organizationId}
                />
              </section>
            )}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t('recordStyle.disableTitle', { defaultValue: '关闭后 Agent 不再记笔记？' })}
        description={t('recordStyle.disableDesc', {
          defaultValue:
            '关掉后，今后的对话不会再被整理成笔记；已经记下的笔记会保留，随时可以重新打开。',
        })}
        confirmText={t('recordStyle.disableConfirm', { defaultValue: '关闭' })}
        cancelText={t('recordStyle.disableCancel', { defaultValue: '先不关' })}
        onConfirm={() => patchCfg({ enabled: false })}
      />
    </div>
  )
}

export default MemoryRecordStylePage
