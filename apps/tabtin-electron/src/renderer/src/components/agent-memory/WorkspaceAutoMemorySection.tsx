import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Switch, toast } from '@tabtin/smartsheet-ui'
import { SettingsInfoTooltip } from '@/components/settings/SettingsInfoTooltip'
import {
  AgentMemoryApi,
  type WorkspaceMemoryModel,
  type WorkspaceMemoryProviderScope,
  type WorkspaceMemorySettings,
  type WorkspaceMemoryUnavailableModel,
} from '@/services/agentMemoryApi'

interface WorkspaceAutoMemorySectionProps {
  organizationId: string
  embedded?: boolean
}

const INVALID_EXPLICIT_MODEL = 'invalid_explicit_model'

const GROUPS: Array<{ scope: WorkspaceMemoryProviderScope; label: string }> = [
  { scope: 'global', label: 'TabTin 官方' },
  { scope: 'user', label: '我的模型' },
  { scope: 'organization', label: '组织模型' },
]

export const WorkspaceAutoMemorySection: React.FC<WorkspaceAutoMemorySectionProps> = ({
  organizationId,
  embedded = false,
}) => {
  const [settings, setSettings] = useState<WorkspaceMemorySettings | null>(null)
  const [models, setModels] = useState<WorkspaceMemoryModel[]>([])
  const [unavailableModels, setUnavailableModels] = useState<WorkspaceMemoryUnavailableModel[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingEnable, setPendingEnable] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!organizationId) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    setLoadFailed(false)
    setSettings(null)
    setModels([])
    setUnavailableModels([])
    setPendingEnable(false)
    try {
      const [nextSettings, catalog] = await Promise.all([
        AgentMemoryApi.getWorkspaceMemorySettings(organizationId),
        AgentMemoryApi.listWorkspaceMemoryModels(organizationId),
      ])
      if (requestIdRef.current !== requestId) return
      setSettings(nextSettings)
      setModels(catalog.items)
      setUnavailableModels(catalog.unavailable_items ?? [])
    } catch {
      if (requestIdRef.current !== requestId) return
      setLoadFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  // 后端继续兼容旧客户端的 official_default；新客户端只把具体模型 UUID 视为可启用配置。
  const currentExplicitModelAvailable = useMemo(() => {
    if (settings?.memory_model_mode !== 'explicit_model') return false
    const exactId = settings.memory_model?.id
    return Boolean(exactId && models.some(model => model.id === exactId))
  }, [models, settings])

  const selectedValue = currentExplicitModelAvailable
    ? settings?.memory_model?.id ?? INVALID_EXPLICIT_MODEL
    : INVALID_EXPLICIT_MODEL
  const explicitModelNeedsReselection =
    settings?.memory_model_mode === 'explicit_model' && !currentExplicitModelAvailable
  const effectiveAutoMemoryEnabled = Boolean(settings?.auto_memory_enabled || pendingEnable)

  const update = async (
    patch: Parameters<typeof AgentMemoryApi.updateWorkspaceMemorySettings>[1],
  ): Promise<boolean> => {
    if (!settings?.can_update || saving) return false
    setSaving(true)
    try {
      const updated = await AgentMemoryApi.updateWorkspaceMemorySettings(organizationId, patch)
      setSettings(updated)
      return true
    } catch {
      toast.error('自动记忆设置保存失败，请重试')
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (enabled: boolean): void => {
    if (!settings) return
    if (enabled && !currentExplicitModelAvailable) {
      setPendingEnable(true)
      return
    }
    if (!enabled && pendingEnable && !settings.auto_memory_enabled) {
      setPendingEnable(false)
      return
    }
    setPendingEnable(false)
    void update({ auto_memory_enabled: enabled })
  }

  const handleModelChange = async (modelId: string): Promise<void> => {
    if (!settings || modelId === INVALID_EXPLICIT_MODEL) return
    const shouldEnable = pendingEnable && !settings.auto_memory_enabled
    const updated = await update({
      ...(shouldEnable ? { auto_memory_enabled: true } : {}),
      memory_model_mode: 'explicit_model',
      memory_model_id: modelId,
    })
    if (updated) setPendingEnable(false)
  }

  if (loading) {
    return (
      <section className={`flex items-center gap-2 text-body text-muted-foreground${embedded ? '' : ' border-t border-border/20 pt-5'}`}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在读取自动记忆设置…
      </section>
    )
  }

  if (loadFailed || !settings) {
    return (
      <section className={`flex flex-col gap-2${embedded ? '' : ' border-t border-border/20 pt-5'}`}>
        <span className="text-caption font-medium text-muted-foreground/80">自动记忆增强</span>
        <p className="text-body text-destructive">自动记忆设置读取失败</p>
        <button type="button" className="w-fit text-body text-accent hover:underline" onClick={() => void load()}>
          重新读取
        </button>
      </section>
    )
  }

  return (
    <section className={`flex flex-col gap-3${embedded ? '' : ' border-t border-border/20 pt-5'}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className="text-body font-medium text-foreground">自动记忆增强</h3>
          <SettingsInfoTooltip
            label="自动记忆增强说明"
            content="开启后，系统会自动整理工作记忆，并生成日记与画像。使用 TabTin 官方模型时将额外消耗点券；使用自有模型时不消耗 TabTin 点券，相关费用由模型服务商收取。"
          />
        </div>
        <Switch
          aria-label="自动记忆增强"
          checked={effectiveAutoMemoryEnabled}
          disabled={!settings.can_update || saving}
          onCheckedChange={handleToggle}
        />
      </div>

      {!settings.can_update && (
        <p className="text-caption text-muted-foreground">仅组织 Owner 可以修改，成员可查看当前设置。</p>
      )}

      {(effectiveAutoMemoryEnabled || !currentExplicitModelAvailable) && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workspace-memory-model" className="text-caption font-medium text-muted-foreground/80">
            记忆模型
          </label>
          <select
            id="workspace-memory-model"
            aria-label="记忆模型"
            value={selectedValue}
            disabled={!settings.can_update || saving || !effectiveAutoMemoryEnabled}
            onChange={event => {
              void handleModelChange(event.target.value)
            }}
            className="h-9 rounded-md border border-border/40 bg-background px-3 text-body text-foreground focus:border-accent/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!currentExplicitModelAvailable && (
              <option value={INVALID_EXPLICIT_MODEL} disabled>
                {explicitModelNeedsReselection ? '记忆模型需要重新选择' : '请选择记忆模型'}
              </option>
            )}
            {GROUPS.map(group => {
              const groupModels = models.filter(model => model.provider_scope === group.scope)
              if (groupModels.length === 0) return null
              return (
                <optgroup key={group.scope} label={group.label}>
                  {groupModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.display_name} · {model.provider_display_name}
                    </option>
                  ))}
                </optgroup>
              )
            })}
            {GROUPS.map(group => {
              const groupModels = unavailableModels.filter(model => model.provider_scope === group.scope)
              if (groupModels.length === 0) return null
              return (
                <optgroup key={`${group.scope}-unavailable`} label={`${group.label}（暂不可用）`}>
                  {groupModels.map(model => (
                    <option key={model.id} value={`unavailable:${model.id}`} disabled>
                      {model.display_name} · {model.provider_display_name} · 暂不支持自动记忆
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
          {explicitModelNeedsReselection && (
            <p role="alert" className="text-caption text-amber-500">记忆模型需要重新选择</p>
          )}
        </div>
      )}
    </section>
  )
}

export default WorkspaceAutoMemorySection
