/**
 * AgentDiaryFeed — 某个 Agent 的「成长记录」时间线（ W3；W5 抽公共 + i18n）。
 *
 * 以时间线风格展示该 Agent 在当前用户名下的工作日记（memory_type=diary）。
 * 数据源为 **独立记忆领域端点** ``/agent-memory/memories/``（agentMemoryApi），
 * 不再经 ``/tabmemo/memos?source=agent`` 猜类型分流（封  前端假入口）。
 *
 * 「有用 / 纠正 / 忘记」直接落 /agent-memory 领域端点（复用 useAgentMemoryList）：
 *   - 有用 → feedback(useful=true)：重要度 +1。
 *   - 纠正 → correct：归档原记忆、新建替代记忆（保留溯源）。
 *   - 忘记 → forget：软删除（forgotten_at），之后默认读取全排除。
 *
 * 强制 per-Agent：缺 agentId / organizationId 时给出引导态，绝不跨 Agent 混排。
 */
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  Brain, ChevronDown, Loader2, RefreshCw, AlertCircle,
} from 'lucide-react'
import { Button, ScrollArea, ConfirmDialog } from '@components/ui'
import { cn } from '@utils/cn'
import { getCurrentLanguage } from '@/i18n'
import { type AgentMemory } from '@/services/agentMemoryApi'
import {
  useAgentMemoryList,
  useInlineMemoryEdit,
  MemoryCorrectEditor,
  MemoryActionRow,
} from './agentMemoryShared'

/** emotion → emoji（label 走 i18n，见 emotionLabel）。 */
const EMOTION_EMOJI: Record<string, string> = {
  happy: '😊',
  curious: '🤔',
  frustrated: '😤',
  relieved: '😌',
  surprised: '😮',
  reflective: '🪞',
  neutral: '📝',
}

function getEmotion(tags: string[]): string {
  const tag = tags?.find(t => t.startsWith('emotion:'))
  return tag ? tag.split(':')[1] : 'neutral'
}

function emotionLabel(emotion: string, t: TFunction): string {
  const fallbacks: Record<string, string> = {
    happy: '开心', curious: '好奇', frustrated: '受挫', relieved: '释然',
    surprised: '惊讶', reflective: '反思', neutral: '记录',
  }
  return t(`emotions.${emotion}`, { defaultValue: fallbacks[emotion] ?? fallbacks.neutral })
}

function typeLabel(memoType: string, t: TFunction): string {
  const fallbacks: Record<string, string> = {
    about_you: '关于你', insight: '洞察', task_summary: '任务摘要', diary: '工作日记',
  }
  return t(`types.${memoType}`, { defaultValue: fallbacks[memoType] ?? fallbacks.diary })
}

function formatRelativeTime(dateStr: string, t: TFunction): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return t('time.justNow', { defaultValue: '刚刚' })
  if (diffMin < 60) return t('time.minutesAgo', { count: diffMin, defaultValue: `${diffMin} 分钟前` })
  if (diffHour < 24) return t('time.hoursAgo', { count: diffHour, defaultValue: `${diffHour} 小时前` })
  if (diffDay < 7) return t('time.daysAgo', { count: diffDay, defaultValue: `${diffDay} 天前` })
  // 跟随 App 语言（i18n），而非运行时 / OS 默认 locale。
  return date.toLocaleDateString(getCurrentLanguage(), { month: 'short', day: 'numeric' })
}

function groupByDate(
  memos: AgentMemory[],
  t: TFunction,
): { label: string; memos: AgentMemory[] }[] {
  const groups: Map<string, AgentMemory[]> = new Map()
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const toKey = (d: Date) => d.toISOString().slice(0, 10)
  const todayKey = toKey(today)
  const yesterdayKey = toKey(yesterday)

  for (const memo of memos) {
    const key = toKey(new Date(memo.created_at))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(memo)
  }

  return Array.from(groups.entries()).map(([key, memos]) => {
    let label = key
    if (key === todayKey) label = t('time.today', { defaultValue: '今天' })
    else if (key === yesterdayKey) label = t('time.yesterday', { defaultValue: '昨天' })
    else {
      const d = new Date(key)
      label = d.toLocaleDateString(getCurrentLanguage(), { month: 'long', day: 'numeric', weekday: 'short' })
    }
    return { label, memos }
  })
}

