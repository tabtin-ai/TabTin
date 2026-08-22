import React, { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  ScrollArea,
  Switch,
  Textarea,
  toast,
} from '@components/ui'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { useSkillConfigsQuery, useUpdateSkillConfigMutation } from '@/hooks/queries/skills'
import { useQueryClient } from '@tanstack/react-query'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { credentialKeys, useApiKeyCredentialsQuery } from '@/hooks/queries/credentials'
import { apiClient } from '@/services/apiClient'
import type { SkillIndexEntry, SkillConfig } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { isBuiltinCatalogSkill } from './skillProductState'
import { resolveSkillDisplayName } from './skillSlug'
import {
  SkillCredentialPicker,
  inferServiceNameFromPrimaryEnv,
  type CredentialPickerMode,
} from './SkillCredentialPicker'

type SkillConfigDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry | null
  spaceId: string
}

/**
 * Wave 5b S2 — Skill 凭据选择器 UI（PRD 5.4）。
 *
 * 与 Wave 1.5/2 后端基础设施对齐：
 *   - SkillConfig 已经从 api_key 迁到 credential_id（PD-3 不保留兼容层）
 *   - skill_reveal 端点用 credential_id 解密 + 派生 env 注入子进程
 *   - 本 UI 让用户选 credential_id（之前只有跳转链接）
 *
 * 保存逻辑分两条路径：
 *   - mode='existing'：直接传 credential_id（用户在凭据库已建过）
 *   - mode='manual'：先 POST /credential-vault/create 拿到 id，再传 credential_id；
 *     等价于"手动录入 = 自动加入凭据库 + 自动绑定到本 Skill"，下次配置另一个
 *     同 service 的 Skill 就能从下拉里选到这条凭据。
 */
