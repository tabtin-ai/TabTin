/**
 * API Token 管理面板
 *
 * 设置空间中的子面板，用于管理 Open API Token 的增删改查。
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  MoreHorizontal,
  Eye,
  EyeOff,
  ShieldCheck,
  Clock,
  AlertTriangle,
} from 'lucide-react'
import {
  Button,
  Switch,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  ConfirmDialog,
  LoadingSpinner,
  toast,
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import { Input, Textarea } from '@components/ui'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { TokenApiService } from '@tabtin/table-core'
import type {
  ApiToken,
  AvailableScopesResponse,
  CreateTokenRequest,
  TokenScope,
} from '@tabtin/table-core'
import { TOKEN_SCOPES, SCOPE_PRESETS } from '@tabtin/table-core'
import type { ScopePreset } from '@tabtin/table-core'
import { formatSmartTime } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_HOVER_ACTION, SETTINGS_LABEL, SETTINGS_SECTION_TITLE, SETTINGS_TEXTAREA, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { cn } from '@utils/cn'

// ── 常量 ──────────────────────────────────────────────

const PRESET_ORDER: ScopePreset[] = ['readonly', 'readwrite', 'full']

const FALLBACK_SCOPE_GROUPS = [
  {
    key: 'table',
    label_key: 'apiToken.scopeGroups.table',
    default_label: '表格',
    scopes: ['table:read', 'table:create', 'table:update', 'table:delete'] as TokenScope[],
  },
  {
    key: 'record',
    label_key: 'apiToken.scopeGroups.record',
    default_label: '记录',
    scopes: ['record:read', 'record:create', 'record:update', 'record:delete'] as TokenScope[],
  },
  {
    key: 'field',
    label_key: 'apiToken.scopeGroups.field',
    default_label: '字段',
    scopes: ['field:read', 'field:create', 'field:update', 'field:delete'] as TokenScope[],
  },
  {
    key: 'viewAggregation',
    label_key: 'apiToken.scopeGroups.viewAggregation',
    default_label: '视图 & 聚合',
    scopes: ['view:read', 'view:create', 'view:update', 'view:delete', 'aggregation:read'] as TokenScope[],
  },
  {
    key: 'dataTransfer',
    label_key: 'apiToken.scopeGroups.dataTransfer',
    default_label: '数据传输',
    scopes: ['import:write', 'export:read'] as TokenScope[],
  },
  {
    key: 'sql',
    label_key: 'apiToken.scopeGroups.sql',
    default_label: 'SQL',
    scopes: ['sql:query', 'sql:execute'] as TokenScope[],
  },
  {
    key: 'advanced',
    label_key: 'apiToken.scopeGroups.advanced',
    default_label: '高级',
    scopes: [
      'webhook:manage',
      'db_connection:manage',
      'storage:read',
      'storage:write',
      'policy:read',
      'policy:manage',
      'token:read',
      'token:manage',
      'connector:read',
      'connector:manage',
      'analytics:read',
    ] as TokenScope[],
  },
]

const SCOPE_LABEL_KEY_MAP: Record<TokenScope, string> = {
  'table:read': 'apiToken.scopeLabels.tableRead',
  'table:create': 'apiToken.scopeLabels.tableCreate',
  'table:update': 'apiToken.scopeLabels.tableUpdate',
  'table:delete': 'apiToken.scopeLabels.tableDelete',
  'record:read': 'apiToken.scopeLabels.recordRead',
  'record:create': 'apiToken.scopeLabels.recordCreate',
  'record:update': 'apiToken.scopeLabels.recordUpdate',
  'record:delete': 'apiToken.scopeLabels.recordDelete',
  'field:read': 'apiToken.scopeLabels.fieldRead',
  'field:create': 'apiToken.scopeLabels.fieldCreate',
  'field:update': 'apiToken.scopeLabels.fieldUpdate',
  'field:delete': 'apiToken.scopeLabels.fieldDelete',
  'view:read': 'apiToken.scopeLabels.viewRead',
  'view:create': 'apiToken.scopeLabels.viewCreate',
  'view:update': 'apiToken.scopeLabels.viewUpdate',
  'view:delete': 'apiToken.scopeLabels.viewDelete',
  'storage:read': 'apiToken.scopeLabels.storageRead',
  'storage:write': 'apiToken.scopeLabels.storageWrite',
  'aggregation:read': 'apiToken.scopeLabels.aggregationRead',
  'import:write': 'apiToken.scopeLabels.importWrite',
  'export:read': 'apiToken.scopeLabels.exportRead',
  'webhook:manage': 'apiToken.scopeLabels.webhookManage',
  'db_connection:manage': 'apiToken.scopeLabels.dbConnectionManage',
  'sql:query': 'apiToken.scopeLabels.sqlQuery',
  'sql:execute': 'apiToken.scopeLabels.sqlExecute',
  'policy:read': 'apiToken.scopeLabels.policyRead',
  'policy:manage': 'apiToken.scopeLabels.policyManage',
  'token:read': 'apiToken.scopeLabels.tokenRead',
  'token:manage': 'apiToken.scopeLabels.tokenManage',
  'connector:read': 'apiToken.scopeLabels.connectorRead',
  'connector:manage': 'apiToken.scopeLabels.connectorManage',
  'analytics:read': 'apiToken.scopeLabels.analyticsRead',
}

function fallbackGroupKeyForScope(scope: TokenScope): string {
  return FALLBACK_SCOPE_GROUPS.find(group => group.scopes.includes(scope))?.key ?? 'advanced'
}

const FALLBACK_SCOPE_CONFIG: AvailableScopesResponse = {
  scopes: (Object.entries(TOKEN_SCOPES) as [TokenScope, string][]).map(([scope, label]) => ({
    key: scope,
    group_key: fallbackGroupKeyForScope(scope),
    label_key: SCOPE_LABEL_KEY_MAP[scope],
    default_label: label,
  })),
  groups: FALLBACK_SCOPE_GROUPS.map(group => ({
    key: group.key,
    label_key: group.label_key,
    default_label: group.default_label,
    scopes: group.scopes,
  })),
  presets: {
    readonly: {
      label_key: 'apiToken.scopePresets.readonly.label',
      default_label: SCOPE_PRESETS.readonly.label,
      description_key: 'apiToken.scopePresets.readonly.description',
      default_description: SCOPE_PRESETS.readonly.description,
      scopes: [...SCOPE_PRESETS.readonly.scopes],
    },
    readwrite: {
      label_key: 'apiToken.scopePresets.readwrite.label',
      default_label: SCOPE_PRESETS.readwrite.label,
      description_key: 'apiToken.scopePresets.readwrite.description',
      default_description: SCOPE_PRESETS.readwrite.description,
      scopes: [...SCOPE_PRESETS.readwrite.scopes],
    },
    full: {
      label_key: 'apiToken.scopePresets.full.label',
      default_label: SCOPE_PRESETS.full.label,
      description_key: 'apiToken.scopePresets.full.description',
      default_description: SCOPE_PRESETS.full.description,
      scopes: [...SCOPE_PRESETS.full.scopes],
    },
  },
}

interface SpaceScopedApiTokenPanelProps {
  spaceId: string
  spaceName: string
}

// ── 子组件：Token 创建对话框 ──────────────────────────

interface CreateTokenDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (token: ApiToken, plainToken: string) => void
  spaceContext: SpaceScopedApiTokenPanelProps
  scopeConfig: AvailableScopesResponse
}

const CreateTokenDialog: React.FC<CreateTokenDialogProps> = ({
  open,
  onOpenChange,
  onCreated,
  spaceContext,
  scopeConfig,
}) => {
  const { t } = useTranslation('settings')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedPreset, setSelectedPreset] = useState<ScopePreset | 'custom'>('readonly')
  const [customScopes, setCustomScopes] = useState<Set<TokenScope>>(new Set())
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const scopeMetaByKey = useMemo(
    () => new Map(scopeConfig.scopes.map(scope => [scope.key, scope])),
    [scopeConfig.scopes],
  )

  // 根据 preset 计算最终 scope
  const effectiveScopes = useMemo(() => {
    if (selectedPreset === 'custom') return Array.from(customScopes)
    return [...scopeConfig.presets[selectedPreset].scopes]
  }, [selectedPreset, customScopes, scopeConfig.presets])

  const translateScopeLabel = useCallback((scope: TokenScope) => {
    const meta = scopeMetaByKey.get(scope)
    return t(meta?.label_key ?? SCOPE_LABEL_KEY_MAP[scope], {
      defaultValue: meta?.default_label ?? TOKEN_SCOPES[scope] ?? scope,
    })
  }, [scopeMetaByKey, t])

  const handleToggleScope = (scope: TokenScope) => {
    setCustomScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
    setSelectedPreset('custom')
  }

  const handlePresetChange = (preset: ScopePreset) => {
    setSelectedPreset(preset)
    setCustomScopes(new Set(scopeConfig.presets[preset].scopes))
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({ title: t('apiToken.toast.nameRequired'), variant: 'destructive' })
      return
    }
    if (effectiveScopes.length === 0) {
      toast({ title: t('apiToken.toast.scopeRequired'), variant: 'destructive' })
      return
    }

    setIsSubmitting(true)
    try {
      const body: CreateTokenRequest = {
        name: name.trim(),
        description: description.trim(),
        scopes: effectiveScopes,
        scope_preset: selectedPreset !== 'custom' ? selectedPreset : undefined,
        space_id: spaceContext.spaceId,
        space_ids: [spaceContext.spaceId],
        expires_in_days: expiresInDays,
      }
      const result = await TokenApiService.create(body)
      onCreated(result.token, result.plainToken)
      // 重置表单
      setName('')
      setDescription('')
      setSelectedPreset('readonly')
      setCustomScopes(new Set())
      setExpiresInDays(null)
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('apiToken.toast.createFailed'),
        description: err instanceof Error ? err.message : t('apiToken.toast.unknownError'),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const scopedSpaceName = spaceContext.spaceName || spaceContext.spaceId
  const selectedPresetMeta = selectedPreset === 'custom' ? null : scopeConfig.presets[selectedPreset]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('apiToken.create.title')}</DialogTitle>
          <DialogDescription>
            {t('apiToken.create.scopedDescription', {
              defaultValue: '此 Token 将默认限制在当前工作空间内，不会自动包含其他工作空间。',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border border-border/60 bg-muted/15 p-3">
            <div>
              <div className={SETTINGS_SECTION_TITLE}>
                {t('apiToken.create.scopeTargetTitle', { defaultValue: '默认授权范围' })}
              </div>
              <div className={cn(SETTINGS_TEXT_META, 'mt-1')}>
                {t('apiToken.create.scopeTargetDesc', {
                  name: scopedSpaceName,
                  defaultValue: '当前会把新 Token 限定到 Space「{{name}}」。',
                })}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={cn(SETTINGS_SECTION_TITLE, 'rounded-full bg-background px-2 py-0.5')}>
                {scopedSpaceName}
              </span>
              <code className={SETTINGS_TEXT_META}>{spaceContext.spaceId}</code>
            </div>
          </div>

          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('apiToken.create.name')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apiToken.create.namePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>

          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('apiToken.create.descriptionLabel')}</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('apiToken.create.descriptionPlaceholder')}
              className={cn(SETTINGS_TEXTAREA, 'min-h-[52px] resize-none')}
            />
          </div>

          <div className="space-y-1.5">
            <label className={SETTINGS_LABEL}>{t('apiToken.create.permissions')}</label>
            <div className="flex gap-2">
              {PRESET_ORDER.map((key) => {
                const preset = scopeConfig.presets[key]
                return (
                  <button
                    key={key}
                    onClick={() => handlePresetChange(key)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                      selectedPreset === key
                        ? 'border-accent/30 bg-accent/10 text-accent'
                        : 'border-border/60 text-muted-foreground hover:border-accent/30',
                    )}
                  >
                    {t(preset.label_key, { defaultValue: preset.default_label })}
                  </button>
                )
              })}
              <button
                onClick={() => setSelectedPreset('custom')}
                className={cn(
                  'rounded-md border px-2.5 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                  selectedPreset === 'custom'
                    ? 'border-accent/30 bg-accent/10 text-accent'
                    : 'border-border/60 text-muted-foreground hover:border-accent/30',
                )}
              >
                {t('apiToken.create.custom')}
              </button>
            </div>
            {selectedPresetMeta && (
              <p className={SETTINGS_TEXT_META}>
                {t(selectedPresetMeta.description_key, { defaultValue: selectedPresetMeta.default_description })}
              </p>
            )}
          </div>

          {/* 自定义权限详情 */}
          {selectedPreset === 'custom' && (
            <ScrollArea className="max-h-48 rounded-md border border-border/60 bg-muted/10">
              <div className="space-y-3 p-3">
              {scopeConfig.groups.map((group) => (
                <div key={group.key}>
                  <div className={cn(SETTINGS_SECTION_TITLE, 'mb-1.5')}>
                    {t(group.label_key, { defaultValue: group.default_label })}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.scopes.map((scope) => (
                      <label
                        key={scope}
                        className={cn(SETTINGS_TEXT_MICRO, 'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/30')}
                      >
                        <Checkbox
                          checked={customScopes.has(scope)}
                          onCheckedChange={() => handleToggleScope(scope)}
                        />
                        <span className="text-foreground">
                          {translateScopeLabel(scope)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              </div>
            </ScrollArea>
          )}

          {/* 选中 scope 预览（非自定义模式下） */}
          {selectedPreset !== 'custom' && (
            <div className="flex flex-wrap gap-1">
              {effectiveScopes.map((s) => (
                <span
                  key={s}
                  className={cn(SETTINGS_SECTION_TITLE, 'inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5')}
                >
                  {translateScopeLabel(s)}
                </span>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <label className={SETTINGS_LABEL}>{t('apiToken.create.expiryLabel')}</label>
            <div className="flex gap-2">
              {[
                { label: t('apiToken.create.expiryNever'), value: null },
                { label: t('apiToken.create.expiryDays', { days: 30 }), value: 30 },
                { label: t('apiToken.create.expiryDays', { days: 90 }), value: 90 },
                { label: t('apiToken.create.expiryDays', { days: 365 }), value: 365 },
              ].map((opt) => (
                <button
                  key={String(opt.value)}
                  onClick={() => setExpiresInDays(opt.value)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                    expiresInDays === opt.value
                      ? 'border-accent/30 bg-accent/10 text-accent'
                      : 'border-border/60 text-muted-foreground hover:border-accent/30',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('apiToken.create.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? <LoadingSpinner className="mr-2 h-3.5 w-3.5" /> : null}
            {t('apiToken.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 子组件：Token 密钥展示对话框 ──────────────────────

interface TokenSecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tokenName: string
  plainToken: string
}

const TokenSecretDialog: React.FC<TokenSecretDialogProps> = ({
  open,
  onOpenChange,
  tokenName,
  plainToken,
}) => {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const [visible, setVisible] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(plainToken)
    setCopied(true)
    toast({ title: t('apiToken.secret.copiedToClipboard') })
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            {t('apiToken.secret.title')}
          </DialogTitle>
          <DialogDescription>
            {t('apiToken.secret.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground')}>{tokenName}</div>

          <div className="relative">
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-3">
              <code className="flex-1 break-all font-mono text-body text-foreground">
                {visible ? plainToken : '•'.repeat(Math.min(plainToken.length, 48))}
              </code>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className={cn(SETTINGS_TEXT_META_BASE, 'text-warning', 'flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2')}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('apiToken.secret.warning')}</span>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleCopy}>
            {copied ? <Check className="mr-2 h-3.5 w-3.5" /> : <Copy className="mr-2 h-3.5 w-3.5" />}
            {copied ? t('apiToken.secret.copied') : t('apiToken.secret.copyKey')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── 子组件：单条 Token 行 ──────────────────────────────

interface TokenRowProps {
  token: ApiToken
  onToggleActive: (token: ApiToken) => void
  onDelete: (token: ApiToken) => void
  onRegenerate: (token: ApiToken) => void
}

const TokenRow: React.FC<TokenRowProps> = ({ token, onToggleActive, onDelete, onRegenerate }) => {
  const { t } = useTranslation('settings')
  const isExpired = token.expiredAt && new Date(token.expiredAt) < new Date()
  const boundaryLabel = (() => {
    if (token.tableIds && token.tableIds.length > 0) {
      return t('apiToken.row.tableScoped', {
        count: token.tableIds.length,
        defaultValue: '{{count}} 张表',
      })
    }
    if (token.spaceIds && token.spaceIds.length > 0) {
      return t('apiToken.row.spaceScoped', {
        count: token.spaceIds.length,
        defaultValue: '{{count}} 个 Space',
      })
    }
    return t('apiToken.row.globalScoped', { defaultValue: '全局' })
  })()

  return (
    <div className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/20">
      <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', token.isActive && !isExpired ? 'bg-success' : 'bg-muted-foreground/30')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'truncate')}>{token.name}</span>
          <code className={cn(SETTINGS_TEXT_META, 'text-muted-foreground/40', 'font-mono')}>{token.tokenPrefix}...</code>
          {!token.isActive && (
            <span className={cn(SETTINGS_HINT, 'bg-muted/40 px-1.5 py-0.5 rounded')}>{t('apiToken.row.disabled')}</span>
          )}
          {isExpired && (
            <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive', 'bg-destructive/10 px-1.5 py-0.5 rounded')}>{t('apiToken.row.expired')}</span>
          )}
        </div>
        <div className={cn(SETTINGS_TEXT_META, 'text-muted-foreground/40', 'flex items-center gap-3')}>
          <span>{token.lastUsedAt ? formatSmartTime(token.lastUsedAt) : t('apiToken.row.neverUsed')}</span>
          <span>{t('apiToken.row.scopeCount', { count: token.scopes.length })}</span>
          <span>{boundaryLabel}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch
          checked={token.isActive}
          onCheckedChange={() => onToggleActive(token)}
          aria-label={t('apiToken.row.toggleActive')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(SETTINGS_HOVER_ACTION, 'h-6 w-6 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground/60')}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={() => onRegenerate(token)}>
              <RefreshCw className="h-3 w-3" />
              {t('apiToken.row.regenerate')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(token)}>
              <Trash2 className="h-3 w-3" />
              {t('apiToken.row.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ── 主面板 ──────────────────────────────────────────────

export const ApiTokenPanel: React.FC<SpaceScopedApiTokenPanelProps> = ({
  spaceId,
  spaceName,
}) => {
  const { t } = useTranslation('settings')
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scopeConfig, setScopeConfig] = useState<AvailableScopesResponse>(FALLBACK_SCOPE_CONFIG)

  // 对话框状态
  const [showCreate, setShowCreate] = useState(false)
  const [createDialogSeed, setCreateDialogSeed] = useState(0)
  const [secretDialog, setSecretDialog] = useState<{
    open: boolean
    tokenName: string
    plainToken: string
  }>({ open: false, tokenName: '', plainToken: '' })
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean
    token: ApiToken | null
  }>({ open: false, token: null })
  const [regenerateConfirm, setRegenerateConfirm] = useState<{
    open: boolean
    token: ApiToken | null
  }>({ open: false, token: null })
  const visibleTokens = tokens

  // ── 数据加载 ──
  const loadTokens = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [list, availableScopes] = await Promise.all([
        TokenApiService.list(spaceId),
        TokenApiService.getAvailableScopes().catch(() => FALLBACK_SCOPE_CONFIG),
      ])
      setTokens(list)
      setScopeConfig(availableScopes)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('apiToken.toast.loadFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [spaceId, t])

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  const openCreateDialog = useCallback(() => {
    setCreateDialogSeed((prev) => prev + 1)
    setShowCreate(true)
  }, [])

  // ── 操作处理 ──
  const handleCreated = (token: ApiToken, plainToken: string) => {
    setTokens((prev) => [token, ...prev])
    setSecretDialog({ open: true, tokenName: token.name, plainToken })
  }

  const handleToggleActive = async (token: ApiToken) => {
    try {
      const updated = await TokenApiService.update(token.id, {
        is_active: !token.isActive,
      })
      setTokens((prev) => prev.map((t) => (t.id === token.id ? updated : t)))
      toast({ title: updated.isActive ? t('apiToken.toast.enabled') : t('apiToken.toast.disabled') })
    } catch {
      toast({ title: t('apiToken.toast.operationFailed'), variant: 'destructive' })
    }
  }

  const handleDelete = async () => {
    const token = deleteConfirm.token
    if (!token) return
    try {
      await TokenApiService.delete(token.id)
      setTokens((prev) => prev.filter((t) => t.id !== token.id))
      toast({ title: t('apiToken.toast.deleted') })
    } catch {
      toast({ title: t('apiToken.toast.deleteFailed'), variant: 'destructive' })
    } finally {
      setDeleteConfirm(s => ({ ...s, token: null }))
    }
  }

  const handleRegenerate = async () => {
    const token = regenerateConfirm.token
    if (!token) return
    try {
      const result = await TokenApiService.regenerate(token.id)
      setTokens((prev) => prev.map((t) => (t.id === token.id ? result.token : t)))
      setRegenerateConfirm(s => ({ ...s, token: null }))
      setSecretDialog({ open: true, tokenName: result.token.name, plainToken: result.plainToken })
    } catch {
      toast({ title: t('apiToken.toast.regenerateFailed'), variant: 'destructive' })
    }
  }

  // ── 渲染 ──
  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Key className="h-4 w-4" />}
        title={t('apiToken.title')}
        subtitle={t('apiToken.spaceSubtitle', {
          name: spaceName,
          defaultValue: '管理当前工作空间「{{name}}」对外接入使用的 API Token。',
        })}
      />

      {error && <p className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{error}</p>}

      <div className="flex items-center justify-between mb-2">
        <span className={SETTINGS_TEXT_META}>
          {t('apiToken.created', { count: visibleTokens.length })}
        </span>
        <button type="button" onClick={openCreateDialog} className="text-body text-accent hover:text-accent/80 transition-colors">
          {t('apiToken.createButton')}
        </button>
      </div>

      {isLoading ? (
        <div className="py-1">
          <ManagementCardListSkeleton count={5} />
        </div>
      ) : visibleTokens.length === 0 ? (
        <p className={cn(SETTINGS_HINT, 'py-4')}>{t('apiToken.empty')}</p>
      ) : (
        <div className="space-y-0.5">
          {visibleTokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              onToggleActive={handleToggleActive}
              onDelete={(t) => setDeleteConfirm({ open: true, token: t })}
              onRegenerate={(t) => setRegenerateConfirm({ open: true, token: t })}
            />
          ))}
        </div>
      )}

      {/* 创建对话框 */}
      <CreateTokenDialog
        key={createDialogSeed}
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={handleCreated}
        spaceContext={{ spaceId, spaceName }}
        scopeConfig={scopeConfig}
      />

      {/* 密钥展示对话框 */}
      <TokenSecretDialog
        open={secretDialog.open}
        onOpenChange={(open) => setSecretDialog((s) => ({ ...s, open }))}
        tokenName={secretDialog.tokenName}
        plainToken={secretDialog.plainToken}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm((s) => ({ ...s, open }))}
        title={t('apiToken.confirm.deleteTitle')}
        description={t('apiToken.confirm.deleteDescription', { name: deleteConfirm.token?.name })}
        confirmText={t('apiToken.confirm.deleteConfirm')}
        variant="destructive"
        onConfirm={handleDelete}
      />

      {/* 重新生成确认 */}
      <ConfirmDialog
        open={regenerateConfirm.open}
        onOpenChange={(open) => setRegenerateConfirm((s) => ({ ...s, open }))}
        title={t('apiToken.confirm.regenerateTitle')}
        description={t('apiToken.confirm.regenerateDescription', { name: regenerateConfirm.token?.name })}
        confirmText={t('apiToken.confirm.regenerateConfirm')}
        variant="destructive"
        onConfirm={handleRegenerate}
      />
    </SettingsPanelLayout>
  )
}
