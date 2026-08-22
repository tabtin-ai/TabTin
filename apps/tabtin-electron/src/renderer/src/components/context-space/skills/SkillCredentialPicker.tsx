import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
/**
 * Wave 5b S2 — Skill 凭据选择器（PRD 5.4）
 *
 * 解决 Wave 1.5 的"配一次全 Agent 用"在 UI 层完全没兑现的断点：
 *   旧 UI 让用户对着裸密码输入框敲，每个 Agent 重复一遍；新 UI 让用户从
 *   凭据保险箱里选已存的 API Key，没有的话现场建一条并自动绑定 credential_id。
 *
 * 设计要点：
 *   1. **默认推 Radio 选择**：使用已有 / 手动输入，避免裸输入框暗示用户重新录入
 *   2. **service_name 推断**：从 skill.primary_env 反推 service_name（OPENAI_API_KEY → openai）
 *      - 在映射表内：默认按 service_name 过滤候选
 *      - 不在映射表内：fallback 列出全部 api_key 凭据让用户选
 *   3. **空状态**：该 service 一个凭据都没 → 提示用户没有可用密钥；跳转入口跟随设置可见性
 *   4. **手动输入路径**：保存时主进程逻辑会先 POST /credential-vault/create 拿到
 *      credential_id，再写到 SkillConfig（避免明文 api_key 走 SkillConfig 的旧路径）
 *
 * 受控组件（state 由父级 SkillConfigDialog 维护）：
 *   - mode：'existing' | 'manual'
 *   - selectedCredentialId：当前选中的凭据 id
 *   - manualKey：手动输入的密码
 */
import React, { useMemo } from 'react'
import { Loader2, Plus } from 'lucide-react'
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useApiKeyCredentialsQuery } from '@/hooks/queries/credentials'
import type { CredentialItem } from '@/components/settings/panels/credentials/types'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { isSettingsSectionVisible } from '@/settings/settingsVisibility'

/**
 * primary_env → service_name 映射。
 *
 * **只列单字段服务**：openai / anthropic / serper —— 这几个的 manual 模式
 * 一行 api_key 输入框就能创建出可用凭据。
 *
 * 多字段服务（需要 app_id + app_secret 等多个字段）不应进入此表：单字段
 * manual 路径只把单一输入写到 `{api_key: trimmed}`，命中映射表后产出的
 * service_name 在后端派生时会找不到对应字段 → 422 ENV_DERIVATION_FAILED。
 * 这类服务的 SKILL.md `primary_env` 在表中找不到时，inferredService = undefined
 * → 列出全部 api_key 凭据让用户兜底选；多字段凭据需先录入后再回来选。
 *
 * 长期方案进 L-W5b-3：`GET /credential-vault/skill-services` 端点让前端启动时
 * 拉取，避免双点维护漂移。
 */
const PRIMARY_ENV_TO_SERVICE: Record<string, string> = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  SERPER_API_KEY: 'serper',
}

/**
 * 服务展示名映射：内部 service_name 是小写 ID（如 `openai`），UI 直接拼成
 * "未找到 openai 密钥" 显得粗糙；查表显示为 BrandCase（如 "OpenAI"）更友好。
 */
const SERVICE_DISPLAY_NAME: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  serper: 'Serper',
}

export function inferServiceNameFromPrimaryEnv(
  primaryEnv: string | undefined,
): string | undefined {
  if (!primaryEnv) return undefined
  return PRIMARY_ENV_TO_SERVICE[primaryEnv]
}

export function getServiceDisplayName(serviceName: string | undefined): string | undefined {
  if (!serviceName) return undefined
  return SERVICE_DISPLAY_NAME[serviceName] ?? serviceName
}

export type CredentialPickerMode = 'existing' | 'manual'

export interface SkillCredentialPickerProps {
  primaryEnv: string | undefined
  /** 当前模式：使用已有 vs 手动输入。 */
  mode: CredentialPickerMode
  onModeChange: (mode: CredentialPickerMode) => void
  /** 当前选中的 credential_id（mode='existing' 时生效）。 */
  selectedCredentialId: string
  onSelectedCredentialIdChange: (id: string) => void
  /** 手动输入的密钥（mode='manual' 时生效）。 */
  manualKey: string
  onManualKeyChange: (key: string) => void
  /** 关闭外层 Dialog（用户点外部凭据设置入口时调用）。 */
  onCloseDialog: () => void
}

function maskedDataPreview(item: CredentialItem): string {
  const values = Object.values(item.masked_data || {})
  if (values.length === 0) return ''
  return values[0] || ''
}

