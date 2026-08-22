/**
 * AgentMemoryGovernancePanel — AI 分身记忆治理面（；方案 A 两 Tab IA）
 *
 * 让用户管理**某个 Agent** 在自己名下记住的东西（严格 per-Agent）：
 *   - 概览：综合理解（UserPortrait 5 段小传 + hint / 整理）
 *   - 全部记录：AgentMemory 全类型统一列表（about_you / insight / task_summary / diary）
 *   - 导出：Markdown / JSON
 *
 * 数据：``/agent-memory`` + ``/user-portrait``（per agent_id）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Brain, Lightbulb, ListChecks, BookOpen,
  Loader2, FileOutput, ChevronDown, ShieldOff, AlertCircle, RefreshCw,
} from 'lucide-react'
import { Button, toast, ConfirmDialog } from '@components/ui'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import {
  AgentMemoryApiError,
  fetchAllAgentMemories,
  renderAgentMemoriesMarkdown,
  type AgentMemory,
  type AgentMemoryType,
} from '@/services/agentMemoryApi'
import {
  useAgentMemoryList,
  useInlineMemoryEdit,
  MemoryCorrectEditor,
  MemoryActionRow,
} from '@components/agent-memory/agentMemoryShared'
import { UserPortraitPanel } from '@components/space-settings/UserPortraitPanel'
import { SettingsTabs } from '../SettingsTabs'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from '../settingsUi'

const log = createLogger('AgentMemory')

type GovernanceTab = 'overview' | 'records'

const MEMORY_TYPE_ICON: Record<AgentMemoryType, typeof Brain> = {
  about_you: Brain,
  insight: Lightbulb,
  task_summary: ListChecks,
  diary: BookOpen,
}

function typeLabel(memoType: string, t: TFunction): string {
  const fallbacks: Record<string, string> = {
    about_you: '关于你', insight: '洞察', task_summary: '协作小结', diary: '日记',
  }
  return t(`types.${memoType}`, { defaultValue: fallbacks[memoType] ?? fallbacks.about_you })
}

function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 稍后释放，避免部分环境点击尚未完成就 revoke
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── 全部记录列表 ──

const MemoryRecordRow: React.FC<{
  memo: AgentMemory
  busy: boolean
  onUseful: (id: string) => void
  onCorrect: (id: string, content: string) => Promise<void>
  onForget: (id: string) => void
}> = ({ memo, busy, onUseful, onCorrect, onForget }) => {
  const { t } = useTranslation('agentMemory')
  const Icon = MEMORY_TYPE_ICON[memo.memory_type as AgentMemoryType] ?? MEMORY_TYPE_ICON.about_you
  const { editing, draft, setDraft, saving, startEdit, cancel, save } = useInlineMemoryEdit(memo, onCorrect)

  return (
    <div className="group rounded-xl border border-border/40 bg-card/40 p-3.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className={SETTINGS_TEXT_META}>{typeLabel(memo.memory_type, t)}</span>
        </div>
        {typeof memo.importance === 'number' && memo.importance > 0 && (
          <span
            className={cn(SETTINGS_TEXT_MICRO, 'text-amber-500 shrink-0')}
            title={t('importanceTitle', { count: memo.importance, defaultValue: `重要度 ${memo.importance}` })}
          >
            {'★'.repeat(Math.min(5, memo.importance))}
          </span>
        )}
      </div>

      {editing ? (
        <MemoryCorrectEditor
          draft={draft}
          saving={saving}
          onDraftChange={setDraft}
          onCancel={cancel}
          onSave={save}
        />
      ) : (
        <p className="text-body text-foreground/90 leading-relaxed whitespace-pre-wrap">{memo.content}</p>
      )}

      {memo.tags.filter(tag => !tag.startsWith('emotion:')).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {memo.tags.filter(tag => !tag.startsWith('emotion:')).slice(0, 6).map(tag => (
            <span key={tag} className={cn(SETTINGS_TEXT_MICRO, 'px-1.5 py-0.5 rounded-full bg-accent/8 text-muted-foreground/60')}>#{tag}</span>
          ))}
        </div>
      )}

      {!editing && (
        <MemoryActionRow
          busy={busy}
          className="mt-2"
          onUseful={() => onUseful(memo.id)}
          onEdit={startEdit}
          onForget={() => onForget(memo.id)}
        />
      )}
    </div>
  )
}

const MemoryRecordsList: React.FC<{
  organizationId: string
  agentId: string
  highlightMemoryId?: string
}> = ({ organizationId, agentId, highlightMemoryId }) => {
  const { t } = useTranslation('agentMemory')
  const [filter, setFilter] = useState<AgentMemoryType | ''>('')
  const {
    memos,
    loading,
    loadError,
    hasMore,
    busyId,
    forgetTarget,
    setForgetTarget,
    loadMore,
    reload,
    handleUseful,
    handleCorrect,
    doForget,
  } = useAgentMemoryList({
    organizationId,
    agentId,
    memoryType: filter || undefined,
  })

  const recordFilters: Array<{ key: AgentMemoryType | ''; label: string }> = [
    { key: '', label: t('governance.filters.all', { defaultValue: '全部' }) },
    { key: 'about_you', label: typeLabel('about_you', t) },
    { key: 'insight', label: typeLabel('insight', t) },
    { key: 'task_summary', label: typeLabel('task_summary', t) },
    { key: 'diary', label: typeLabel('diary', t) },
  ]

  return (
    <div className="relative space-y-4">
      <p className={SETTINGS_HINT}>
        {t('governance.records.hint', {
          defaultValue: '纠正或忘记条目后，「概览」里的综合理解会在下次整理时更新。',
        })}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {recordFilters.map(opt => (
          <button
            key={opt.key || 'all'}
            type="button"
            onClick={() => setFilter(opt.key)}
            className={cn(
              'rounded-full px-2.5 py-1 transition-colors', SETTINGS_TEXT_MICRO,
              filter === opt.key
                ? 'bg-foreground/[0.06] font-medium text-accent-text dark:bg-foreground/[0.08]'
                : 'text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <AlertCircle className="mb-2 h-6 w-6 text-destructive/80" />
          <p className="text-body text-muted-foreground/60">
            {t('governance.records.loadFailedTitle', { defaultValue: '加载记忆失败' })}
          </p>
          <p className={cn(SETTINGS_TEXT_META, 'mt-1 max-w-[320px] break-all text-muted-foreground/40')} title={loadError}>{loadError}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={reload}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('actions.retry', { defaultValue: '重试' })}
          </Button>
        </div>
      ) : memos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Brain className="mb-2 h-8 w-8 text-muted-foreground/20" />
          <p className="text-body text-muted-foreground/60">
            {t('governance.records.emptyTitle', { defaultValue: '这个 AI 分身还没有记忆记录' })}
          </p>
          <p className={cn(SETTINGS_TEXT_META, 'mt-1 text-muted-foreground/60')}>
            {t('governance.records.emptyHint', { defaultValue: '和 TA 协作后，记录会自动出现在这里' })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {memos.map(memo => (
            <div
              key={memo.id}
              className={cn(
                'rounded-xl transition-shadow',
                highlightMemoryId === memo.id && 'ring-2 ring-accent/60',
              )}
            >
              <MemoryRecordRow
                memo={memo}
                busy={busyId === memo.id}
                onUseful={handleUseful}
                onCorrect={handleCorrect}
                onForget={setForgetTarget}
              />
            </div>
          ))}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button variant="ghost" size="sm" onClick={loadMore} className={SETTINGS_HINT}>
                <ChevronDown className="mr-1.5 h-3 w-3" />{t('actions.loadMore', { defaultValue: '加载更多' })}
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!forgetTarget}
        onOpenChange={open => { if (!open) setForgetTarget(null) }}
        title={t('governance.forgetTitle', { defaultValue: '让这个 AI 分身忘记这条记忆？' })}
        description={t('diary.forgetDesc', { defaultValue: '忘记后，TA 之后不会再用到这条记忆，也不会在这里显示。此操作不可撤销。' })}
        confirmText={t('actions.forget', { defaultValue: '忘记' })}
        cancelText={t('actions.cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={() => { if (forgetTarget) void doForget(forgetTarget) }}
      />
    </div>
  )
}

// ── 主面板 ──

interface AgentMemoryGovernancePanelProps {
  organizationId: string
  agentId: string
  agentName: string
  agentAvatar?: string
  /** 深链：打开时聚焦到某条记忆（高亮 + 切到全部记录 tab）。 */
  focusMemoryId?: string
}

