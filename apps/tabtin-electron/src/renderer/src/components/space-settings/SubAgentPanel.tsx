/**
 * SubAgentPanel — 子 Agent 模板管理面板
 *
 * 允许用户在 Workspace 中创建、编辑、删除自定义子 Agent 模板。
 * 当前 Agent 执行任务时可按名称调用这些预配置的子 Agent。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Plus, Trash2, Bot, Pencil, X,
} from 'lucide-react'
import {
  Button,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import {
  SubAgentTemplateApi,
  type SubAgentTemplate,
  type SubAgentTemplateCreate,
} from '@/services/subagentTemplateApi'
import { OrganizationLlmApiService } from '@/services/organizationLlmApi'
import type { OrganizationLlmModel } from '@/types/llm-organization'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SettingsNameConfirmDialog } from '@components/settings/SettingsNameConfirmDialog'
import {
  SETTINGS_CONTROL,
  SETTINGS_CONTROL_SM,
  SETTINGS_HOVER_ACTION,
  SETTINGS_SELECT_TRIGGER,
  SETTINGS_TEXTAREA_FULL,
} from '@components/settings/settingsUi'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { cn } from '@utils/cn'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubAgentPanelProps {
  spaceId: string
  canManage: boolean
}

const SUBAGENT_TYPES = [
  { value: 'explore', labelKey: 'subagent.typeExplore', descKey: 'subagent.typeExploreDesc' },
  { value: 'plan', labelKey: 'subagent.typePlan', descKey: 'subagent.typePlanDesc' },
  { value: 'execute', labelKey: 'subagent.typeExecute', descKey: 'subagent.typeExecuteDesc' },
] as const

const MODES = [
  { value: 'wait', labelKey: 'subagent.modeWait' },
  { value: 'background', labelKey: 'subagent.modeBackground' },
] as const

const THINKING_LEVELS = [
  { value: '', labelKey: 'subagent.thinkingDefault' },
  { value: 'off', labelKey: 'subagent.thinkingOff' },
  { value: 'low', labelKey: 'subagent.thinkingLow' },
  { value: 'medium', labelKey: 'subagent.thinkingMedium' },
  { value: 'high', labelKey: 'subagent.thinkingHigh' },
] as const

const ICON_OPTIONS = ['🤖', '🔍', '🧠', '🛠', '📊', '✍️', '🧪', '🧭']

const APP_ID_OPTIONS = [
  { value: '', labelKey: 'subagent.appIdDefault', descKey: 'subagent.appIdDefaultDesc' },
  { value: 'tabdata', labelKey: 'subagent.appIdTabdata', descKey: 'subagent.appIdTabdataDesc' },
  { value: 'tabdoc', labelKey: 'subagent.appIdTabdoc', descKey: 'subagent.appIdTabdocDesc' },
  { value: 'tabcode', labelKey: 'subagent.appIdTabcode', descKey: 'subagent.appIdTabcodeDesc' },
  { value: 'terminal', labelKey: 'subagent.appIdTerminal', descKey: 'subagent.appIdTerminalDesc' },
  { value: 'rag', labelKey: 'subagent.appIdRag', descKey: 'subagent.appIdRagDesc' },
  { value: 'browser_gui', labelKey: 'subagent.appIdBrowserGui', descKey: 'subagent.appIdBrowserGuiDesc' },
] as const

const EMPTY_TEMPLATE: SubAgentTemplateCreate = {
  name: '',
  description: '',
  icon: '',
  system_prompt: '',
  subagent_type: 'execute',
  allowed_tools: [],
  denied_tools: [],
  model_id: '',
  thinking_level: '',
  default_mode: 'wait',
  app_id: '',
  is_enabled: true,
  order: 0,
  // 默认色与色板 fallback（#6366f1）一致——新模板直接落库这个色，避免「色板显示了
  // 颜色但没保存」的陷阱，让 badge 与色板所见一致。
  display_color: '#6366f1',
  max_active: 5,
}

const normalizeToolNames = (values: string[]) => Array.from(
  new Set(
    values
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  )
)

const normalizeTemplateDraft = (draft: SubAgentTemplateCreate): SubAgentTemplateCreate => ({
  ...draft,
  name: draft.name.trim(),
  description: draft.description.trim(),
  icon: draft.icon.trim(),
  system_prompt: draft.system_prompt.trim(),
  model_id: draft.model_id.trim(),
  thinking_level: draft.thinking_level.trim().toLowerCase(),
  app_id: (draft.app_id ?? '').trim(),
  allowed_tools: normalizeToolNames(draft.allowed_tools || []),
  denied_tools: normalizeToolNames(draft.denied_tools || []),
  display_color: (draft.display_color ?? '').trim(),
})

// ---------------------------------------------------------------------------
// TemplateEditor — 创建 / 编辑表单
// ---------------------------------------------------------------------------

const TemplateEditor: React.FC<{
  initial: SubAgentTemplateCreate
  onSave: (data: SubAgentTemplateCreate) => Promise<void>
  onCancel: () => void
  isNew: boolean
  saving: boolean
  availableModels: OrganizationLlmModel[]
  version?: number
}> = ({ initial, onSave, onCancel, isNew, saving, availableModels, version }) => {
  const { t } = useTranslation('space')
  const [form, setForm] = useState<SubAgentTemplateCreate>(initial)
  const [toolInput, setToolInput] = useState('')
  const [denyInput, setDenyInput] = useState('')

  const patch = useCallback(
    <K extends keyof SubAgentTemplateCreate>(key: K, value: SubAgentTemplateCreate[K]) => {
      setForm(prev => ({ ...prev, [key]: value }))
    },
    [],
  )

  const addTool = useCallback((list: 'allowed_tools' | 'denied_tools', input: string, setInput: (v: string) => void) => {
    const name = input.trim().toLowerCase()
    if (!name) return
    setForm(prev => ({
      ...prev,
      [list]: [...(prev[list] || []).filter(t => t !== name), name],
    }))
    setInput('')
  }, [])

  const removeTool = useCallback((list: 'allowed_tools' | 'denied_tools', name: string) => {
    setForm(prev => ({
      ...prev,
      [list]: (prev[list] || []).filter(t => t !== name),
    }))
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const normalized = normalizeTemplateDraft(form)
    if (!normalized.name) return
    await onSave(normalized)
  }, [form, onSave])

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border border-border/30 rounded-lg p-4 bg-muted/5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-body font-medium">
            {isNew
              ? t('subagent.createTitle', { defaultValue: '创建子 Agent' })
              : t('subagent.editTitle', { defaultValue: '编辑子 Agent' })}
          </h4>
          {!isNew && version != null && (
            <span className="text-caption px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/60">
              v{version}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('actions.cancel', { defaultValue: '关闭' })}
          className="shrink-0 rounded-interactive p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 名称 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.name', { defaultValue: '名称' })} <span className="text-destructive/80">*</span>
        </label>
        <Input
          value={form.name}
          onChange={e => patch('name', e.target.value)}
          placeholder={t('subagent.namePlaceholder', { defaultValue: '如：代码审查专家、数据分析师' })}
          maxLength={64}
          className={cn('w-full', SETTINGS_CONTROL)}
        />
      </div>

      {/* 图标 */}
      <div className="space-y-1.5">
        <label className="text-body text-muted-foreground">
          {t('subagent.icon', { defaultValue: '图标' })}
        </label>
        <div className="flex flex-wrap gap-1">
          {ICON_OPTIONS.map(icon => (
            <button
              key={icon}
              type="button"
              onClick={() => patch('icon', icon)}
              className={cn(
                'h-8 w-8 rounded-md flex items-center justify-center text-subtitle transition-all',
                form.icon === icon ? 'ring-1.5 ring-accent bg-accent/10' : 'hover:bg-muted/40'
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      {/* 描述 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.description', { defaultValue: '用途描述' })}
        </label>
        <Textarea
          value={form.description}
          onChange={e => patch('description', e.target.value)}
          placeholder={t('subagent.descPlaceholder', { defaultValue: '描述这个子 Agent 的专长和适用场景' })}
          maxLength={2000}
          rows={2}
          className={cn(SETTINGS_TEXTAREA_FULL, 'resize-none')}
        />
      </div>

      {/* 角色设定 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.systemPrompt', { defaultValue: '角色设定' })}
        </label>
        <Textarea
          value={form.system_prompt}
          onChange={e => patch('system_prompt', e.target.value)}
          placeholder={t('subagent.systemPromptPlaceholder', { defaultValue: '定义子 Agent 的身份、能力和行为规则' })}
          maxLength={10000}
          rows={4}
          className={cn(SETTINGS_TEXTAREA_FULL, 'resize-none')}
        />
      </div>

      {/* 类型 + 模式 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-body text-muted-foreground">
            {t('subagent.type', { defaultValue: '任务角色' })}
          </label>
          <Select
            value={form.subagent_type}
            onValueChange={v => patch('subagent_type', v as SubAgentTemplateCreate['subagent_type'])}
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBAGENT_TYPES.map(st => (
                <SelectItem key={st.value} value={st.value}>{t(st.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-muted-foreground/60">
            {t(SUBAGENT_TYPES.find(st => st.value === form.subagent_type)?.descKey ?? '')}
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-body text-muted-foreground">
            {t('subagent.mode', { defaultValue: '执行模式' })}
          </label>
          <Select
            value={form.default_mode}
            onValueChange={v => patch('default_mode', v as 'wait' | 'background')}
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map(m => (
                <SelectItem key={m.value} value={m.value}>{t(m.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption leading-relaxed text-muted-foreground">
            {t('subagent.modelDeviceHint', {
              defaultValue: '共享模板不能固定绑定本机 ChatGPT；选择跟随系统默认后，运行时使用当前设备的子 Agent 模型策略。',
            })}
          </p>
        </div>
      </div>

      {/* 模型 + 思维级别 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-body text-muted-foreground">
            {t('subagent.model', { defaultValue: '模型' })}
          </label>
          <Select
            value={form.model_id ? form.model_id : '__default__'}
            onValueChange={v => patch('model_id', v === '__default__' ? '' : v)}
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[min(320px,50vh)]">
              <SelectItem value="__default__">
                {t('subagent.modelDefault', { defaultValue: '跟随系统默认' })}
              </SelectItem>
              {availableModels.map(model => (
                <SelectItem key={model.id} value={model.id}>
                  {model.display_name} · {model.provider_display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-body text-muted-foreground">
            {t('subagent.thinkingLevel', { defaultValue: '思维级别' })}
          </label>
          <Select
            value={form.thinking_level === '' ? '__default__' : form.thinking_level}
            onValueChange={v => patch('thinking_level', v === '__default__' ? '' : v)}
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THINKING_LEVELS.map(level => (
                <SelectItem key={level.value || '__default__'} value={level.value === '' ? '__default__' : level.value}>
                  {t(level.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 专长能力 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.appId', { defaultValue: '专长能力' })}
        </label>
        <Select
          value={form.app_id === '' ? '__default__' : form.app_id}
          onValueChange={v => patch('app_id', v === '__default__' ? '' : v)}
        >
          <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-[min(320px,50vh)]">
            {APP_ID_OPTIONS.map(opt => (
              <SelectItem key={opt.value || '__default__'} value={opt.value === '' ? '__default__' : opt.value}>
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-caption text-muted-foreground/60">
          {t(APP_ID_OPTIONS.find(o => o.value === (form.app_id || ''))?.descKey ?? 'subagent.appIdHint')}
        </p>
      </div>

      {/* 工具白名单 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.allowedTools', { defaultValue: '工具白名单' })}
          <span className="text-muted-foreground/40 ml-1">
            {t('subagent.allowedToolsHint', { defaultValue: '（在上方专长能力范围内筛选，空=不限制）' })}
          </span>
        </label>
        <div className="flex gap-1.5">
          <Input
            value={toolInput}
            onChange={e => setToolInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTool('allowed_tools', toolInput, setToolInput) } }}
            placeholder="tool_name"
            className={cn('min-w-0 flex-1', SETTINGS_CONTROL)}
          />
          <Button type="button" variant="outline" className={SETTINGS_CONTROL}
            onClick={() => addTool('allowed_tools', toolInput, setToolInput)}>
            {t('subagent.add', { defaultValue: '添加' })}
          </Button>
        </div>
        {form.allowed_tools.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {form.allowed_tools.map(tool => (
              <span key={tool} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/10 text-body">
                {tool}
                <button type="button" onClick={() => removeTool('allowed_tools', tool)} className="text-muted-foreground/60 hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 工具黑名单 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.deniedTools', { defaultValue: '工具黑名单' })}
        </label>
        <div className="flex gap-1.5">
          <Input
            value={denyInput}
            onChange={e => setDenyInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTool('denied_tools', denyInput, setDenyInput) } }}
            placeholder="tool_name"
            className={cn('min-w-0 flex-1', SETTINGS_CONTROL)}
          />
          <Button type="button" variant="outline" className={SETTINGS_CONTROL}
            onClick={() => addTool('denied_tools', denyInput, setDenyInput)}>
            {t('subagent.add', { defaultValue: '添加' })}
          </Button>
        </div>
        {form.denied_tools.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {form.denied_tools.map(tool => (
              <span key={tool} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-destructive/10 text-body">
                {tool}
                <button type="button" onClick={() => removeTool('denied_tools', tool)} className="text-muted-foreground/60 hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 显示颜色（上下文继承选项已下线：子 Agent 一律不继承父上下文） */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.displayColor', { defaultValue: '显示颜色' })}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={form.display_color || '#6366f1'}
            onChange={e => patch('display_color', e.target.value)}
            className="h-8 w-8 rounded border border-border/30 cursor-pointer bg-transparent p-0"
          />
          <Input
            value={form.display_color}
            onChange={e => patch('display_color', e.target.value)}
            placeholder="#6366f1"
            maxLength={16}
            className={cn('flex-1', SETTINGS_CONTROL)}
          />
        </div>
      </div>

      {/* 并发上限 */}
      <div className="space-y-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.maxActive', { defaultValue: '并发上限' })}
        </label>
        <Input
          type="number"
          min={1}
          max={100}
          value={form.max_active}
          onChange={e => patch('max_active', Math.max(1, Math.min(100, parseInt(e.target.value) || 5)))}
          className={cn(SETTINGS_CONTROL)}
        />
      </div>

      {/* 启用开关 */}
      <div className="flex items-center justify-between py-1">
        <label className="text-body text-muted-foreground">
          {t('subagent.enabled', { defaultValue: '启用' })}
        </label>
        <Switch checked={form.is_enabled} onCheckedChange={v => patch('is_enabled', v)} />
      </div>

      {/* 操作按钮 */}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel} className={SETTINGS_CONTROL_SM}>
          {t('actions.cancel', { defaultValue: '取消' })}
        </Button>
        <Button type="submit" disabled={saving || !form.name.trim()} className={SETTINGS_CONTROL_SM}>
          {saving
            ? t('actions.saving', { defaultValue: '保存中...' })
            : t('actions.save', { defaultValue: '保存' })}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// TemplateCard — 列表项
// ---------------------------------------------------------------------------

const TemplateCard: React.FC<{
  template: SubAgentTemplate
  canManage: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
}> = ({ template, canManage, onEdit, onToggle, onDelete }) => {
  const { t } = useTranslation('space')
  const typeLabel = t(SUBAGENT_TYPES.find(st => st.value === template.subagent_type)?.labelKey ?? '') || template.subagent_type

  return (
    <div className={cn(
      'group flex items-start gap-3 p-3 rounded-lg border border-border/30 transition-colors',
      'hover:border-border/60 hover:bg-muted/10',
      !template.is_enabled && 'opacity-50',
    )}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {template.icon ? (
            <span className="text-body leading-none shrink-0">{template.icon}</span>
          ) : (
            <Bot className="h-4 w-4 text-accent/60 shrink-0" />
          )}
          <span className="text-body font-medium truncate">{template.name}</span>
          <span className="text-caption px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/60 shrink-0">
            {typeLabel}
          </span>
        </div>
        {template.description && (
          <p className="text-body text-muted-foreground/60 mt-0.5 line-clamp-2">{template.description}</p>
        )}
        {(template.model_id || template.thinking_level || template.app_id || template.version) && (
          <p className="text-caption text-muted-foreground/45 mt-0.5">
            {template.model_id ? `${t('subagent.cardModel', { defaultValue: '模型' })}：${template.model_id}` : ''}
            {template.thinking_level ? ` · ${t('subagent.cardThinking', { defaultValue: '思维' })}：${template.thinking_level}` : ''}
            {template.app_id ? ` · ${t(APP_ID_OPTIONS.find(o => o.value === template.app_id)?.labelKey ?? '') || template.app_id}` : ''}
            {template.version ? ` · v${template.version}` : ''}
          </p>
        )}
        {template.system_prompt && (
          <p className="text-caption text-muted-foreground/40 mt-0.5 line-clamp-1 font-mono">
            {template.system_prompt.slice(0, 100)}
          </p>
        )}
      </div>

      {canManage && (
        <div className={cn('flex items-center gap-1 shrink-0', SETTINGS_HOVER_ACTION)}>
          <Switch
            checked={template.is_enabled}
            onCheckedChange={onToggle}
          />
          <button type="button" onClick={onEdit}
            className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-foreground hover:bg-muted/30">
            <Pencil className="h-3 w-3" />
          </button>
          <button type="button" onClick={onDelete}
            className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SubAgentPanel: React.FC<SubAgentPanelProps> = ({ spaceId, canManage }) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore(state => state.spaces.find(space => space.id === spaceId) ?? null)
  const [templates, setTemplates] = useState<SubAgentTemplate[]>([])
  const [availableModels, setAvailableModels] = useState<OrganizationLlmModel[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SubAgentTemplate | null>(null)
  const [deleteInputValue, setDeleteInputValue] = useState('')
  const [deleteError, setDeleteError] = useState('')

  const loadTemplates = useCallback(async () => {
    try {
      setLoading(true)
      const items = await SubAgentTemplateApi.list(spaceId)
      setTemplates(items)
    } catch {
      toast({ title: t('subagent.loadError', { defaultValue: '加载子 Agent 列表失败' }), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [spaceId, t])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  useEffect(() => {
    if (!canManage && editing) {
      setEditing(null)
    }
  }, [canManage, editing])

  useEffect(() => {
    const organizationId = space?.organization_id
    if (!organizationId) return
    let active = true
    void OrganizationLlmApiService.listModels(organizationId)
      .then(result => {
        if (!active) return
        // ：组织模型列表含 include_inactive，子 Agent 选型只展示可路由渠道。
        const models = (result.models || []).filter((model) => {
          const routingEnabled = model.provider_routing_enabled ?? model.provider_is_active
          const ready = !model.wave_status || model.wave_status === 'ready'
          return routingEnabled !== false && ready && model.is_active !== false
        })
        setAvailableModels(models)
      })
      .catch(() => {
        if (!active) return
        setAvailableModels([])
      })
    return () => {
      active = false
    }
  }, [space?.organization_id])

  const handleCreate = useCallback(async (data: SubAgentTemplateCreate) => {
    setSaving(true)
    try {
      await SubAgentTemplateApi.create(spaceId, data)
      setEditing(null)
      await loadTemplates()
      toast({ title: t('subagent.createSuccess', { defaultValue: '子 Agent 创建成功' }) })
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : t('subagent.createError', { defaultValue: '创建失败' }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [spaceId, loadTemplates, t])

  const handleUpdate = useCallback(async (id: string, data: SubAgentTemplateCreate) => {
    setSaving(true)
    try {
      await SubAgentTemplateApi.update(spaceId, id, data)
      setEditing(null)
      await loadTemplates()
      toast({ title: t('subagent.updateSuccess', { defaultValue: '子 Agent 已更新' }) })
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : t('subagent.updateError', { defaultValue: '更新失败' }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [spaceId, loadTemplates, t])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    // 乐观更新：点击立即翻转开关，避免等待网络往返造成「点了没反应」的观感；
    // 失败时回退到切换前的状态并提示。
    let previousValue: boolean | undefined
    setTemplates(prev => prev.map(t => {
      if (t.id !== id) return t
      previousValue = t.is_enabled
      return { ...t, is_enabled: enabled }
    }))
    try {
      await SubAgentTemplateApi.update(spaceId, id, { is_enabled: enabled })
    } catch (err) {
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, is_enabled: previousValue ?? !enabled } : t))
      toast({
        title: err instanceof Error ? err.message : t('subagent.toggleError', { defaultValue: '切换状态失败' }),
        variant: 'destructive',
      })
    }
  }, [spaceId, t])

  const handleDelete = useCallback(async (id: string) => {
    setSaving(true)
    try {
      await SubAgentTemplateApi.remove(spaceId, id)
      setTemplates(prev => prev.filter(t => t.id !== id))
      if (editing === id) setEditing(null)
      setDeleteTarget(null)
      setDeleteInputValue('')
      setDeleteError('')
      toast({ title: t('subagent.deleteSuccess', { defaultValue: '子 Agent 已删除' }) })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('subagent.deleteError', { defaultValue: '删除失败' })
      setDeleteError(message)
      toast({ title: message, variant: 'destructive' })
      throw err instanceof Error ? err : new Error(message)
    } finally {
      setSaving(false)
    }
  }, [spaceId, editing, t])

  const editingTemplate = editing && editing !== 'new'
    ? templates.find(t => t.id === editing)
    : null

  return (
    <div className="flex h-full min-w-0 w-full flex-col">
      <SpaceSettingsSectionHeader
        className="mb-3"
        marginBottomClassName="mb-0"
        title={t('subagent.title', { defaultValue: '子 Agent' })}
        description={t('subagent.subtitle', { defaultValue: '预定义专用子 Agent，当前 Agent 执行任务时可按名称调用' })}
        actions={canManage && !editing ? (
          <Button
            variant="outline"
            className={cn(SETTINGS_CONTROL_SM, 'gap-1')}
            onClick={() => setEditing('new')}
          >
            <Plus className="h-3 w-3" />
            {t('subagent.create', { defaultValue: '新建' })}
          </Button>
        ) : undefined}
      />

      <ScrollArea className="flex-1">
        <div className="space-y-2">
          {/* 编辑器 */}
          {editing === 'new' && (
            <TemplateEditor
              key="subagent-new"
              initial={EMPTY_TEMPLATE}
              onSave={handleCreate}
              onCancel={() => setEditing(null)}
              isNew
              saving={saving}
              availableModels={availableModels}
            />
          )}

          {editingTemplate && (
            <TemplateEditor
              key={editingTemplate.id}
              version={editingTemplate.version}
              initial={{
                name: editingTemplate.name,
                description: editingTemplate.description,
                icon: editingTemplate.icon,
                system_prompt: editingTemplate.system_prompt,
                subagent_type: editingTemplate.subagent_type,
                allowed_tools: editingTemplate.allowed_tools || [],
                denied_tools: editingTemplate.denied_tools || [],
                model_id: editingTemplate.model_id,
                thinking_level: editingTemplate.thinking_level,
                default_mode: editingTemplate.default_mode,
                app_id: editingTemplate.app_id || '',
                is_enabled: editingTemplate.is_enabled,
                order: editingTemplate.order,
                display_color: editingTemplate.display_color || '',
                max_active: editingTemplate.max_active ?? 5,
              }}
              onSave={data => handleUpdate(editingTemplate.id, data)}
              onCancel={() => setEditing(null)}
              isNew={false}
              saving={saving}
              availableModels={availableModels}
            />
          )}

          {/* 列表 */}
          {loading ? (
            <div className="text-body text-muted-foreground/40 text-center py-8">
              {t('subagent.loading', { defaultValue: '加载中...' })}
            </div>
          ) : templates.length === 0 && !editing ? (
            <div className="text-center py-12">
              <Bot className="h-8 w-8 mx-auto text-muted-foreground/20 mb-2" />
              <p className="text-body text-muted-foreground/40">
                {t('subagent.empty', { defaultValue: '暂无自定义子 Agent' })}
              </p>
              <p className="text-caption text-muted-foreground/30 mt-1">
                {t('subagent.emptyHint', { defaultValue: '创建专用子 Agent 来增强当前 Agent 的任务执行能力' })}
              </p>
            </div>
          ) : (
            templates
              .filter(tpl => tpl.id !== editing)
              .map(tpl => (
                <TemplateCard
                  key={tpl.id}
                  template={tpl}
                  canManage={canManage}
                  onEdit={() => setEditing(tpl.id)}
                  onToggle={enabled => handleToggle(tpl.id, enabled)}
                  onDelete={() => {
                    setDeleteError('')
                    setDeleteInputValue('')
                    setDeleteTarget(tpl)
                  }}
                />
              ))
          )}
        </div>
      </ScrollArea>

      <SettingsNameConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={open => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteInputValue('')
            setDeleteError('')
          }
        }}
        title={t('subagent.deleteConfirmTitle', { defaultValue: '删除子 Agent' })}
        subtitle={t('subagent.deleteConfirmSubtitle', { defaultValue: '此操作会永久删除该子 Agent 模板。' })}
        items={[
          t('subagent.deleteConfirmItemName', {
            defaultValue: `子 Agent：${deleteTarget?.name ?? ''}`,
          }),
          t('subagent.deleteConfirmItemSettings', {
            defaultValue: '角色设定、工具权限、模型偏好等配置',
          }),
        ]}
        warning={t('subagent.deleteConfirmWarning', { defaultValue: '删除后不可恢复。' })}
        inputLabel={t('subagent.deleteConfirmInput', {
          defaultValue: '请输入子 Agent 名称以确认删除',
        })}
        inputPlaceholder={deleteTarget?.name ?? ''}
        inputValue={deleteInputValue}
        onInputChange={setDeleteInputValue}
        expectedValue={deleteTarget?.name ?? ''}
        error={deleteError}
        isLoading={saving}
        confirmText={t('actions.confirmDelete', { defaultValue: '确认删除' })}
        cancelText={t('actions.cancel', { defaultValue: '取消' })}
        onConfirm={async () => {
          if (!deleteTarget) return
          await handleDelete(deleteTarget.id)
        }}
      />
    </div>
  )
}
