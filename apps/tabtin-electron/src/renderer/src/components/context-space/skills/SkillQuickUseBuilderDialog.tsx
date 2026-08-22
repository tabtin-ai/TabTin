import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  ScrollArea,
  toast,
} from '@components/ui'
import { CANVAS_TEXT_META, CANVAS_TEXT_MICRO } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'
import { ContextDialogHeader } from '../ContextDialogHeader'
import { PromptTemplateRenderer } from '@/components/chat/composer-presets/PromptTemplateRenderer'
import type { PromptVariable } from '@/components/chat/composer-presets/registry/types'
import type { SkillIndexEntry, SkillQuickUsePreset, SkillQuickUseVariable } from '@/skills/types'
import { useUpdateSkillQuickUseMutation } from '@/hooks/queries/skills'

/**
 * 快速使用 builder（WC5 / preset 列表）—— owner 用元数据方式编辑「快速使用」preset 列表：
 * 每个 preset = 展示名 + 一段带 {{key}} 槽位的 prompt 模板 + 变量定义。一个 skill 可有多个
 * preset，详情页列出供用户直观感知能力。保存写 Skill.quick_use_json（草稿），下次发布随版本
 * 快照（见后端 publish_from_zip）。不落 skill 目录文件。
 */
interface SkillQuickUseBuilderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: SkillIndexEntry
  spaceId: string
}

const VARIABLE_TYPES: Array<{ value: string; label: string }> = [
  { value: 'input', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'select', label: '下拉选择' },
  { value: 'number', label: '数字' },
  { value: 'toggle', label: '开关' },
]

interface DraftVariable {
  key: string
  type: string
  label: string
  placeholder: string
  /** select 类型：逗号分隔的候选值。 */
  optionsText: string
  required: boolean
}

interface DraftPreset {
  id: string
  label: string
  promptTemplate: string
  variables: DraftVariable[]
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `p-${crypto.randomUUID().slice(0, 8)}`
    }
  } catch {
    // ignore
  }
  return `p-${Math.random().toString(36).slice(2, 10)}`
}

function toDraftVariables(variables: SkillQuickUseVariable[] | undefined, required: Set<string>): DraftVariable[] {
  if (!Array.isArray(variables)) return []
  return variables.map(v => ({
    key: v.key ?? '',
    type: typeof v.type === 'string' ? v.type : 'input',
    label: v.label ?? '',
    placeholder: v.placeholder ?? '',
    optionsText: Array.isArray(v.options) ? v.options.map(o => o.value).join(', ') : '',
    required: required.has(v.key ?? ''),
  }))
}

function toDraftPresets(presets: SkillQuickUsePreset[] | null | undefined): DraftPreset[] {
  if (!Array.isArray(presets)) return []
  return presets.map(p => ({
    id: typeof p.id === 'string' && p.id ? p.id : newId(),
    label: p.label ?? '',
    promptTemplate: typeof p.promptTemplate === 'string' ? p.promptTemplate : '',
    variables: toDraftVariables(p.variables, new Set(Array.isArray(p.canSubmitKeys) ? p.canSubmitKeys : [])),
  }))
}

function emptyVariable(): DraftVariable {
  return { key: '', type: 'input', label: '', placeholder: '', optionsText: '', required: false }
}

function emptyPreset(index: number): DraftPreset {
  return { id: newId(), label: `示例 ${index + 1}`, promptTemplate: '', variables: [] }
}

function buildVariables(drafts: DraftVariable[]): { variables: SkillQuickUseVariable[]; canSubmitKeys: string[] } {
  const variables: SkillQuickUseVariable[] = []
  const canSubmitKeys: string[] = []
  for (const d of drafts) {
    const key = d.key.trim()
    if (!key) continue
    const variable: SkillQuickUseVariable = { key, type: d.type }
    if (d.label.trim()) variable.label = d.label.trim()
    if (d.placeholder.trim()) variable.placeholder = d.placeholder.trim()
    if (d.type === 'select') {
      const options = d.optionsText
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(value => ({ value, label: value }))
      if (options.length > 0) {
        variable.options = options
        variable.defaultValue = options[0].value
      }
    }
    variables.push(variable)
    if (d.required) canSubmitKeys.push(key)
  }
  return { variables, canSubmitKeys }
}

