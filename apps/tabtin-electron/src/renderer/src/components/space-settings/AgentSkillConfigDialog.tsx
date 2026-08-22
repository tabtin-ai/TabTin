/**
 * AgentSkillConfigDialog — 携带集行的私有配置编辑（ W3）。
 *
 * 表单模式沿用 SkillConfigDialog（凭据选择器 + env/config JSON），但数据锚
 * 从 (user, space) 的 SkillEnablement 换成 Agent 携带行：读 link.config_json，
 * 保存走 PATCH /agents/{id}/skills/{key} 的 config_json（后端按顶层 key merge，
 * 值为 null 删除该 key；这里以携带行现值为基线合并草稿后提交）。credential
 * 仍引用 UserCredential.id，运行时由设备端换取明文，不落明文密钥。
 */
import React, { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Label,
  ScrollArea,
  Textarea,
  toast,
} from '@components/ui'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, useApiKeyCredentialsQuery } from '@/hooks/queries/credentials'
import { useUpdateAgentSkillLinkMutation } from '@/hooks/queries/agentSkills'
import type { AgentSkillLinkItem, SkillConfig, SkillIndexEntry } from '@/skills/types'
import {
  SkillCredentialPicker,
  inferServiceNameFromPrimaryEnv,
  type CredentialPickerMode,
} from '@components/context-space/skills/SkillCredentialPicker'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

interface AgentSkillConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string
  /** SubAgentTemplate 同步锚（与携带面板 spaceId / skillContextSpaceId 一致） */
  spaceId?: string
  link: AgentSkillLinkItem | null
  /** 技能池匹配到的 registry 条目（补 primary_env 等 meta）；匹配不到给 null。 */
  poolSkill: SkillIndexEntry | null
}

