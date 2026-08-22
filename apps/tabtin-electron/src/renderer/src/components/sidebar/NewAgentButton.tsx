/**
 * NewAgentButton / NewAgentDialog — 侧边栏「新建 Agent」入口（ 第一批）。
 *
 * 产品语义：用户招一位新的 AI 同事——挑一个精品模板实例化（不占自建配额），
 * 或从空白自建（配额上限 5）。创建成功后只选中该 Agent；不建/切 Workspace，
 * 也不自动开草稿会话（与 principle 解耦口径一致）。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Plus, RotateCcw, Sparkles, UserPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogScrollBody,
  Input,
  Button as UIButton,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { AgentTemplateIcon } from './AgentTemplateIcon'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { cn } from '@utils/cn'
import { provisionBotAgent } from '@/services/agentProvision'
import {
  listAgentTemplates,
  type AgentTemplate,
} from '@/services/agentTemplatesApi'
import type { Agent } from '@tabtin/app-shell'
import {
  AGENT_AVATAR_PRESET_KEYS,
  DEFAULT_AGENT_AVATAR_PRESET_KEY,
  resolveAgentAvatarPresetUrl,
} from '@/constants/agentAvatarPresets'

interface NewAgentButtonProps {
  className?: string
}

export const NewAgentButton: React.FC<NewAgentButtonProps> = ({ className }) => {
  const { t } = useTranslation('space')
  const [open, setOpen] = useState(false)

  const label = t('agentCreate.entryTooltip', { defaultValue: '新建 AI 分身' })
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'h-6 w-6 rounded-md text-muted-foreground/80 hover:text-foreground hover:bg-accent/10 transition-colors flex items-center justify-center',
          className,
        )}
        title={label}
        aria-label={label}
      >
        <Plus className="h-4 w-4" />
      </button>
      <NewAgentDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export interface NewAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 显式创建到该组织；会话内入口必须传入 session.organization_id。 */
  organizationId?: string | null
  /** 开号成功后由父组件负责选中身份（含会话 agent_id 同步等）。 */
  onAgentCreated?: (agent: Agent) => void | Promise<void>
}