function buildPresets(drafts: DraftPreset[]): SkillQuickUsePreset[] {
  const out: SkillQuickUsePreset[] = []
  for (const d of drafts) {
    const promptTemplate = d.promptTemplate.trim()
    if (!promptTemplate) continue
    const { variables, canSubmitKeys } = buildVariables(d.variables)
    out.push({
      id: d.id,
      label: d.label.trim() || promptTemplate.slice(0, 16),
      promptTemplate,
      variables,
      ...(canSubmitKeys.length > 0 ? { canSubmitKeys } : {}),
    })
  }
  return out
}

/** 把 draft 变量转成 PromptTemplateRenderer 用的 PromptVariable（用于实时预览）。 */
function toPreviewVariables(drafts: DraftVariable[]): PromptVariable[] {
  return buildVariables(drafts).variables.map(v => ({
    key: v.key,
    type: (v.type as PromptVariable['type']) ?? 'input',
    label: v.label,
    placeholder: v.placeholder,
    defaultValue: v.defaultValue,
    options: v.options?.map(o => ({ value: o.value, label: o.label ?? o.value })),
  }))
}

const PresetEditor: React.FC<{
  preset: DraftPreset
  index: number
  onChange: (patch: Partial<DraftPreset>) => void
  onRemove: () => void
}> = ({ preset, index, onChange, onRemove }) => {
  const { t } = useTranslation('context')
  const [previewState, setPreviewState] = useState<Record<string, unknown>>({})
  const previewVariables = useMemo(() => toPreviewVariables(preset.variables), [preset.variables])

  const updateVariable = (vi: number, patch: Partial<DraftVariable>) => {
    onChange({ variables: preset.variables.map((v, i) => (i === vi ? { ...v, ...patch } : v)) })
  }
  const removeVariable = (vi: number) => {
    onChange({ variables: preset.variables.filter((_, i) => i !== vi) })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0', 'rounded', 'bg-muted', 'px-1.5', 'py-0.5', CANVAS_TEXT_META)}>
          #{index + 1}
        </span>
        <Input
          value={preset.label}
          onChange={e => onChange({ label: e.target.value })}
          placeholder="示例名称（详情页列表展示，如「生成流程图」）"
          className={cn('h-8', 'flex-1', CANVAS_TEXT_META)}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground/60 hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <textarea
        value={preset.promptTemplate}
        onChange={e => onChange({ promptTemplate: e.target.value })}
        rows={3}
        placeholder="提示词模板，用 {{变量名}} 插入槽位。例：请帮我生成一个 {{subject}}。"
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-body outline-none focus:border-primary/60"
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={cn('font-medium', CANVAS_TEXT_META)}>{t('skills.quickUseBuilder.variables')}</span>
          <Button
            variant="outline"
            size="sm"
            className={cn('h-7', 'gap-1', CANVAS_TEXT_META)}
            onClick={() => onChange({ variables: [...preset.variables, emptyVariable()] })}
          >
            <Plus className="h-3 w-3" />
            添加变量
          </Button>
        </div>
        {preset.variables.length === 0 ? (
          <p className={CANVAS_TEXT_META}>{t('skills.quickUseBuilder.variablesHint')}</p>
        ) : (
          <div className="space-y-2">
            {preset.variables.map((d, vi) => (
              <div key={vi} className="rounded-lg border bg-background/60 p-2">
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 grid-cols-2 gap-2">
                    <Input
                      value={d.key}
                      onChange={e => updateVariable(vi, { key: e.target.value })}
                      placeholder="变量名（如 subject）"
                      className={cn('h-8', CANVAS_TEXT_META)}
                    />
                    <select
                      value={d.type}
                      onChange={e => updateVariable(vi, { type: e.target.value })}
                      className={cn('h-8', 'rounded-md', 'border', 'bg-background', 'px-2', 'outline-none', 'focus:border-primary/60', CANVAS_TEXT_META)}
                    >
                      {VARIABLE_TYPES.map(t => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                    <Input
                      value={d.label}
                      onChange={e => updateVariable(vi, { label: e.target.value })}
                      placeholder="显示标签"
                      className={cn('h-8', CANVAS_TEXT_META)}
                    />
                    <Input
                      value={d.placeholder}
                      onChange={e => updateVariable(vi, { placeholder: e.target.value })}
                      placeholder="占位提示"
                      className={cn('h-8', CANVAS_TEXT_META)}
                    />
                    {d.type === 'select' ? (
                      <Input
                        value={d.optionsText}
                        onChange={e => updateVariable(vi, { optionsText: e.target.value })}
                        placeholder="候选值，逗号分隔"
                        className={cn('col-span-2', 'h-8', CANVAS_TEXT_META)}
                      />
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground/60 hover:text-destructive"
                    onClick={() => removeVariable(vi)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <label className={cn('mt-2', 'flex', 'items-center', 'gap-1.5', CANVAS_TEXT_META)}>
                  <input
                    type="checkbox"
                    checked={d.required}
                    onChange={e => updateVariable(vi, { required: e.target.checked })}
                  />
                  必填（为空时不能提交）
                </label>
              </div>
            ))}
          </div>
        )}
      </div>

      {preset.promptTemplate.trim() ? (
        <div className="space-y-1.5">
          <span className={cn('font-medium', CANVAS_TEXT_META)}>{t('skills.quickUseBuilder.preview')}</span>
          <div className="rounded-lg border bg-background/60 px-3 py-2.5">
            <PromptTemplateRenderer
              template={preset.promptTemplate}
              variables={previewVariables}
              state={previewState}
              onChange={patch => setPreviewState(prev => ({ ...prev, ...patch }))}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

export const SkillQuickUseBuilderDialog: React.FC<SkillQuickUseBuilderDialogProps> = ({
  open,
  onOpenChange,
  skill,
  spaceId,
}) => {
  const { t } = useTranslation('context')
  const updateMutation = useUpdateSkillQuickUseMutation()
  const [presets, setPresets] = useState<DraftPreset[]>([])

  useEffect(() => {
    if (!open) return
    setPresets(toDraftPresets(skill.quick_use))
  }, [open, skill.quick_use])

  const updatePreset = (index: number, patch: Partial<DraftPreset>) => {
    setPresets(prev => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }
  const removePreset = (index: number) => {
    setPresets(prev => prev.filter((_, i) => i !== index))
  }

  // 至少有一个含模板的 preset 才有意义；保存空 = 清空。已填模板但漏写名称时拦住。
  const withTemplate = presets.filter(p => p.promptTemplate.trim())
  const allLabeled = withTemplate.every(p => p.label.trim())
  const canSave = !updateMutation.isPending && allLabeled

  const handleSave = async () => {
    if (!canSave) return
    const built = buildPresets(presets)
    try {
      await updateMutation.mutateAsync({
        skillId: skill.skill_id,
        spaceId,
        quickUse: built.length > 0 ? built : null,
      })
      toast({
        title: '已保存快速使用',
        description: '发布新版本时会随版本固定下来。',
      })
      onOpenChange(false)
    } catch (err) {
      toast({
        title: '保存失败',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Sparkles className="h-7 w-7" />}
          title="编辑快速使用"
          description={(
            <>
            为这个 Skill 配置一组「快速使用」示例。每个示例是一段带 {'{{变量}}'} 槽位的提示词，
            用户在详情页点开填表后插入对话框——多个示例能让用户直观看到这个 Skill 能做什么。
            </>
          )}
        />

        <ScrollArea className="min-h-0 flex-1 pr-2">
          <div className="space-y-3">
            {presets.length === 0 ? (
              <p className={cn('rounded-lg', 'border', 'border-dashed', 'py-6', 'text-center', CANVAS_TEXT_META)}>
                还没有快速使用示例。点下方「添加示例」创建第一个。
              </p>
            ) : (
              presets.map((preset, index) => (
                <PresetEditor
                  key={preset.id}
                  preset={preset}
                  index={index}
                  onChange={patch => updatePreset(index, patch)}
                  onRemove={() => removePreset(index)}
                />
              ))
            )}
            <Button
              variant="outline"
              size="sm"
              className={cn('w-full', 'gap-1', CANVAS_TEXT_META)}
              onClick={() => setPresets(prev => [...prev, emptyPreset(prev.length)])}
            >
              <Plus className="h-3.5 w-3.5" />
              添加示例
            </Button>
            {!allLabeled ? (
              <p className={cn('text-amber-600', 'dark:text-amber-400', CANVAS_TEXT_MICRO)}>
                每个填了提示词的示例都需要一个名称。
              </p>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('skills.quickUseBuilder.cancel')}</Button>
          <Button disabled={!canSave} onClick={() => void handleSave()}>
            {updateMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

SkillQuickUseBuilderDialog.displayName = 'SkillQuickUseBuilderDialog'