export const AgentSkillConfigDialog: React.FC<AgentSkillConfigDialogProps> = ({
  open,
  onOpenChange,
  agentId,
  spaceId,
  link,
  poolSkill,
}) => {
  const { t } = useTranslation('context')
  const queryClient = useQueryClient()
  const updateLinkMutation = useUpdateAgentSkillLinkMutation()

  const primaryEnv = poolSkill?.primary_env
  const inferredService = inferServiceNameFromPrimaryEnv(primaryEnv)
  const { data: existingCandidates = [] } = useApiKeyCredentialsQuery({
    serviceName: inferredService,
  })

  const [credentialMode, setCredentialMode] = useState<CredentialPickerMode>('existing')
  const [draftCredentialId, setDraftCredentialId] = useState('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [draftEnv, setDraftEnv] = useState('')
  const [draftConfig, setDraftConfig] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !link) {
      // 关闭即清空敏感草稿（同 SkillConfigDialog 的驻留内存治理口径）
      if (!open) setManualApiKey('')
      return
    }
    const existing = link.config_json || {}
    const existingCredId = existing.credential_id || ''
    setDraftCredentialId(existingCredId)
    if (existingCredId) {
      setCredentialMode('existing')
    } else if (existingCandidates.length > 0) {
      setCredentialMode('existing')
      setDraftCredentialId(existingCandidates[0].id)
    } else {
      setCredentialMode('manual')
    }
    setManualApiKey('')
    setDraftEnv(
      existing.env && Object.keys(existing.env).length > 0
        ? JSON.stringify(existing.env, null, 2)
        : '',
    )
    setDraftConfig(
      existing.config && Object.keys(existing.config).length > 0
        ? JSON.stringify(existing.config, null, 2)
        : '',
    )
  }, [open, link, existingCandidates])

  if (!link) return null

  const skillName = link.name || link.skill_canonical_key

  /** 手动输入路径：先建凭据拿 id 再绑（与 SkillConfigDialog 同款流程）。 */
  const createCredentialFromManualKey = async (): Promise<string | null> => {
    const trimmed = manualApiKey.trim()
    if (!trimmed) return null
    const serviceName = inferredService || 'custom'
    try {
      const result = await apiClient.post<{ id: string }>('/credential-vault/create', {
        category: 'api_key',
        service_name: serviceName,
        display_name: t('skills.credentialAutoCreateDisplayName', {
          defaultValue: '{{service}} (来自 Skill：{{skillName}})',
          service: serviceName,
          skillName,
        }),
        credential_data: { api_key: trimmed },
      })
      const newId = (result.data as { id?: string } | undefined)?.id
      if (!newId) {
        toast.error(t('skills.credentialCreateFailedNoId', {
          defaultValue: '创建凭据失败：服务端未返回 id',
        }))
        return null
      }
      void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
      return newId
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const handleSave = async () => {
    let parsedEnv: Record<string, string> | undefined
    let parsedConfig: Record<string, unknown> | undefined
    if (draftEnv.trim()) {
      try {
        parsedEnv = JSON.parse(draftEnv)
      } catch {
        toast.error(`${t('skills.configEnvSection')}: invalid JSON`)
        return
      }
    }
    if (draftConfig.trim()) {
      try {
        parsedConfig = JSON.parse(draftConfig)
      } catch {
        toast.error(`${t('skills.configSection')}: invalid JSON`)
        return
      }
    }

    let credentialIdToSave: string | undefined
    if (primaryEnv) {
      if (credentialMode === 'existing') {
        credentialIdToSave = draftCredentialId || ''
      } else if (manualApiKey.trim()) {
        const newId = await createCredentialFromManualKey()
        if (!newId) return
        credentialIdToSave = newId
      }
      // manual 且空白输入 → 不变更 credential_id（保持原值）
    }

    setSaving(true)
    try {
      // 后端 PATCH 按顶层 key merge；清空字段显式传 null。
      const base = { ...(link.config_json || {}) }
      const nextConfig: Record<string, unknown> = {
        ...base,
        ...(credentialIdToSave !== undefined ? { credential_id: credentialIdToSave } : {}),
        ...(parsedEnv !== undefined ? { env: parsedEnv } : {}),
        ...(parsedConfig !== undefined ? { config: parsedConfig } : {}),
      }
      if (parsedEnv === undefined && !draftEnv.trim()) nextConfig.env = null
      if (parsedConfig === undefined && !draftConfig.trim()) nextConfig.config = null
      if (nextConfig.credential_id === '') nextConfig.credential_id = null

      await updateLinkMutation.mutateAsync({
        agentId,
        skillCanonicalKey: link.skill_canonical_key,
        configJson: nextConfig as SkillConfig,
        spaceId,
      })
      toast.success(t('skills.configSavedTitle'))
      onOpenChange(false)
    } catch (err) {
      log.error('保存 Agent 携带集配置失败', {
        agentId,
        canonicalKey: link.skill_canonical_key,
      }, err)
      toast.error(err instanceof Error ? err.message : t('skills.configSaveFailedTitle'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={link.emoji ? <span className="text-title leading-none">{link.emoji}</span> : <Settings className="h-7 w-7" />}
          title={t('skills.configTitle', { skillName })}
          description={t('skills.agentSkills.configDescription', {
            defaultValue: '这里的凭据和环境变量只对这个 Agent 生效。',
          })}
        />

        <ScrollArea className="flex-1">
          <div className="space-y-5 py-2 pr-1">
            {primaryEnv ? (
              <SkillCredentialPicker
                primaryEnv={primaryEnv}
                mode={credentialMode}
                onModeChange={setCredentialMode}
                selectedCredentialId={draftCredentialId}
                onSelectedCredentialIdChange={setDraftCredentialId}
                manualKey={manualApiKey}
                onManualKeyChange={setManualApiKey}
                onCloseDialog={() => onOpenChange(false)}
              />
            ) : null}

            <div className="space-y-2">
              <Label className="text-body font-medium">{t('skills.configEnvSection')}</Label>
              <Textarea
                className="font-mono text-body min-h-[80px]"
                value={draftEnv}
                onChange={(e) => setDraftEnv(e.target.value)}
                placeholder='{ "KEY": "value" }'
              />
            </div>

            <div className="space-y-2">
              <Label className="text-body font-medium">{t('skills.configSection')}</Label>
              <Textarea
                className="font-mono text-body min-h-[80px]"
                value={draftConfig}
                onChange={(e) => setDraftConfig(e.target.value)}
                placeholder='{ "option": "value" }'
              />
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border pt-4 bg-background">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('skills.configCancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? `${t('skills.configSave')}...` : t('skills.configSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