/** selectedTemplateId 为 null = 从空白自建（占自建配额）。 */
export const NewAgentDialog: React.FC<NewAgentDialogProps> = ({
  open,
  onOpenChange,
  organizationId,
  onAgentCreated,
}) => {
  const { t } = useTranslation(['space', 'common'])
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [selectedAvatarKey, setSelectedAvatarKey] = useState<string | null>(DEFAULT_AGENT_AVATAR_PRESET_KEY)
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError(false)
    try {
      const loadedTemplates = await listAgentTemplates()
      setTemplates(loadedTemplates)
      setSelectedAvatarKey(current => current
        ?? loadedTemplates.find(template => template.id === 'general-assistant')?.avatar_key
        ?? loadedTemplates.find(template => template.avatar_key)?.avatar_key
        ?? null)
    } catch (error) {
      console.warn('[NewAgent] 模板列表加载失败:', error)
      setTemplatesError(true)
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      // 关窗时清掉创建态，避免受控 Dialog 在 isCreating=true 时拒绝 onOpenChange(false)
      // 出现「关掉又弹回、再也关不掉」。
      setIsCreating(false)
      return
    }
    setSelectedTemplateId(null)
    // 本地固定旧版日常头像为默认值，不依赖模板接口速度或可用性。
    setSelectedAvatarKey(DEFAULT_AGENT_AVATAR_PRESET_KEY)
    setName('')
    void loadTemplates()
  }, [open, loadTemplates])

  const getTemplateDisplayName = useCallback(
    (template: AgentTemplate) => template.name,
    [],
  )

  const handlePickTemplate = useCallback((template: AgentTemplate | null) => {
    setSelectedTemplateId(template?.id ?? null)
    if (template?.avatar_key) {
      setSelectedAvatarKey(template.avatar_key)
    }
    setName(prev => {
      // 名字未被用户改过（为空或还是上一个模板展开名）时跟随模板预填
      const untouched = !prev.trim() || templates.some(item => getTemplateDisplayName(item) === prev)
      return untouched ? (template ? getTemplateDisplayName(template) : '') : prev
    })
  }, [templates, getTemplateDisplayName])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isCreating) return

    setIsCreating(true)
    try {
      const result = await provisionBotAgent({
        organizationId: organizationId ?? undefined,
        name: trimmedName,
        templateId: selectedTemplateId ?? undefined,
        avatarKey: selectedAvatarKey ?? undefined,
        // API 一成功就关窗，避免受控 Dialog 被后续 store 更新卡住。
        onCreated: () => onOpenChange(false),
      })
      if (result.ok && result.agent) {
        await onAgentCreated?.(result.agent)
      }
    } finally {
      setIsCreating(false)
    }
  }

  const templateCardClass = (active: boolean) => cn(
    'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
    active
      ? 'border-accent bg-accent/10'
      : 'border-border/40 bg-muted/10 hover:border-accent/40 hover:bg-accent/5',
  )

  // open=false 时必须卸载整棵 Dialog：container={null} 把 Portal 挂到 document.body，
  // 会逃出 SpaceChatRailHost 的 <Activity hidden>。若只靠 Radix Presence 退场动画，
  // 动画可能卡在 data-state=closed 且仍 opacity:1 / pointer-events:auto，形成关不掉的幽灵层。
  if (!open) {
    return null
  }

  return (
    // 与 CreateSpaceDialog 一致：不在创建中拦截 onOpenChange。
    <Dialog open onOpenChange={onOpenChange}>
      {/* container={null}：创建 Agent 是全局流程，不受画布区 scoped overlay 限制。 */}
      <DialogContent
        container={null}
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <ContextDialogHeader
            className="px-0 pt-0"
            icon={<UserPlus className="h-7 w-7" />}
            title={t('agentCreate.title', { ns: 'space', defaultValue: '新建 AI 分身' })}
            description={t('agentCreate.description', {
              ns: 'space',
              defaultValue: '挑一个模板快速开始，或从空白创建你自己的 AI 分身。',
            })}
          />
          <DialogScrollBody className="space-y-4 py-4">
            <div className="space-y-2">
              <span className="text-body font-medium">
                {t('agentCreate.templateSectionTitle', { ns: 'space', defaultValue: '从模板开始' })}
              </span>
              {templatesLoading ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-3 text-caption text-muted-foreground/60">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('agentCreate.templatesLoading', { ns: 'space', defaultValue: '正在加载模板…' })}
                </div>
              ) : templatesError ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5">
                  <span className="text-caption text-muted-foreground/60">
                    {t('agentCreate.templatesLoadFailed', { ns: 'space', defaultValue: '模板加载失败' })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { void loadTemplates() }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-muted-foreground/60 transition-colors hover:text-foreground"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('agentCreate.templatesRetry', { ns: 'space', defaultValue: '重试' })}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((template) => {
                    const active = selectedTemplateId === template.id
                    const avatarUrl = resolveAgentAvatarPresetUrl(template.avatar_key)
                    return (
                      <button
                        key={template.id}
                        type="button"
                        disabled={isCreating}
                        onClick={() => handlePickTemplate(active ? null : template)}
                        className={templateCardClass(active)}
                        aria-pressed={active}
                      >
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt=""
                            className="h-10 w-10 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <AgentTemplateIcon icon={template.icon} className="h-3.5 w-3.5 shrink-0 text-accent" />
                        )}
                        <span className="flex min-w-0 flex-col items-start gap-1 text-body font-medium">
                          <span className="truncate">{getTemplateDisplayName(template)}</span>
                          {template.tagline ? (
                            <span className="line-clamp-2 text-caption font-normal text-muted-foreground/60">
                              {template.tagline}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    disabled={isCreating}
                    onClick={() => handlePickTemplate(null)}
                    className={templateCardClass(selectedTemplateId === null)}
                    aria-pressed={selectedTemplateId === null}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10">
                      <Sparkles className="h-4 w-4 text-accent" aria-hidden />
                    </span>
                    <span className="flex min-w-0 flex-col items-start gap-1 text-body font-medium">
                      <span className="truncate">
                        {t('agentCreate.blank', { ns: 'space', defaultValue: '从空白创建' })}
                      </span>
                      <span className="line-clamp-2 text-caption font-normal text-muted-foreground/60">
                        {t('agentCreate.blankHint', { ns: 'space', defaultValue: '不用模板，一切由你定义' })}
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
            {selectedTemplateId === null ? (
              <div className="space-y-2">
                <span id="new-agent-avatar-label" className="text-body font-medium">
                  {t('agentCreate.avatarLabel', { ns: 'space', defaultValue: '头像' })}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="new-agent-avatar-label"
                  className="flex flex-wrap gap-2"
                >
                  {AGENT_AVATAR_PRESET_KEYS.map((avatarKey) => {
                    const avatarUrl = resolveAgentAvatarPresetUrl(avatarKey)
                    if (!avatarUrl) return null
                    const active = selectedAvatarKey === avatarKey
                    const avatarLabel = t(`agentAvatarPresets.${avatarKey}`, {
                      ns: 'common',
                      defaultValue: avatarKey,
                    })
                    return (
                      <label
                        key={avatarKey}
                        title={avatarLabel}
                        className={cn(
                          'relative h-11 w-11 shrink-0 cursor-pointer rounded-full border p-0.5 transition-colors',
                          active
                            ? 'border-accent bg-accent/10'
                            : 'border-border/60 hover:border-accent/60',
                          isCreating && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        <input
                          type="radio"
                          name="new-agent-avatar"
                          value={avatarKey}
                          checked={active}
                          aria-label={avatarLabel}
                          disabled={isCreating}
                          onChange={() => setSelectedAvatarKey(avatarKey)}
                          className="peer sr-only"
                        />
                        <img
                          src={avatarUrl}
                          alt=""
                          className="h-full w-full rounded-full object-cover peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
                        />
                        {active ? (
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-foreground">
                            <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                          </span>
                        ) : null}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <label htmlFor="new-agent-name" className="text-body font-medium">
                {t('agentCreate.nameLabel', { ns: 'space', defaultValue: '名字' })}
              </label>
              <Input
                id="new-agent-name"
                value={name}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
                placeholder={t('agentCreate.namePlaceholder', { ns: 'space', defaultValue: '给这位 AI 同事起个名字' })}
                maxLength={100}
                disabled={isCreating}
                autoFocus
              />
            </div>
          </DialogScrollBody>
          <DialogFooter className="gap-2">
            <UIButton
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('cancel', { ns: 'common', defaultValue: '取消' })}
            </UIButton>
            <UIButton
              type="submit"
              disabled={isCreating || !name.trim()}
              className="bg-accent hover:bg-accent/90"
            >
              {isCreating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              {t('agentCreate.create', { ns: 'space', defaultValue: '创建' })}
            </UIButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
