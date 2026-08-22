/**
 * EnvImportDialog —— 从 `.env` 文本粘贴批量导入 AI 服务密钥。
 *
 * 流程：
 *  1. 用户粘贴 .env 文本到 textarea
 *  2. 实时解析 → 显示识别到的服务列表（每条带 checkbox）
 *  3. 用户勾选要导入的条目（默认全勾）
 *  4. 提交：逐条调用 /credential-vault/create
 */

import React, { useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
  Textarea,
} from '@components/ui'
import { KeyRound, Loader2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys } from '@/hooks/queries/credentials'
import { SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_TEXTAREA_FULL, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from '../../settingsUi'
import { parseEnvText, type ParsedEnvEntry } from './envParser'
import { SERVICE_PRESETS } from '../credentials/constants'
import { cn } from '@utils/cn'

interface EnvImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported?: () => void
}

export const EnvImportDialog: React.FC<EnvImportDialogProps> = ({ open, onOpenChange, onImported }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const parsed = useMemo(() => parseEnvText(text), [text])
  // 解析变化时自动全选
  React.useEffect(() => {
    setSelected(new Set(parsed.map((p) => p.envKey)))
  }, [parsed])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleImport = async () => {
    const targets = parsed.filter((p) => selected.has(p.envKey))
    if (targets.length === 0) {
      toast({ title: t('credentialVault.envImport.noSelection', { defaultValue: '请至少选择一项' }), variant: 'destructive' })
      return
    }
    setSubmitting(true)
    let created = 0
    let failed = 0
    for (const entry of targets) {
      try {
        const meta = SERVICE_PRESETS.find((p) => p.value === entry.preset)
        await apiClient.post('/credential-vault/create', {
          category: 'api_key',
          service_name: entry.preset === 'custom' ? entry.envKey.toLowerCase() : entry.preset,
          display_name: meta?.label || entry.envKey,
          credential_data: { [entry.field]: entry.value },
        })
        created++
      } catch (e) {
        console.error('[EnvImportDialog] create failed:', e)
        failed++
      }
    }
    void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
    setSubmitting(false)

    if (created > 0 && failed === 0) {
      toast({ title: t('credentialVault.envImport.successAll', { count: created, defaultValue: '已导入 {{count}} 个服务密钥' }) })
    } else if (created > 0) {
      toast({ title: t('credentialVault.envImport.successPartial', { ok: created, failed, defaultValue: '已导入 {{ok}} 个，{{failed}} 个失败' }) })
    } else {
      toast({ title: t('credentialVault.envImport.failedAll', { defaultValue: '导入失败' }), variant: 'destructive' })
    }

    if (created > 0) {
      onImported?.()
      onOpenChange(false)
      setText('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            {t('credentialVault.envImport.title', { defaultValue: '从 .env 粘贴导入' })}
          </DialogTitle>
          <DialogDescription>
            {t('credentialVault.envImport.description', {
              defaultValue: '把你的 .env 文件内容粘贴进来，TabTin 会自动识别常见 AI 服务（OpenAI / Anthropic / Serper / SendGrid 等）',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>
              {t('credentialVault.envImport.textLabel', { defaultValue: '.env 内容' })}
            </label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={'OPENAI_API_KEY=sk-...\nANTHROPIC_API_KEY=sk-ant-...\n# SERPER_API_KEY=...'}
              className={cn(SETTINGS_TEXTAREA_FULL, SETTINGS_TEXT_MICRO, 'font-mono')}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
            />
          </div>

          {parsed.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className={SETTINGS_LABEL}>
                  {t('credentialVault.envImport.recognized', {
                    count: parsed.length,
                    defaultValue: '识别到 {{count}} 个变量',
                  })}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (selected.size === parsed.length) setSelected(new Set())
                    else setSelected(new Set(parsed.map((p) => p.envKey)))
                  }}
                  className={cn(SETTINGS_TEXT_META, 'hover:text-foreground transition-colors')}
                >
                  {selected.size === parsed.length
                    ? t('credentialVault.envImport.unselectAll', { defaultValue: '取消全选' })
                    : t('credentialVault.envImport.selectAll', { defaultValue: '全选' })}
                </button>
              </div>
              <div className="rounded-lg border border-border/60 divide-y divide-border/40 max-h-60 overflow-y-auto">
                {parsed.map((entry) => (
                  <EnvRow
                    key={entry.envKey}
                    entry={entry}
                    selected={selected.has(entry.envKey)}
                    onToggle={() => toggle(entry.envKey)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('credentialVault.serviceKeys.cancel')}
          </Button>
          <Button onClick={handleImport} disabled={submitting || parsed.length === 0}>
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {t('credentialVault.envImport.import', {
              count: selected.size,
              defaultValue: '导入选中 ({{count}})',
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const EnvRow: React.FC<{ entry: ParsedEnvEntry; selected: boolean; onToggle: () => void }> = ({
  entry,
  selected,
  onToggle,
}) => {
  const isCustom = entry.preset === 'custom'
  return (
    <label
      className={cn(
        'flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors',
        selected ? 'bg-accent/[0.06]' : 'hover:bg-muted/20',
      )}
    >
      <input type="checkbox" className="h-3.5 w-3.5 shrink-0" checked={selected} onChange={onToggle} />
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-body font-medium text-foreground">{entry.serviceLabel}</span>
          {isCustom && (
            <span className={cn(SETTINGS_TEXT_META, 'shrink-0 rounded-md bg-muted/40 px-1.5 py-0.5')}>
              custom
            </span>
          )}
        </div>
        <div className={cn(SETTINGS_HINT, 'truncate font-mono')}>{entry.envKey}</div>
      </div>
      <code className={cn(SETTINGS_TEXT_META, 'text-muted-foreground/40', 'shrink-0 max-w-[40%] truncate font-mono')}>
        {entry.value.length > 12 ? `${entry.value.slice(0, 6)}…${entry.value.slice(-4)}` : entry.value}
      </code>
    </label>
  )
}
