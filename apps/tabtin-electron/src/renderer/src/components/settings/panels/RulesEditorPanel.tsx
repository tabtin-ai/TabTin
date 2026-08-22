/**
 * RulesEditorPanel —— Agent 规则的通用编辑器（设置 IA Phase 3 §8.6）。
 *
 * 个人通用规则（PersonalRulesPanel）形态：单个 ≤5000 字纯文本，load → 编辑 →
 * 保存（空串=清空该层）。抽出这个纯展示编辑器复用，由各层 Panel 注入 load/save。
 * （原团队 Agent 基线规则面板已下线，岗位差异化交给 skill 系统。）
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Button, StatusNotice, Textarea } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SETTINGS_HINT, SETTINGS_TEXTAREA_FULL, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { cn } from '@utils/cn'

const MAX_RULES_CHARS = 5000

interface RulesEditorPanelProps {
  icon: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  placeholder?: string
  hint?: React.ReactNode
  /** 加载已存规则全文（空串=该层未设）。 */
  load: () => Promise<string>
  /** 整体替换（空串=清空该层）。 */
  save: (value: string) => Promise<void>
  /** false=只读；默认可写。 */
  canManage?: boolean
  /** 只读时的提示横幅（如“需要管理员权限才能修改”）。 */
  readOnlyNotice?: React.ReactNode
  /** 嵌入模式：只渲染编辑器主体，由外层提供页眉与滚动容器（用于打平后的合并页）。 */
  embedded?: boolean
}

export const RulesEditorPanel: React.FC<RulesEditorPanelProps> = ({
  icon,
  title,
  subtitle,
  placeholder,
  hint,
  load,
  save,
  canManage = true,
  readOnlyNotice,
  embedded = false,
}) => {
  const { t } = useTranslation('settings')
  const [saved, setSaved] = useState('')
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    load()
      .then((text) => {
        if (cancelled) return
        setSaved(text)
        setValue(text)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('rulesEditor.loadFailed', { defaultValue: '加载失败' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, t])

  const dirty = useMemo(() => value !== saved, [value, saved])

  const handleSave = async () => {
    if (!canManage || !dirty) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      // 整体替换语义：trim 尾随空白后写；空串=清空该层。
      const next = value.trim()
      await save(next)
      setSaved(next)
      setValue(next)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rulesEditor.saveFailed', { defaultValue: '保存失败' }))
    } finally {
      setSaving(false)
    }
  }

  const body = (
    <>
      {readOnlyNotice && !canManage ? (
        <StatusNotice tone="info" description={readOnlyNotice} className="mb-1" />
      ) : null}

      {error ? <StatusNotice tone="danger" description={error} className="mb-1" /> : null}

      <div className="space-y-1.5">
        <Textarea
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSuccess(false)
          }}
          placeholder={placeholder}
          maxLength={MAX_RULES_CHARS}
          rows={12}
          disabled={loading || saving || !canManage}
          className={SETTINGS_TEXTAREA_FULL}
        />
        <div className="flex items-center justify-between gap-3">
          {hint ? <p className={cn(SETTINGS_HINT, 'min-w-0')}>{hint}</p> : <span />}
          <span className={cn(SETTINGS_HINT, 'shrink-0 tabular-nums')}>
            {value.length}/{MAX_RULES_CHARS}
          </span>
        </div>
      </div>

      {canManage ? (
        <div className="flex items-center justify-end gap-3 pt-1">
          {success ? (
            <span className={cn(SETTINGS_TEXT_MICRO, 'text-success')}>
              {t('rulesEditor.saved', { defaultValue: '已保存' })}
            </span>
          ) : dirty ? (
            <span className={SETTINGS_HINT}>
              {t('rulesEditor.unsaved', { defaultValue: '有未保存的更改' })}
            </span>
          ) : null}
          <Button size="sm" onClick={() => void handleSave()} disabled={loading || saving || !dirty}>
            {saving
              ? t('rulesEditor.saving', { defaultValue: '保存中…' })
              : t('rulesEditor.save', { defaultValue: '保存' })}
          </Button>
        </div>
      ) : null}
    </>
  )

  if (embedded) {
    return <div className="space-y-4">{body}</div>
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader icon={icon} title={title} subtitle={subtitle} />
      {body}
    </SettingsPanelLayout>
  )
}
