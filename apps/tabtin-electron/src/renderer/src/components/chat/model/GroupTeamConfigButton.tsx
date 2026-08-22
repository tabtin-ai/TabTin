/**
 * GroupTeamConfigButton — group 模式「团队配置」入口（ Phase 2）。
 *
 * 输入框工具栏里的一个按钮，仅 group 模式显示。点开后列出当前 Space 已配置的子
 * Agent 模板角色，用户勾选「本会话参与协作的角色」→ PUT 会话 group_runtime.roles。
 * 保存后（激活 + 有 roles）主 Agent 的 <subagent_catalog> 与可解析模板都会收敛到
 * 所选子集（host 侧 sessionGroupRoleIds 生效，下一次发消息重建 runtime 时读取）。
 *
 * 不勾任何角色 / 全关 → 保存为 enabled:false → 会话回落 Space 全量模板。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Switch,
  Button,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { COMPOSER_TOOLBAR_BUTTON, COMPOSER_TOOLBAR_ICON_CLASS, COMPOSER_TOOLBAR_ICON_STROKE } from '../registry/chatDesignTokens'
import { SubAgentTemplateApi, type SubAgentTemplate } from '@/services/subagentTemplateApi'
import { getSessionContext, updateSessionGroupRuntime } from '@/services/chatExtraApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('GroupTeamConfig')

interface GroupTeamConfigButtonProps {
  spaceId: string
  sessionId: string
  disabled?: boolean
}

export const GroupTeamConfigButton: React.FC<GroupTeamConfigButtonProps> = ({ spaceId, sessionId, disabled }) => {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<SubAgentTemplate[]>([])
  // 本会话已启用的 template_id 集合（勾选态）。
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [items, ctx] = await Promise.all([
        SubAgentTemplateApi.list(spaceId),
        getSessionContext(sessionId),
      ])
      setTemplates(items.filter(t => t.is_enabled !== false))
      const gr = ctx.group_runtime
      const enabledIds = gr && gr.is_active
        ? new Set(
            (gr.roles ?? [])
              .filter(r => r.enabled !== false && !!r.template_id)
              .map(r => r.template_id),
          )
        : new Set<string>()
      setSelected(enabledIds)
    } catch (err) {
      log.error('加载团队配置失败', { spaceId, sessionId }, err)
      toast({ title: t('subagent.team.loadError', { defaultValue: '加载团队配置失败' }), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [spaceId, sessionId, t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const toggle = useCallback((id: string, on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const roles = templates.map(tpl => ({ template_id: tpl.id, enabled: selected.has(tpl.id) }))
      const anyEnabled = roles.some(r => r.enabled)
      await updateSessionGroupRuntime(sessionId, { enabled: anyEnabled, roles })
      toast({ title: t('subagent.team.saved', { defaultValue: '团队配置已保存，下一条消息生效' }) })
      setOpen(false)
    } catch (err) {
      log.error('保存团队配置失败', { sessionId, roleCount: templates.length, enabledCount: selected.size }, err)
      toast({ title: t('subagent.team.saveError', { defaultValue: '保存团队配置失败' }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [templates, selected, sessionId, t])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ChatIconTooltip content={t('subagent.team.entry', { defaultValue: '团队配置（选择协作子 Agent）' })}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(COMPOSER_TOOLBAR_BUTTON, disabled && 'opacity-40 cursor-not-allowed')}
            aria-label={t('subagent.team.entry', { defaultValue: '团队配置（选择协作子 Agent）' })}
          >
            <Users className={COMPOSER_TOOLBAR_ICON_CLASS} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
          </button>
        </PopoverTrigger>
      </ChatIconTooltip>
      <PopoverContent align="start" className="w-80 p-3">
        <div className="text-subtitle font-medium mb-1">
          {t('subagent.team.title', { defaultValue: '本会话协作团队' })}
        </div>
        <div className="text-caption text-muted-foreground/80 mb-3">
          {t('subagent.team.hint', { defaultValue: '勾选参与本会话的子 Agent 角色；不选则可用全部工作空间角色。' })}
        </div>
        {loading ? (
          <div className="text-caption text-muted-foreground/60 py-4 text-center">
            {t('subagent.team.loading', { defaultValue: '加载中…' })}
          </div>
        ) : templates.length === 0 ? (
          <div className="text-caption text-muted-foreground/60 py-4 text-center">
            {t('subagent.team.empty', { defaultValue: '当前工作空间未配置子 Agent 角色' })}
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto flex flex-col gap-2">
            {templates.map(tpl => (
              <label key={tpl.id} className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="flex flex-col min-w-0">
                  <span className="text-body truncate">{tpl.icon ? `${tpl.icon} ` : ''}{tpl.name}</span>
                  {tpl.description?.trim() && (
                    <span className="text-caption text-muted-foreground/60 truncate">{tpl.description.trim()}</span>
                  )}
                </span>
                <Switch
                  checked={selected.has(tpl.id)}
                  onCheckedChange={(on: boolean) => toggle(tpl.id, on)}
                />
              </label>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-3">
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving
              ? t('subagent.team.saving', { defaultValue: '保存中…' })
              : t('subagent.team.save', { defaultValue: '保存' })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
