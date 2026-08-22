/**
 * OrganizationNotificationsPanel —— 团队通知规则（Extension EventBus → 通知 的映射规则）
 *
 * 2026-05 治理后只保留 admin 工作流相关的"通知规则 CRUD"：
 *   - 系统内置规则 seed
 *   - 规则增/改/删/启停
 *   - event_pattern fnmatch + source_extension_id + channels + priority + 模板
 *
 * 通知偏好（桌面横幅 / Dock 角标 / 声音 / 免打扰 / 分类开关）已搬到
 *   「个人 → 偏好 → 通知」，账号级单值。本面板不再展示这些控件。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Label,
  StatusNotice,
} from '@tabtin/smartsheet-ui'
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@components/ui'
import { useTranslation } from 'react-i18next'
import type { Organization } from '@tabtin/app-shell'
import {
  listNotificationRules,
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  seedNotificationRules,
  type NotificationRule,
  type PayloadFieldDescriptor,
} from '@/services/extensionApi'
import { useExtensionStore } from '@stores/useExtensionStore'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsBadge, type SettingsBadgeProps } from '../SettingsBadge'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_HOVER_ACTION, SETTINGS_LABEL, SETTINGS_ROW_HOVER, SETTINGS_SELECT_TRIGGER, SETTINGS_SOFT_SURFACE, SETTINGS_TEXTAREA, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { cn } from '@utils/cn'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'

interface Props {
  organization: Organization
  canManageOrganization?: boolean
}

type RuleFormData = {
  event_pattern: string
  source_extension_id: string
  channels: string[]
  priority: string
  category: string
  title_template: string
  body_template: string
  enabled: boolean
}

const emptyForm: RuleFormData = {
  event_pattern: '',
  source_extension_id: '',
  channels: ['in_app'],
  priority: 'normal',
  category: 'general',
  title_template: '',
  body_template: '',
  enabled: true,
}

const BUILTIN_TEMPLATE_VARS: PayloadFieldDescriptor[] = [
  { key: 'event_type', label: '事件类型', type: 'string', example: 'email.received' },
  { key: 'source', label: '来源 Extension', type: 'string', example: 'tabmail' },
  { key: 'organization_id', label: '组织 ID', type: 'string', example: 'ws-123' },
  { key: 'space_id', label: 'Agent 空间 ID', type: 'string', example: 'as-456' },
]

export const OrganizationNotificationsPanel: React.FC<Props> = ({ organization, canManageOrganization = true }) => {
  const { t } = useTranslation(['settings', 'common'])
  const organizationId = organization.id
  const extensions = useExtensionStore((s) => s.extensions)
  const fetchExtensions = useExtensionStore((s) => s.fetchExtensions)

  const priorityLabels: Record<string, { label: string; tone: SettingsBadgeProps['tone'] }> = {
    urgent: { label: t('notifications.priorityUrgent'), tone: 'destructive' },
    high: { label: t('notifications.priorityHigh'), tone: 'warning' },
    normal: { label: t('notifications.priorityNormal'), tone: 'info' },
    low: { label: t('notifications.priorityLow'), tone: 'muted' },
  }

  const channelLabels: Record<string, string> = {
    in_app: t('notifications.inApp'),
    desktop: t('notifications.desktop'),
    email_digest: t('notifications.emailDigest'),
  }

  const channelOptions = [
    { value: 'in_app', label: t('notifications.inApp') },
    { value: 'desktop', label: t('notifications.desktop') },
  ]

  const priorityOptions = [
    { value: 'low', label: t('notifications.priorityLow') },
    { value: 'normal', label: t('notifications.priorityNormal') },
    { value: 'high', label: t('notifications.priorityHigh') },
    { value: 'urgent', label: t('notifications.priorityUrgent') },
  ]

  const [rules, setRules] = useState<NotificationRule[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<NotificationRule | null>(null)
  const [form, setForm] = useState<RuleFormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchRules = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listNotificationRules(organizationId)
      setRules(res.rules)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules')
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void fetchRules()
    if (extensions.length === 0) void fetchExtensions(organizationId)
  }, [fetchRules, extensions.length, fetchExtensions, organizationId])

  const handleSeed = async () => {
    try {
      await seedNotificationRules(organizationId)
      await fetchRules()
    } catch {
      // ignore
    }
  }

  const handleOpenCreate = () => {
    setEditingRule(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const handleOpenEdit = (rule: NotificationRule) => {
    setEditingRule(rule)
    setForm({
      event_pattern: rule.event_pattern,
      source_extension_id: rule.source_extension_id,
      channels: rule.channels,
      priority: rule.priority,
      category: rule.category,
      title_template: rule.title_template,
      body_template: rule.body_template,
      enabled: rule.enabled,
    })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.event_pattern.trim()) return
    setSaving(true)
    try {
      if (editingRule) {
        await updateNotificationRule(organizationId, editingRule.id, form)
      } else {
        await createNotificationRule(organizationId, form)
      }
      setDialogOpen(false)
      await fetchRules()
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (rule: NotificationRule) => {
    try {
      await updateNotificationRule(organizationId, rule.id, { enabled: !rule.enabled })
      await fetchRules()
    } catch {
      // ignore
    }
  }

  const handleDelete = async () => {
    if (!deletingId) return
    await deleteNotificationRule(organizationId, deletingId)
    await fetchRules()
  }

  const availableVars = useMemo((): PayloadFieldDescriptor[] => {
    const pattern = form.event_pattern.trim()
    if (!pattern) return BUILTIN_TEMPLATE_VARS

    const matched: PayloadFieldDescriptor[] = []
    for (const ext of extensions) {
      for (const evt of ext.event_types) {
        if (
          evt.event_type === pattern ||
          _fnmatchLite(evt.event_type, pattern)
        ) {
          for (const pf of evt.payload_fields ?? []) {
            if (!matched.some((m) => m.key === pf.key)) {
              matched.push(pf)
            }
          }
        }
      }
    }
    return [...BUILTIN_TEMPLATE_VARS, ...matched]
  }, [form.event_pattern, extensions])

  const handleChannelToggle = (ch: string) => {
    setForm((f) => ({
      ...f,
      channels: f.channels.includes(ch)
        ? f.channels.filter((c) => c !== ch)
        : [...f.channels, ch],
    }))
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Bell className="h-4 w-4" />}
        title={t('sections.organizationNotifications')}
        subtitle={t('notifications.rulesSubtitle')}
        meta={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={!canManageOrganization} onClick={handleSeed} title={t('notifications.initSystemRules')}>
              <Shield className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void fetchRules()
              }}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
        }
      />

      <StatusNotice
        tone="info"
        description={t('notifications.prefsMovedHint')}
        className="mb-1"
      />

      {error ? <StatusNotice tone="danger" description={error} /> : null}

      <SettingsSectionCard
        icon={<Bell className="h-3.5 w-3.5" />}
        title={t('notifications.rules')}
        subtitle={t('notifications.rulesDesc')}
        actions={
          canManageOrganization && (
            <Button variant="ghost" size="sm" onClick={handleOpenCreate}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )
        }
      >
        {loading && rules.length === 0 ? (
          <div className="py-1">
            <DetailedRowListSkeleton count={4} compact showPreview={false} />
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            icon={<Bell className="h-4 w-4" />}
            title={t('notifications.noRules')}
            description={t('notifications.rulesDesc')}
            layout="card"
            size="sm"
            action={
              <Button variant="outline" size="sm" disabled={!canManageOrganization} onClick={handleSeed}>
                <Shield className="mr-2 h-[1em] w-[1em]" />
                {t('notifications.seedRules')}
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => {
              const p = priorityLabels[rule.priority] ?? priorityLabels.normal
              return (
                <div
                  key={rule.id}
                  className={cn(
                    'flex items-center justify-between gap-3 px-3 py-2',
                    SETTINGS_SOFT_SURFACE,
                    SETTINGS_ROW_HOVER,
                    !rule.enabled && 'opacity-40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-mono font-medium truncate">{rule.event_pattern}</span>
                      <SettingsBadge tone={p.tone}>{p.label}</SettingsBadge>
                      {rule.is_system && (
                        <SettingsBadge tone="muted">{t('notifications.systemRule')}</SettingsBadge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={SETTINGS_HINT}>
                        {t('notifications.channelsLabel')}: {rule.channels.map((c) => channelLabels[c] || c).join(', ')}
                      </span>
                      {rule.source_extension_id && (
                        <span className={SETTINGS_HINT}>
                          {t('notifications.sourceLabel')}: {rule.source_extension_id}
                        </span>
                      )}
                    </div>
                    {rule.title_template && (
                      <p className={cn(SETTINGS_HINT, 'mt-0.5 truncate')}>
                        {t('notifications.templateLabel')}: {rule.title_template}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="ghost" size="sm" disabled={!canManageOrganization} onClick={() => handleOpenEdit(rule)}>
                      <Edit className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!canManageOrganization} onClick={() => handleToggle(rule)}>
                      {rule.enabled
                        ? <Power className="h-3.5 w-3.5 text-success" />
                        : <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />
                      }
                    </Button>
                    {!rule.is_system && (
                      <Button variant="ghost" size="sm" disabled={!canManageOrganization} onClick={() => setDeletingId(rule.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSectionCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingRule ? t('notifications.editRule') : t('notifications.createRule')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className={SETTINGS_LABEL}>{t('notifications.eventPattern')}</Label>
              <Input
                value={form.event_pattern}
                onChange={(e) => setForm((f) => ({ ...f, event_pattern: e.target.value }))}
                placeholder={t('notifications.eventPatternPlaceholder')}
                className={cn('mt-1', SETTINGS_CONTROL)}
              />
              <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
                {t('notifications.fnmatchHelp')}
              </p>
            </div>

            <div>
              <Label className={SETTINGS_LABEL}>{t('notifications.sourceExtension')}</Label>
              <Input
                value={form.source_extension_id}
                onChange={(e) => setForm((f) => ({ ...f, source_extension_id: e.target.value }))}
                placeholder={t('notifications.sourceAllPlaceholder')}
                className={cn('mt-1', SETTINGS_CONTROL)}
              />
            </div>

            <div>
              <Label className={SETTINGS_LABEL}>{t('notifications.channels')}</Label>
              <div className="flex gap-2 mt-1">
                {channelOptions.map((ch) => (
                  <button
                    key={ch.value}
                    type="button"
                    onClick={() => handleChannelToggle(ch.value)}
                    className={cn(
                      'text-body px-3 py-2 rounded-interactive transition-colors',
                      form.channels.includes(ch.value)
                        ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-accent-text'
                        : 'text-muted-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                    )}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className={SETTINGS_LABEL}>{t('notifications.priority')}</Label>
                <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v }))}>
                  <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'mt-1')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {priorityOptions.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className={SETTINGS_LABEL}>{t('notifications.category')}</Label>
                <Input
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  placeholder="general"
                  className={cn('mt-1', SETTINGS_CONTROL)}
                />
              </div>
            </div>

            <div>
              <Label className={SETTINGS_LABEL}>{t('notifications.titleTemplate')}</Label>
              <Input
                value={form.title_template}
                onChange={(e) => setForm((f) => ({ ...f, title_template: e.target.value }))}
                placeholder={t('notifications.titleTemplatePlaceholder')}
                className={cn('mt-1', SETTINGS_CONTROL)}
              />
            </div>

            <div>
              <Label className={SETTINGS_LABEL}>{t('notifications.bodyTemplate')}</Label>
              <Textarea
                value={form.body_template}
                onChange={(e) => setForm((f) => ({ ...f, body_template: e.target.value }))}
                placeholder={t('notifications.bodyPlaceholder')}
                className={cn('mt-1', SETTINGS_TEXTAREA)}
                rows={2}
              />
            </div>

            <TemplateVarsPanel vars={availableVars} />

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
                {t('notifications.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !form.event_pattern.trim() || !canManageOrganization}
              >
                {saving ? <Loader2 className="h-[1em] w-[1em] animate-spin mr-1" /> : null}
                {editingRule ? t('notifications.save') : t('notifications.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deletingId}
        onOpenChange={(open) => !open && setDeletingId(null)}
        title={t('notifications.deleteRuleTitle')}
        description={t('notifications.deleteRuleDesc')}
        onConfirm={handleDelete}
        variant="destructive"
      />
    </SettingsPanelLayout>
  )
}

function TemplateVarsPanel({ vars }: { vars: PayloadFieldDescriptor[] }) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useTranslation(['settings'])

  if (vars.length === 0) return null

  return (
    <div className={cn(SETTINGS_SOFT_SURFACE, 'px-3 py-2')}>
      <button
        type="button"
        className="flex items-center gap-2 text-body font-medium text-foreground-secondary w-full"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-[1em] w-[1em]" /> : <ChevronRight className="h-[1em] w-[1em]" />}
        {t('notifications.availableVars', { defaultValue: '可用模板变量' })}
        <span className={cn(SETTINGS_HINT, 'ml-auto')}>{vars.length}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {vars.map((v) => (
            <div
              key={v.key}
              className={cn(SETTINGS_TEXT_MICRO, 'flex items-center gap-2 group')}
            >
              <code
                className="px-2 py-0.5 rounded bg-muted/30 font-mono text-primary-text cursor-pointer hover:bg-foreground/[0.06] transition-colors"
                title={t('notifications.clickToCopy', { defaultValue: '点击复制' })}
                onClick={() => void navigator.clipboard.writeText(`{${v.key}}`)}
              >
                {`{${v.key}}`}
              </code>
              <span className="text-foreground-secondary truncate">{v.label}</span>
              {v.example && (
                <span className="text-muted-foreground/60 truncate ml-auto">{v.example}</span>
              )}
              <Copy
                className={cn(SETTINGS_HOVER_ACTION, 'h-3.5 w-3.5 text-muted-foreground/60 cursor-pointer shrink-0')}
                onClick={() => void navigator.clipboard.writeText(`{${v.key}}`)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function _fnmatchLite(eventType: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${regex}$`).test(eventType)
  } catch {
    return false
  }
}