const DiaryCard: React.FC<{
  memo: AgentMemory
  agentName: string
  agentAvatar?: string
  busy: boolean
  onLike: (id: string) => void
  onCorrect: (id: string, content: string) => Promise<void>
  onForget: (id: string) => void
}> = ({ memo, agentName, agentAvatar, busy, onLike, onCorrect, onForget }) => {
  const { t } = useTranslation('agentMemory')
  const emotion = getEmotion(memo.tags)
  const emotionEmoji = EMOTION_EMOJI[emotion] || EMOTION_EMOJI.neutral
  const { editing, draft, setDraft, saving, startEdit, cancel, save } = useInlineMemoryEdit(memo, onCorrect)

  return (
    <div className="group relative flex gap-3">
      {/* Avatar column */}
      <div className="shrink-0 pt-0.5">
        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500/20 to-blue-500/20 flex items-center justify-center ring-2 ring-background overflow-hidden">
          {agentAvatar ? (
            <img src={agentAvatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <Brain className="h-4 w-4 text-violet-500" />
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="flex-1 min-w-0 rounded-xl border border-border/30 bg-card/80 backdrop-blur-sm p-3.5 transition-all duration-200 hover:border-accent/30 hover:shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-body font-medium text-foreground truncate">{agentName}</span>
            <span className="shrink-0 text-caption px-1.5 py-0.5 rounded-full bg-accent/8 text-muted-foreground/60">
              {typeLabel(memo.memory_type, t)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            <span className="text-caption tabular-nums text-muted-foreground/40">
              {formatRelativeTime(memo.created_at, t)}
            </span>
            <span
              // eslint-disable-next-line tabtin/no-design-system-violations -- emoji 图标显示尺寸，非文字字号
              className="text-[13px]"
              title={emotionLabel(emotion, t)}
            >
              {emotionEmoji}
            </span>
          </div>
        </div>

        {/* Content / inline correct editor */}
        {editing ? (
          <MemoryCorrectEditor
            draft={draft}
            saving={saving}
            onDraftChange={setDraft}
            onCancel={cancel}
            onSave={save}
          />
        ) : (
          <div className="text-body text-foreground/90 leading-relaxed whitespace-pre-wrap">
            {memo.content}
          </div>
        )}

        {/* Tags + importance */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {memo.tags.filter(t => !t.startsWith('emotion:')).slice(0, 5).map(tag => (
            <span key={tag} className="text-caption px-1.5 py-0.5 rounded-full bg-accent/8 text-muted-foreground/60">
              #{tag}
            </span>
          ))}
          {typeof memo.importance === 'number' && memo.importance > 0 && (
            <span
              className="text-caption text-amber-500"
              title={t('importanceTitle', { count: memo.importance, defaultValue: `重要度 ${memo.importance}` })}
            >
              {'★'.repeat(Math.min(5, memo.importance))}
            </span>
          )}
        </div>

        {/* Actions — visible on hover */}
        {!editing && (
          <MemoryActionRow
            busy={busy}
            className="mt-2.5"
            onUseful={() => onLike(memo.id)}
            onEdit={startEdit}
            onForget={() => onForget(memo.id)}
          />
        )}
      </div>
    </div>
  )
}

interface AgentDiaryFeedProps {
  organizationId: string
  agentId?: string
  agentName?: string
  agentAvatar?: string
  className?: string
  /** @deprecated 兼容旧 context handler 调用签名；数据已改为按 agentId 拉取。 */
  spaceId?: string
  /** @deprecated 已无过滤维度；保留仅为兼容旧调用点。 */
  initialFilter?: string
}

export const AgentDiaryFeed: React.FC<AgentDiaryFeedProps> = ({
  organizationId,
  agentId,
  agentName = 'Tin',
  agentAvatar,
  className,
}) => {
  const { t } = useTranslation('agentMemory')
  const {
    scope,
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
  } = useAgentMemoryList({ organizationId, agentId, memoryType: 'diary' })

  const grouped = useMemo(() => groupByDate(memos, t), [memos, t])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-violet-500/20 to-blue-500/20 flex items-center justify-center ring-2 ring-background overflow-hidden">
              {agentAvatar ? (
                <img src={agentAvatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <Brain className="h-4.5 w-4.5 text-violet-500" />
              )}
            </div>
            <div>
              <h2 className="text-subtitle font-semibold text-foreground">
                {t('diary.title', { name: agentName, defaultValue: `${agentName} 的成长记录` })}
              </h2>
              <p className="text-caption text-muted-foreground/60">
                {t('diary.subtitle', { defaultValue: 'TA 在和你协作里记下的所思所想' })}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={reload} className="h-7 w-7 p-0">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Feed */}
      <ScrollArea className="flex-1">
        <div className="px-5 pb-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <AlertCircle className="h-6 w-6 text-destructive/80 mb-2" />
              <p className="text-body text-muted-foreground/60">
                {t('diary.loadFailedTitle', { defaultValue: '加载成长记录失败' })}
              </p>
              <p className="text-caption text-muted-foreground/40 mt-1 break-all max-w-[320px]" title={loadError}>{loadError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={reload}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />{t('actions.retry', { defaultValue: '重试' })}
              </Button>
            </div>
          ) : !scope ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="h-12 w-12 rounded-full bg-muted/20 flex items-center justify-center mb-3">
                <Brain className="h-6 w-6 text-muted-foreground/20" />
              </div>
              <p className="text-body text-muted-foreground/40">
                {t('diary.selectAgent', { defaultValue: '选择一个 Agent 查看成长记录' })}
              </p>
            </div>
          ) : memos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="h-12 w-12 rounded-full bg-muted/20 flex items-center justify-center mb-3">
                <Brain className="h-6 w-6 text-muted-foreground/20" />
              </div>
              <p className="text-body text-muted-foreground/40">
                {t('diary.emptyTitle', { defaultValue: '还没有成长记录' })}
              </p>
              <p className="text-caption text-muted-foreground/30 mt-1">
                {t('diary.emptyHint', { defaultValue: '和 TA 协作后，工作日记会自动出现在这里' })}
              </p>
            </div>
          ) : (
            <>
              {grouped.map(group => (
                <div key={group.label}>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-caption font-medium text-muted-foreground/60">{group.label}</span>
                    <div className="flex-1 h-px bg-border/20" />
                  </div>
                  <div className="space-y-3">
                    {group.memos.map(memo => (
                      <DiaryCard
                        key={memo.id}
                        memo={memo}
                        agentName={agentName}
                        agentAvatar={agentAvatar}
                        busy={busyId === memo.id}
                        onLike={handleUseful}
                        onCorrect={handleCorrect}
                        onForget={setForgetTarget}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {hasMore && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadMore}
                    className="text-caption text-muted-foreground/60"
                  >
                    <ChevronDown className="h-3 w-3 mr-1.5" />
                    {t('actions.loadMore', { defaultValue: '加载更多' })}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={!!forgetTarget}
        onOpenChange={open => { if (!open) setForgetTarget(null) }}
        title={t('diary.forgetTitle', { defaultValue: '让这个 Agent 忘记这条记录？' })}
        description={t('diary.forgetDesc', { defaultValue: '忘记后，TA 之后不会再用到这条记忆，也不会在这里显示。此操作不可撤销。' })}
        confirmText={t('actions.forget', { defaultValue: '忘记' })}
        cancelText={t('actions.cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={() => { if (forgetTarget) void doForget(forgetTarget) }}
      />
    </div>
  )
}
