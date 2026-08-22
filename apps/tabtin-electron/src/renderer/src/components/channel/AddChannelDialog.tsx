import React, { useState, useCallback, useEffect, useMemo } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@/stores/useSpaceStore'

type ChannelMode = 'polling' | 'webhook'

interface SelectOption {
  value: string
  labelKey: string
}

interface FieldDef {
  key: string
  labelKey: string
  placeholderKey?: string
  required?: boolean
  sensitive?: boolean
  helpKey?: string
  type?: 'text' | 'select'
  options?: SelectOption[]
  defaultValue?: string
}

interface ChannelDef {
  id: string
  icon: string
  descKey: string
  fields: FieldDef[]
  hasMode?: boolean
  defaultMode?: ChannelMode
}

const CHANNELS: ChannelDef[] = [
  {
    id: 'telegram', icon: '🤖', descKey: 'telegramBotDesc', hasMode: true, defaultMode: 'polling',
    fields: [
      { key: 'bot_token', labelKey: 'botTokenLabel', placeholderKey: 'botTokenPlaceholder', required: true, sensitive: true, helpKey: 'botTokenHelp' },
    ],
  },
  {
    id: 'feishu', icon: '🐦', descKey: 'feishuBotDesc',
    fields: [
      { key: 'domain', labelKey: 'feishuDomainLabel', type: 'select', defaultValue: 'feishu', options: [
        { value: 'feishu', labelKey: 'feishuDomainFeishu' },
        { value: 'lark', labelKey: 'feishuDomainLark' },
      ]},
      { key: 'app_id', labelKey: 'feishuAppIdLabel', placeholderKey: 'feishuAppIdPlaceholder', required: true, helpKey: 'feishuAppIdHelp' },
      { key: 'app_secret', labelKey: 'feishuAppSecretLabel', placeholderKey: 'feishuAppSecretPlaceholder', required: true, sensitive: true },
      { key: 'verification_token', labelKey: 'feishuVerificationTokenLabel', placeholderKey: 'feishuVerificationTokenPlaceholder' },
      { key: 'encrypt_key', labelKey: 'feishuEncryptKeyLabel', placeholderKey: 'feishuEncryptKeyPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'slack', icon: '💬', descKey: 'slackBotDesc',
    fields: [
      { key: 'bot_token', labelKey: 'slackBotTokenLabel', placeholderKey: 'slackBotTokenPlaceholder', required: true, sensitive: true, helpKey: 'slackBotTokenHelp' },
      { key: 'signing_secret', labelKey: 'slackSigningSecretLabel', placeholderKey: 'slackSigningSecretPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'discord', icon: '🎮', descKey: 'discordBotDesc',
    fields: [
      { key: 'bot_token', labelKey: 'discordBotTokenLabel', placeholderKey: 'discordBotTokenPlaceholder', required: true, sensitive: true, helpKey: 'discordBotTokenHelp' },
      { key: 'public_key', labelKey: 'discordPublicKeyLabel', placeholderKey: 'discordPublicKeyPlaceholder' },
      { key: 'application_id', labelKey: 'discordApplicationIdLabel', placeholderKey: 'discordApplicationIdPlaceholder' },
    ],
  },
  {
    id: 'whatsapp', icon: '📱', descKey: 'whatsappBotDesc',
    fields: [
      { key: 'access_token', labelKey: 'whatsappAccessTokenLabel', placeholderKey: 'whatsappAccessTokenPlaceholder', required: true, sensitive: true, helpKey: 'whatsappAccessTokenHelp' },
      { key: 'phone_number_id', labelKey: 'whatsappPhoneNumberIdLabel', placeholderKey: 'whatsappPhoneNumberIdPlaceholder', required: true },
      { key: 'verify_token', labelKey: 'whatsappVerifyTokenLabel', placeholderKey: 'whatsappVerifyTokenPlaceholder', sensitive: true },
      { key: 'app_secret', labelKey: 'whatsappAppSecretLabel', placeholderKey: 'whatsappAppSecretPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'line', icon: '🟢', descKey: 'lineBotDesc',
    fields: [
      { key: 'channel_access_token', labelKey: 'lineChannelAccessTokenLabel', placeholderKey: 'lineChannelAccessTokenPlaceholder', required: true, sensitive: true, helpKey: 'lineChannelAccessTokenHelp' },
      { key: 'channel_secret', labelKey: 'lineChannelSecretLabel', placeholderKey: 'lineChannelSecretPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'dingtalk', icon: '🔔', descKey: 'dingtalkBotDesc',
    fields: [
      { key: 'app_key', labelKey: 'dingtalkAppKeyLabel', placeholderKey: 'dingtalkAppKeyPlaceholder', required: true, helpKey: 'dingtalkAppKeyHelp' },
      { key: 'app_secret', labelKey: 'dingtalkAppSecretLabel', placeholderKey: 'dingtalkAppSecretPlaceholder', required: true, sensitive: true },
      { key: 'robot_code', labelKey: 'dingtalkRobotCodeLabel', placeholderKey: 'dingtalkRobotCodePlaceholder' },
    ],
  },
  {
    id: 'wechat_work', icon: '💼', descKey: 'wechatWorkBotDesc',
    fields: [
      { key: 'corp_id', labelKey: 'wechatWorkCorpIdLabel', placeholderKey: 'wechatWorkCorpIdPlaceholder', required: true, helpKey: 'wechatWorkCorpIdHelp' },
      { key: 'secret', labelKey: 'wechatWorkSecretLabel', placeholderKey: 'wechatWorkSecretPlaceholder', required: true, sensitive: true },
      { key: 'agent_id', labelKey: 'wechatWorkAgentIdLabel', placeholderKey: 'wechatWorkAgentIdPlaceholder', required: true },
      { key: 'token', labelKey: 'wechatWorkTokenLabel', placeholderKey: 'wechatWorkTokenPlaceholder' },
      { key: 'encoding_aes_key', labelKey: 'wechatWorkEncodingAesKeyLabel', placeholderKey: 'wechatWorkEncodingAesKeyPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'googlechat', icon: '💬', descKey: 'googlechatBotDesc',
    fields: [
      { key: 'service_account_json', labelKey: 'googlechatServiceAccountLabel', placeholderKey: 'googlechatServiceAccountPlaceholder', required: true, sensitive: true, helpKey: 'googlechatServiceAccountHelp' },
    ],
  },
  {
    id: 'msteams', icon: '🟦', descKey: 'msteamsBotDesc',
    fields: [
      { key: 'app_id', labelKey: 'msteamsAppIdLabel', placeholderKey: 'msteamsAppIdPlaceholder', required: true, helpKey: 'msteamsAppIdHelp' },
      { key: 'app_password', labelKey: 'msteamsAppPasswordLabel', placeholderKey: 'msteamsAppPasswordPlaceholder', required: true, sensitive: true },
      { key: 'tenant_id', labelKey: 'msteamsTenantIdLabel', placeholderKey: 'msteamsTenantIdPlaceholder' },
    ],
  },
  {
    id: 'mattermost', icon: '🔵', descKey: 'mattermostBotDesc',
    fields: [
      { key: 'server_url', labelKey: 'mattermostServerUrlLabel', placeholderKey: 'mattermostServerUrlPlaceholder', required: true, helpKey: 'mattermostServerUrlHelp' },
      { key: 'bot_token', labelKey: 'mattermostBotTokenLabel', placeholderKey: 'mattermostBotTokenPlaceholder', required: true, sensitive: true },
      { key: 'webhook_secret', labelKey: 'mattermostWebhookSecretLabel', placeholderKey: 'mattermostWebhookSecretPlaceholder', sensitive: true },
    ],
  },
  {
    id: 'weixin_personal', icon: '💚', descKey: 'weixinPersonalBotDesc',
    fields: [],
  },
]

const MODE_OPTIONS: { value: ChannelMode; labelKey: string; hintKey: string }[] = [
  { value: 'polling', labelKey: 'modePolling', hintKey: 'modePollingHint' },
  { value: 'webhook', labelKey: 'modeWebhook', hintKey: 'modeWebhookHint' },
]

interface AddChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (channel: string, config: Record<string, string>) => Promise<void>
  editAccount?: { id: string; channel: string; name: string | null; config: Record<string, unknown> } | null
  fixedSpaceId?: string
  occupiedChannelIds?: string[]
}

export const AddChannelDialog: React.FC<AddChannelDialogProps> = ({
  open,
  onOpenChange,
  onSubmit,
  editAccount,
  fixedSpaceId,
  occupiedChannelIds = [],
}) => {
  const { t } = useTranslation('channel')
  const spaces = useSpaceStore((s) => s.spaces)
  const fixedSpace = fixedSpaceId ? spaces.find((space) => space.id === fixedSpaceId) ?? null : null

  const [step, setStep] = useState<'select' | 'config'>('select')
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<ChannelMode>('polling')
  const [accountName, setAccountName] = useState('')
  const [selectedSpaceId, setSelectedSpaceId] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isEdit = !!editAccount
  const selectedChannel = CHANNELS.find((c) => c.id === selectedChannelId)
  const initialSpaceId = fixedSpaceId ?? ''
  const occupiedChannelSet = useMemo(() => new Set(occupiedChannelIds), [occupiedChannelIds])

  const reset = useCallback(() => {
    setStep('select')
    setSelectedChannelId(null)
    setFieldValues({})
    setMode('polling')
    setAccountName('')
    setSelectedSpaceId(initialSpaceId)
    setError('')
    setSubmitting(false)
  }, [initialSpaceId])

  useEffect(() => {
    if (open && editAccount) {
      const cfg = editAccount.config || {}
      setSelectedChannelId(editAccount.channel)
      setStep('config')
      setAccountName(editAccount.name || '')
      setMode((cfg.mode as ChannelMode) || 'webhook')
      setSelectedSpaceId(fixedSpaceId ?? (((cfg.default_space_id as string) || (cfg.default_project_id as string)) || ''))
      const values: Record<string, string> = {}
      const ch = CHANNELS.find((c) => c.id === editAccount.channel)
      for (const f of ch?.fields ?? []) {
        const v = cfg[f.key]
        if (typeof v === 'string') values[f.key] = v
        else if (f.defaultValue) values[f.key] = f.defaultValue
      }
      setFieldValues(values)
      setError('')
    } else if (open) {
      setSelectedSpaceId(initialSpaceId)
    }
  }, [open, editAccount, fixedSpaceId, initialSpaceId])

  const handleOpenChange = (next: boolean) => { if (!next) reset(); onOpenChange(next) }
  const handleSelect = (id: string) => {
    const ch = CHANNELS.find((c) => c.id === id)
    setSelectedChannelId(id)
    setMode(ch?.defaultMode ?? 'webhook')
    const defaults: Record<string, string> = {}
    for (const f of ch?.fields ?? []) {
      if (f.defaultValue) defaults[f.key] = f.defaultValue
    }
    setFieldValues(defaults)
    setStep('config')
    setError('')
  }

  const setField = (key: string, value: string) => setFieldValues((prev) => ({ ...prev, [key]: value }))

  const validate = (): string | null => {
    if (!selectedChannel) return null
    for (const f of selectedChannel.fields) {
      if (f.required && !(fieldValues[f.key] ?? '').trim()) {
        const errKey = `${selectedChannelId}${f.key.charAt(0).toUpperCase() + f.key.slice(1).replace(/_(\w)/g, (_, c) => c.toUpperCase())}Required`
        return t(errKey, { defaultValue: t('addChannelFailed') })
      }
    }
    if (selectedChannelId === 'telegram') {
      const tok = (fieldValues.bot_token ?? '').trim()
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(tok)) return t('botTokenInvalid')
    }
    if (!(fixedSpaceId ?? selectedSpaceId)) return t('selectSpace')
    return null
  }

  const buildConfig = (): Record<string, string> => {
    const cfg: Record<string, string> = {}
    const boundSpaceId = fixedSpaceId ?? selectedSpaceId
    if (accountName.trim()) cfg.name = accountName.trim()
    if (boundSpaceId) cfg.default_space_id = boundSpaceId
    if (selectedChannel?.hasMode) cfg.mode = mode
    else cfg.mode = 'webhook'

    for (const f of selectedChannel?.fields ?? []) {
      const v = (fieldValues[f.key] ?? '').trim()
      if (v) cfg[f.key] = v
    }
    return cfg
  }

  const handleSubmit = async () => {
    setError('')
    if (!selectedChannelId) return
    const err = validate()
    if (err) { setError(err); return }
    setSubmitting(true)
    try {
      await onSubmit(selectedChannelId, buildConfig())
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('addChannelFailed'))
    } finally { setSubmitting(false) }
  }

  const label = selectedChannelId ? t(`channelMeta.${selectedChannelId}`, { defaultValue: selectedChannelId }) : ''
  const selectCls = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-body shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === 'select' ? t('addChannel') : isEdit ? t('editChannel', { label }) : t('configureChannel', { label })}</DialogTitle>
        </DialogHeader>

        {step === 'select' && (
          <div className="space-y-2 py-2">
            {CHANNELS.map((ch) => {
              const isUnavailable = !isEdit && occupiedChannelSet.has(ch.id)
              return (
                <button
                  key={ch.id}
                  className="w-full flex items-center gap-3 rounded-lg border border-border/60 p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  disabled={isUnavailable}
                  aria-disabled={isUnavailable}
                  title={isUnavailable ? t('channelAlreadyBound') : undefined}
                  onClick={() => handleSelect(ch.id)}
                >
                  <span className="text-heading">{ch.icon}</span>
                  <div className="min-w-0">
                    <div className="text-body font-medium">{t(`channelMeta.${ch.id}`)}</div>
                    <div className="text-body text-muted-foreground">{t(ch.descKey)}</div>
                    {isUnavailable && (
                      <div className="mt-1 text-caption text-muted-foreground/60">
                        {t('channelAlreadyBound')}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {step === 'config' && selectedChannel && (
          <div className="space-y-4 py-2">
            {selectedChannelId === 'weixin_personal' && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                <p className="text-body text-foreground">{t('weixinPersonalConfigHint')}</p>
              </div>
            )}

            {selectedChannel.fields.map((f, i) => (
              <div key={f.key} className="space-y-2">
                <label className="text-body font-medium">
                  {t(f.labelKey)} {f.required && <span className="text-destructive">*</span>}
                </label>
                {f.type === 'select' && f.options ? (
                  <Select
                    value={fieldValues[f.key] ?? f.defaultValue ?? ''}
                    onValueChange={(value) => setField(f.key, value)}
                  >
                    <SelectTrigger className={selectCls}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={fieldValues[f.key] ?? ''}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={f.placeholderKey ? t(f.placeholderKey) : ''}
                    type={f.sensitive ? 'password' : 'text'}
                    autoFocus={i === 0}
                  />
                )}
                {f.helpKey && (
                  <p className="text-body text-muted-foreground" dangerouslySetInnerHTML={{ __html: t(f.helpKey) }} />
                )}
              </div>
            ))}

            {selectedChannel.hasMode && (
              <div className="space-y-2">
                <label className="text-body font-medium">{t('receiveMode')}</label>
                <div className="flex gap-2">
                  {MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`flex-1 rounded-lg border p-2.5 text-left transition-colors ${
                        mode === opt.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'border-border/60 hover:bg-accent'
                      }`}
                      onClick={() => setMode(opt.value)}
                      type="button"
                    >
                      <div className="text-body font-medium">{t(opt.labelKey)}</div>
                      <div className="mt-0.5 text-caption leading-tight text-muted-foreground">{t(opt.hintKey)}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {fixedSpaceId ? (
              <div className="space-y-2">
                <label className="text-body font-medium">{t('linkedSpace')}</label>
                <div className="rounded-md border border-input bg-muted/20 px-3 py-2 text-body text-foreground">
                  {fixedSpace ? `${fixedSpace.icon ? `${fixedSpace.icon} ` : ''}${fixedSpace.name}` : fixedSpaceId}
                </div>
                <p className="text-body text-muted-foreground">{t('linkedSpaceHelp')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-body font-medium">
                  {t('linkedSpace')} <span className="text-destructive">*</span>
                </label>
                <Select
                  value={selectedSpaceId || '__none__'}
                  onValueChange={(value) => setSelectedSpaceId(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger className={selectCls}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t('selectSpace')}</SelectItem>
                    {spaces.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ''}{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-body text-muted-foreground">{t('linkedSpaceHelp')}</p>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-body font-medium">{t('displayName')}</label>
              <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder={t('displayNamePlaceholder')} />
            </div>

            {error && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2.5">
                <p className="text-body text-destructive">{error}</p>
              </div>
            )}
          </div>
        )}

        {step === 'config' && (
          <DialogFooter className="gap-2 sm:gap-0">
            {!isEdit && <Button variant="outline" onClick={() => { setStep('select'); setError('') }}>{t('back')}</Button>}
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (isEdit ? t('saving') : t('adding')) : (isEdit ? t('save') : t('addChannel'))}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