function credentialDisplayLabel(item: CredentialItem): string {
  const masked = maskedDataPreview(item)
  const name = item.display_name || item.service_name
  if (masked) return `${name} (${masked})`
  return name
}

export const SkillCredentialPicker: React.FC<SkillCredentialPickerProps> = ({
  primaryEnv,
  mode,
  onModeChange,
  selectedCredentialId,
  onSelectedCredentialIdChange,
  manualKey,
  onManualKeyChange,
  onCloseDialog,
}) => {
  const { t } = useTranslation('context')
  const inferredService = useMemo(
    () => inferServiceNameFromPrimaryEnv(primaryEnv),
    [primaryEnv],
  )
  const displayServiceName = useMemo(
    () => getServiceDisplayName(inferredService),
    [inferredService],
  )

  const { data: candidates = [], isLoading } = useApiKeyCredentialsQuery({
    serviceName: inferredService,
  })
  const canOpenCredentialSettings = isSettingsSectionVisible('profile', 'credentials-ai')

  const handleOpenLoginsAndKeys = () => {
    onCloseDialog()
    // 跳到「凭据 · AI 服务」tab，与 Skill 实际使用的 service key 直接对应。
    // 当前该设置页被隐藏时，触发按钮不会渲染。
    useSettingsSpaceStore
      .getState()
      .openSettings({ category: 'profile', section: 'credentials-ai' })
  }

  const hasCandidates = candidates.length > 0

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <Label className="text-body font-medium">
        {t('skills.configApiKey')}
        {primaryEnv ? (
          <span className="ml-1 text-body text-muted-foreground font-normal">
            ({primaryEnv})
          </span>
        ) : null}
      </Label>

      {/* 选择模式：使用已有 vs 手动输入 */}
      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="credential-mode"
            value="existing"
            checked={mode === 'existing'}
            onChange={() => onModeChange('existing')}
            className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent"
          />
          <div className="flex-1 space-y-1.5">
            <div className="text-body">
              {t('skills.credentialUseExisting', { defaultValue: '使用已有密钥' })}
            </div>
            {mode === 'existing' && (
              <div>
                {isLoading ? (
                  <div className="flex items-center gap-2 text-body text-muted-foreground/60">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('skills.credentialLoading', { defaultValue: '加载中...' })}
                  </div>
                ) : hasCandidates ? (
                  <Select
                    value={selectedCredentialId || undefined}
                    onValueChange={onSelectedCredentialIdChange}
                  >
                    <SelectTrigger className="w-full h-8 text-body">
                      <SelectValue
                        placeholder={t('skills.credentialPickerPlaceholder', {
                          defaultValue: '选择一个密钥',
                        })}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {credentialDisplayLabel(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="rounded-md bg-muted/30 px-2.5 py-2 text-body text-muted-foreground/80">
                    {inferredService
                      ? t('skills.credentialEmptyForService', {
                          defaultValue: '未找到 {{service}} 密钥',
                          service: displayServiceName ?? inferredService,
                        })
                      : t('skills.credentialEmptyAll', {
                          defaultValue: '还没有可用 API Key',
                        })}
                    {canOpenCredentialSettings ? (
                      <button
                        type="button"
                        className="ml-2 text-body text-accent hover:text-accent/80 transition-colors inline-flex items-center gap-1"
                        onClick={handleOpenLoginsAndKeys}
                      >
                        <Plus className="h-3 w-3" />
                        {t('skills.credentialAddInVault', {
                          defaultValue: '去添加',
                        })}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="credential-mode"
            value="manual"
            checked={mode === 'manual'}
            onChange={() => onModeChange('manual')}
            className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent"
          />
          <div className="flex-1 space-y-1.5">
            <div className="text-body">
              {t('skills.credentialUseManual', { defaultValue: '手动输入新密钥' })}
            </div>
            {mode === 'manual' && (
              // 明示阻止浏览器密码管理器 / 1Password 等扩展对该字段做缓存——
              // 这是高敏感物料，不应进入浏览器自动填充候选。
              <Input
                type="password"
                value={manualKey}
                onChange={(e) => onManualKeyChange(e.target.value)}
                placeholder={t('skills.configApiKeyPlaceholder')}
                className="text-body"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
              />
            )}
          </div>
        </label>
      </div>

      <div className={CANVAS_TEXT_META}>
        💡{' '}
        {t('skills.credentialSharedHint', {
          defaultValue:
            '密钥会加密保存，并可被配置了凭据的 Agent 复用。手动输入的密钥也会自动加入，避免重复配置。',
        })}
      </div>
    </div>
  )
}
