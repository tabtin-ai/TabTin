import React, { useCallback, useEffect, useState } from 'react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { apiClient } from '@/services/apiClient'

interface PolicyData {
  dm_policy: string
  group_policy: string
  require_mention: boolean
  command_gate_enabled: boolean
  command_prefixes: string[]
}

interface ChannelPolicyPanelProps {
  organizationId: string
  channel: string
  accountId?: string
  label?: string
  canManage?: boolean
}

export const ChannelPolicyPanel: React.FC<ChannelPolicyPanelProps> = ({
  organizationId,
  channel,
  accountId = 'default',
  label,
  canManage = true,
}) => {
  const { t } = useTranslation('channel')
  const policyLabel = label || t(`channelMeta.${channel}`, { defaultValue: channel })
  const [policy, setPolicy] = useState<PolicyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    apiClient
      .get('/channel/policy', { params: { organization_id: organizationId, channel, account_id: accountId } })
      .then(({ data }) => {
        if (cancelled) return
        setPolicy(data)
      })
      .catch((err) => {
        if (cancelled) return
        setPolicy(null)
        setLoadError(err instanceof Error ? err.message : t('loadPolicyFailed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, channel, accountId])

  const handleSave = useCallback(async () => {
    if (!policy) return
    setSaving(true)
    setSaveError('')
    try {
      const { data } = await apiClient.patch('/channel/policy', {
        organization_id: organizationId,
        channel,
        account_id: accountId,
        ...policy,
      })
      setPolicy(data)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('savePolicyFailed'))
    } finally {
      setSaving(false)
    }
  }, [policy, organizationId, channel, accountId, t])

  if (loading) {
    return (
      <div className="border-t border-border/20 pt-4">
        <span className="text-body text-muted-foreground">{t('securityPolicyFor', { label: policyLabel })}</span>
        <p className="mt-2 text-caption text-muted-foreground/60">{t('loadingPolicy')}</p>
      </div>
    )
  }

  if (!policy) {
    return (
      <div className="border-t border-border/20 pt-4">
        <span className="text-body text-muted-foreground">{t('securityPolicyFor', { label: policyLabel })}</span>
        <p className="mt-2 text-caption text-destructive">{loadError || t('loadPolicyFailed')}</p>
      </div>
    )
  }

  return (
    <div className="border-t border-border/20 pt-4 space-y-3">
      <span className="text-body text-muted-foreground">{t('securityPolicyFor', { label: policyLabel })}</span>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-caption text-muted-foreground/60">{t('dmPolicy')}</label>
          <Select value={policy.dm_policy} onValueChange={(v) => setPolicy({ ...policy, dm_policy: v })} disabled={!canManage}>
            <SelectTrigger className="w-full h-8 text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">{t('dmPolicyOpen')}</SelectItem>
              <SelectItem value="allowlist">{t('dmPolicyAllowlist')}</SelectItem>
              <SelectItem value="pairing">{t('dmPolicyPairing')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-caption text-muted-foreground/60">{t('groupPolicy')}</label>
          <Select value={policy.group_policy} onValueChange={(v) => setPolicy({ ...policy, group_policy: v })} disabled={!canManage}>
            <SelectTrigger className="w-full h-8 text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">{t('groupPolicyOpen')}</SelectItem>
              <SelectItem value="allowlist">{t('groupPolicyAllowlist')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between py-1.5">
        <div>
          <div className="text-body text-foreground">{t('requireMention')}</div>
          <div className="text-caption text-muted-foreground/60">{t('requireMentionHint')}</div>
        </div>
        <Switch
          checked={policy.require_mention}
          onCheckedChange={(v) => setPolicy({ ...policy, require_mention: v })}
          disabled={!canManage}
        />
      </div>

      <div className="flex items-center justify-between py-1.5">
        <div>
          <div className="text-body text-foreground">{t('commandGate')}</div>
          <div className="text-caption text-muted-foreground/60">{t('commandGateHint')}</div>
        </div>
        <Switch
          checked={policy.command_gate_enabled}
          onCheckedChange={(v) => setPolicy({ ...policy, command_gate_enabled: v })}
          disabled={!canManage}
        />
      </div>

      {saveError && (
        <p className="text-caption text-destructive">{saveError}</p>
      )}

      <div className="sticky bottom-0 flex justify-end pt-3 pb-1 bg-background border-t border-border/20 mt-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !canManage} className="h-7 text-body">
          {saving ? t('savingPolicy') : t('savePolicy')}
        </Button>
      </div>
    </div>
  )
}