export const AgentMemoryGovernancePanel: React.FC<AgentMemoryGovernancePanelProps> = ({
  organizationId,
  agentId,
  agentName,
  agentAvatar: _agentAvatar,
  focusMemoryId,
}) => {
  const { t } = useTranslation('agentMemory')
  const organizationName = useOrganizationStore((state) => {
    if (state.selectedOrganization?.id === organizationId) {
      return state.selectedOrganization.name
    }
    return state.organizations.find(item => item.id === organizationId)?.name ?? ''
  })
  const ensureRecordStyleLoaded = useMemoRecordStyleStore(s => s.ensureLoaded)
  const memoryEnabled = useMemoRecordStyleStore(s => s.isEnabled(organizationId))

  const [tab, setTab] = useState<GovernanceTab>('overview')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void ensureRecordStyleLoaded(organizationId)
  }, [organizationId, ensureRecordStyleLoaded])

  useEffect(() => {
    if (focusMemoryId) setTab('records')
  }, [focusMemoryId])

  const handleExport = useCallback(async (format: 'markdown' | 'json') => {
    if (!organizationId || !agentId) return
    setExporting(true)
    try {
      const memories = await fetchAllAgentMemories({ organizationId, agentId })
      if (memories.length === 0) {
        // 关总闸时读侧 fail-closed 返回空——别伪装成「还没有记忆」，给「已关闭」人话
        // （与 CLI export 同口径）。
        toast({
          description: memoryEnabled
            ? t('governance.export.nothing', { defaultValue: '这个 AI 分身还没有可导出的记忆' })
            : t('governance.export.disabledEmpty', {
                defaultValue: '记忆记录已关闭，暂无可导出内容。可在「记忆」App →「记忆偏好」→「让 Agent 记笔记」重新打开。',
              }),
        })
        return
      }
      const safeName = agentName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'agent'
      const stamp = new Date().toISOString().slice(0, 10)
      const memoryWord = t('governance.export.filenameMemory', { defaultValue: '记忆' })
      if (format === 'markdown') {
        triggerDownload(
          `${safeName}-${memoryWord}-${stamp}.md`,
          renderAgentMemoriesMarkdown(memories, { agentName, organizationName }),
          'text/markdown;charset=utf-8',
        )
      } else {
        triggerDownload(
          `${safeName}-${memoryWord}-${stamp}.json`,
          JSON.stringify({ agent_id: agentId, agent_name: agentName, exported_at: new Date().toISOString(), memories }, null, 2),
          'application/json;charset=utf-8',
        )
      }
      toast({ description: t('governance.export.done', { count: memories.length, defaultValue: `已导出 ${memories.length} 条记忆` }) })
    } catch (err) {
      toast({
        description: err instanceof AgentMemoryApiError ? err.message : t('errors.exportFailed', { defaultValue: '导出失败' }),
        variant: 'destructive',
      })
      log.warn('导出 Agent 记忆失败', { agentId }, err)
    } finally {
      setExporting(false)
    }
  }, [organizationId, agentId, agentName, organizationName, memoryEnabled, t])

  const tabs: Array<{ key: GovernanceTab; label: string }> = [
    { key: 'overview', label: t('governance.tabs.overview', { defaultValue: '概览' }) },
    { key: 'records', label: t('governance.tabs.records', { defaultValue: '全部记录' }) },
  ]

  if (!organizationId) return null

  return (
    <div className="flex flex-col gap-4">
      {/* Tab 条 + 导出 */}
      <div className="flex items-center justify-between gap-2">
        <SettingsTabs
          tabs={tabs}
          activeKey={tab}
          onSelect={(key) => setTab(key as GovernanceTab)}
          className="min-w-0 flex-1 pb-0"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled={exporting} onClick={() => handleExport('markdown')} className={cn(SETTINGS_TEXT_MICRO, 'h-7 gap-1')}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileOutput className="h-3.5 w-3.5" />}
            Markdown
          </Button>
          <Button size="sm" variant="ghost" disabled={exporting} onClick={() => handleExport('json')} className={cn(SETTINGS_TEXT_MICRO, 'h-7 gap-1')}>
            <FileOutput className="h-3.5 w-3.5" />
            JSON
          </Button>
        </div>
      </div>

      {/* 记忆总闸关闭提示 */}
      {!memoryEnabled && (
        <div className="flex items-start gap-2 rounded-lg border border-border/40 bg-muted/20 p-3">
          <ShieldOff className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground/60" />
          <p className={cn(SETTINGS_TEXT_META, 'leading-relaxed')}>
            {t('governance.disabledNotice', {
              defaultValue: '记忆记录当前已关闭，AI 分身不再记录、召回或展示记忆。可在「记忆」App →「记忆偏好」→「让 Agent 记笔记」重新打开。',
            })}
          </p>
        </div>
      )}

      {/* Tab 内容 */}
      {tab === 'overview' && (
        <UserPortraitPanel
          enabled={memoryEnabled}
          canManage
          organizationId={organizationId}
          agentId={agentId}
          agentName={agentName}
        />
      )}
      {tab === 'records' && (
        <MemoryRecordsList organizationId={organizationId} agentId={agentId} highlightMemoryId={focusMemoryId} />
      )}
    </div>
  )
}

export default AgentMemoryGovernancePanel