export const SkillConfigDialog: React.FC<SkillConfigDialogProps> = ({
  open,
  onOpenChange,
  skill,
  spaceId,
}) => {
  const { t } = useTranslation('context')
  const queryClient = useQueryClient()
  // ：SkillEnablement config 走 organization_id + agent_id 锚点；spaceId 仅本地 IPC 用。
  const organizationId = useSpaceStore(state =>
    state.spaces.find(s => s.id === spaceId)?.organization_id ?? '',
  )
  const selectedAgentId = useSpaceStore(state => state.selectedAgent?.id ?? '')
  const { data: skillConfigs = {} } = useSkillConfigsQuery(spaceId)
  const updateConfigMutation = useUpdateSkillConfigMutation()
  // Wave 5b 视角 2#1 P1 自修：默认模式根据"凭据库是否有同 service 候选"决定，
  // 而不是只看"SkillConfig 是否已绑过"。Wave 1.5 KPI 是"配一次全 Agent 用"——
  // 用户已有 OpenAI Key 后，第一次打开 OpenAI Skill 配置应该默认
  // 走 existing（看到下拉里有候选），而不是默认 manual 让用户重输一遍。
  const inferredService = inferServiceNameFromPrimaryEnv(skill?.primary_env)
  const { data: existingCandidates = [] } = useApiKeyCredentialsQuery({
    serviceName: inferredService,
  })

  // Draft state
  const [draftEnabled, setDraftEnabled] = useState(true)
  const [credentialMode, setCredentialMode] = useState<CredentialPickerMode>('existing')
  const [draftCredentialId, setDraftCredentialId] = useState<string>('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [draftEnv, setDraftEnv] = useState('')
  const [draftConfig, setDraftConfig] = useState('')
  /** Per-key env values for system skills with requires.env (no free-form JSON) */
  const [draftEnvFields, setDraftEnvFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // Sync draft from store when dialog opens / skill changes
  useEffect(() => {
    // Wave 5b 视角 3#6 自修：dialog 关闭路径**主动清空** manualApiKey + draftConfig
    // 等敏感 / 临时 state——父级 SkillsSection.tsx 把 SkillConfigDialog 无条件挂载
    // （open=Boolean(configSkill)），关闭后组件不会 unmount，state 持续驻留 React
    // 内存直到下次 open 才覆写。API Key 是高敏感物料，关闭后任何 leak（DevTools
    // React profiler / 内存 dump）都不应能拿到。
    if (!open || !skill) {
      if (!open) {
        // 走 setter 而不是依赖下一次 open 覆盖——避免 1) 残留时间窗 2) 未来父级
        // 改条件挂载时漏修。
        setManualApiKey('')
      }
      return
    }
    const key = skill.skill_key || ''
    const existing: SkillConfig = skillConfigs[key] || {}
    // device opt-in：无行默认关；其余 soft-default-on
    setDraftEnabled(
      normalizeSkillSource(skill.source) === 'device'
        ? existing.enabled === true
        : existing.enabled !== false,
    )
    const existingCredId = existing.credential_id || ''
    setDraftCredentialId(existingCredId)
    // Wave 5b 视角 2#1 P1 自修：三段优先级
    //   1) 该 SkillConfig 已绑过 credential_id → existing（保持原行为）
    //   2) 该 service 在凭据库已有 ≥1 条候选 → existing + 自动预选第一条（last_used 排序后端已做）
    //      这条是 Wave 1.5"配一次全 Agent 用"KPI 兑现的关键节点
    //   3) 没绑过 + 也没候选 → manual（用户必须现场输入）
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
        : ''
    )
    setDraftConfig(
      existing.config && Object.keys(existing.config).length > 0
        ? JSON.stringify(existing.config, null, 2)
        : ''
    )
    // Populate per-key env fields from stored env object
    const envObj = existing.env || {}
    const fields: Record<string, string> = {}
    for (const envKey of skill.requires?.env || []) {
      if (envKey !== skill.primary_env) {
        fields[envKey] = (envObj as Record<string, string>)[envKey] || ''
      }
    }
    setDraftEnvFields(fields)
    // existingCandidates 必须进 deps：候选异步从 react-query 拉，初次渲染时
    // 可能为空，后续 fulfilled 后此 effect 重跑修正默认模式。
  }, [open, skill, skillConfigs, existingCandidates])

  if (!skill) return null

  const skillName = resolveSkillDisplayName(skill)
  const skillKey = skill.skill_key || ''
  const hasPrimaryEnv = Boolean(skill.primary_env)
  const source = normalizeSkillSource(skill.source)
  const isFullConfig = source === 'user'
  const isBuiltin = isBuiltinCatalogSkill(skill)
  /** Env vars declared in requires.env that are NOT the primary_env (handled separately) */
  const requiredEnvKeys = (skill.requires?.env || []).filter(
    (e) => e !== skill.primary_env
  )

  /**
   * 手动输入路径：先创建凭据，拿到 id 再绑到 SkillConfig。
   *
   * 失败时把 toast 直接抛出，外层 handleSave 不再写 SkillConfig 避免出现
   * "凭据没建成功但 Skill 配置还是 dirty"的中间态。
   */
  const createCredentialFromManualKey = async (): Promise<string | null> => {
    const trimmed = manualApiKey.trim()
    if (!trimmed) return null
    const inferredService = inferServiceNameFromPrimaryEnv(skill.primary_env) || 'custom'
    const serviceName = inferredService
    const display = resolveSkillDisplayName(skill) || skillKey || serviceName
    try {
      const result = await apiClient.post<{ id: string }>('/credential-vault/create', {
        category: 'api_key',
        service_name: serviceName,
        display_name: t('skills.credentialAutoCreateDisplayName', {
          defaultValue: '{{service}} (来自 Skill：{{skillName}})',
          service: inferredService,
          skillName: display,
        }),
        credential_data: { api_key: trimmed },
      })
      const newId = (result.data as any)?.id
      if (!newId) {
        toast({
          title: t('skills.configSaveFailedTitle'),
          description: t('skills.credentialCreateFailedNoId', {
            defaultValue: '创建凭据失败：服务端未返回 id',
          }),
          variant: 'destructive',
        })
        return null
      }
      // 让"使用已有"列表立即看到新建的密钥
      void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
      return newId
    } catch (err: any) {
      toast({
        title: t('skills.configSaveFailedTitle'),
        description: err?.message || String(err),
        variant: 'destructive',
      })
      return null
    }
  }

  const handleSave = async () => {
    // Validate JSON fields
    let parsedEnv: Record<string, string> | undefined
    let parsedConfig: Record<string, unknown> | undefined

    if (draftEnv.trim()) {
      try {
        parsedEnv = JSON.parse(draftEnv)
      } catch {
        toast({
          title: t('skills.configSaveFailedTitle'),
          description: `${t('skills.configEnvSection')}: invalid JSON`,
          variant: 'destructive',
        })
        return
      }
    }

    if (draftConfig.trim()) {
      try {
        parsedConfig = JSON.parse(draftConfig)
      } catch {
        toast({
          title: t('skills.configSaveFailedTitle'),
          description: `${t('skills.configSection')}: invalid JSON`,
          variant: 'destructive',
        })
        return
      }
    }

    // For system/market skills: merge individual env fields into env payload
    if (!isFullConfig && requiredEnvKeys.length > 0) {
      const merged: Record<string, string> = { ...(parsedEnv || {}) }
      for (const [k, v] of Object.entries(draftEnvFields)) {
        if (v.trim()) merged[k] = v.trim()
      }
      if (Object.keys(merged).length > 0) {
        parsedEnv = merged
      }
    }

    // Resolve credential_id based on mode (only matters for hasPrimaryEnv skills)
    //
    // Wave 5b S2 PRD 5.4：
    //   - existing：用 dropdown 选中的 id（缺省=空串=解绑）
    //   - manual：手动输入了 → 先建凭据再绑；空白 → 不变更（undefined）
    //
    // undefined 在 update payload 里表示"不修改 credential_id 字段"，
    // 与 SkillConfigUpdatePayload 的 docstring 一致——避免误清空已有绑定。
    let credentialIdToSave: string | undefined
    if (hasPrimaryEnv) {
      if (credentialMode === 'existing') {
        credentialIdToSave = draftCredentialId || ''
      } else {
        // manual 模式
        if (manualApiKey.trim()) {
          const newId = await createCredentialFromManualKey()
          if (!newId) {
            return // create 失败 toast 已提示，不继续保存 SkillConfig
          }
          credentialIdToSave = newId
        } else {
          // 空白手动输入：保持现状不动（避免误清空已有绑定）
          credentialIdToSave = undefined
        }
      }
    }

    setSaving(true)
    // Wave 5b 视角 3#4 自修：补 try/catch + 失败 toast。
    // mutation throw（网络中断 / 后端 500）原本会冒泡，按钮卡在"保存中..."无任何反馈；
    // dialog 不闭合，用户 stuck。这条与 S3 / S4a / S4b / S5 的失败处理范式对齐。
    try {
      const success = await updateConfigMutation.mutateAsync({
        organization_id: organizationId,
        agent_id: selectedAgentId,
        skill_key: skillKey,
        enabled: isBuiltin ? undefined : draftEnabled,
        credential_id: credentialIdToSave,
        env: parsedEnv,
        config: parsedConfig,
      })

      if (success) {
        // Wave 5b 视角 2#3 自修：手动输入路径下凭据已写入全局保险箱，
        // 但用户没在 UI 上看到 side effect。toast description 显式告知，避免下次
        // 在另一个 Agent 配置同 service Skill 时看到"凭一空降的密钥"产生困惑。
        const isManualMode =
          credentialMode === 'manual' && manualApiKey.trim().length > 0
        const description = isManualMode
          ? t('skills.configSavedDescriptionManual', {
              skillName,
              defaultValue:
                '{{skillName}} 配置已保存。密钥已保存，下次同 service 可直接选。',
            })
          : t('skills.configSavedDescription', { skillName })
        toast({
          title: t('skills.configSavedTitle'),
          description,
        })
        onOpenChange(false)
      } else {
        toast({
          title: t('skills.configSaveFailedTitle'),
          description: t('skills.configSaveFailedDescription'),
          variant: 'destructive',
        })
      }
    } catch (err: any) {
      // 网络 / 后端异常路径——dialog 保持打开让用户重试或取消
      toast({
        title: t('skills.configSaveFailedTitle'),
        description: err?.message || t('skills.configSaveFailedDescription'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={skill.emoji ? <span className="text-title leading-none">{skill.emoji}</span> : <Settings className="h-7 w-7" />}
          title={t('skills.configTitle', { skillName })}
          description={t('skills.configDescription')}
        />

        <ScrollArea className="flex-1"><div className="space-y-5 py-2 pr-1">
          {!isBuiltin ? (
            <div className="flex items-center justify-between">
              <Label className="text-body font-medium">{t('skills.configEnabled')}</Label>
              <Switch checked={draftEnabled} onCheckedChange={setDraftEnabled} />
            </div>
          ) : null}

          {/* Wave 5b S2：凭据选择器（PRD 5.4） */}
          {hasPrimaryEnv ? (
            <SkillCredentialPicker
              primaryEnv={skill.primary_env}
              mode={credentialMode}
              onModeChange={setCredentialMode}
              selectedCredentialId={draftCredentialId}
              onSelectedCredentialIdChange={setDraftCredentialId}
              manualKey={manualApiKey}
              onManualKeyChange={setManualApiKey}
              onCloseDialog={() => onOpenChange(false)}
            />
          ) : null}

          {/* Per-key env fields — system/market skills with requires.env */}
          {!isFullConfig && requiredEnvKeys.length > 0 ? (
            <div className="space-y-3">
              <Label className="text-body font-medium">{t('skills.configEnvSection')}</Label>
              {/* Wave 5b 视角 1#2 P0 自修：明示空头承诺
                  ----
                  这些字段当前只写入 SkillConfig.env，eligibility 检查会看 keys 但不看 values；
                  运行时密钥注入路径（`packages/agent-runtime/src/tools/core-tools.ts` →
                  skill-credential-resolver → POST /skill-reveal）**完全不读** SkillConfig.env，
                  只用 credential_id 派生 env。等价于"用户填了但 Agent 跑不起来"。
                  Wave 5c 进 L-W5b-2：要么把 SkillConfig.env 接到 child env（注意 redact），
                  要么改用 dual-key credential 表单替代这种"双字段"输入。
                  本期先警告诚实告知。 */}
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-body text-foreground/80">
                ⚠️{' '}
                {t('skills.configEnvFieldsWarning', {
                  defaultValue:
                    '此区域的字段当前**不会**注入到 Skill 子进程。请通过上面的「凭据选择器」绑定凭据；多字段凭据暂不支持在这里创建。',
                })}
              </div>
              {requiredEnvKeys.map((envKey) => (
                <div key={envKey} className="space-y-1">
                  <Label className="text-body text-muted-foreground font-mono">{envKey}</Label>
                  <Input
                    type="password"
                    value={draftEnvFields[envKey] || ''}
                    onChange={(e) =>
                      setDraftEnvFields((prev) => ({ ...prev, [envKey]: e.target.value }))
                    }
                    placeholder={`Enter ${envKey}`}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {/* Environment Variables (JSON) — only for user-source skills */}
          {isFullConfig ? (
            <div className="space-y-2">
              <Label className="text-body font-medium">{t('skills.configEnvSection')}</Label>
              <Textarea
                className="font-mono text-body min-h-[80px]"
                value={draftEnv}
                onChange={(e) => setDraftEnv(e.target.value)}
                placeholder='{ "KEY": "value" }'
              />
            </div>
          ) : null}

          {/* Custom Config (JSON) — only for user-source skills */}
          {isFullConfig ? (
            <div className="space-y-2">
              <Label className="text-body font-medium">{t('skills.configSection')}</Label>
              <Textarea
                className="font-mono text-body min-h-[80px]"
                value={draftConfig}
                onChange={(e) => setDraftConfig(e.target.value)}
                placeholder='{ "option": "value" }'
              />
            </div>
          ) : null}
        </div></ScrollArea>

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
