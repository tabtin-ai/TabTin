/**
 * UserPortraitPanel — 用户画像设置面板（USER 层 / v0.2 per-Organization）
 *
 * 替换原"Agent 记忆库"区块。详
 *
 * v0.2 关键变更：
 *   - 接收 organizationId props（来自 Space.organization_id）
 *   - 没有"调整 Organization 范围"入口——画像 per-(user, organization) 物理隔离
 *
 * v0.2 review 修复（波 1）：
 *   - 加载/网络失败显式 banner + 重试按钮（区别于"蒸馏失败"banner）
 *   - hint 提交失败时输入框保留用户文字（不清空）
 *   - 蒸馏中遮罩在空画像首次蒸馏时也显示
 *   - 轮询超时显式提示"仍在处理"+ 手动刷新
 *   - distill 调度成功后展示后端 message（轻提示）
 *
 * 功能：
 *   - 顶部状态条：上次整理时间（立即整理按钮见  临时开关）
 *   - 5 段叙事展示（content_md 解析自动渲染）
 *   - 底部 hint 输入区（D7：提交立即触发蒸馏，超 200 字软提示）
 *   - 状态机：空状态（新 Organization）/ 正常 / loading / 蒸馏中 / 蒸馏失败 / 加载失败
 *   - ：手动整理按钮与整理失败 UI（banner / notice）临时全部关闭——失败静默
 */

import React, { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw,
  Sparkles,
  AlertCircle,
  Loader2,
  Send,
  Clock,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, ScrollArea, Textarea } from '@components/ui'
import { cn } from '@utils/cn'
import { useUserPortrait } from '@/hooks/useUserPortrait'
import {
  parsePortraitSections,
  type UserPortrait,
  UserPortraitApiError,
} from '@/services/userPortraitApi'

// 跟后端 HINT_SOFT_LIMIT_CHARS 保持一致
const HINT_SOFT_LIMIT = 200
const HINT_HARD_LIMIT = 2000

// 轻提示自动消失时长
const TRANSIENT_NOTICE_MS = 4000

/**
 * ：蒸馏根因未修前的临时 UI 开关（导出供单测断言）。
 * 关闭后：不渲染「立即整理」、失败 banner，也不把 last_distill_error 写入 notice——失败静默。
 * 后端任务 / hint 入队 / 定时扫描不变；根因修复后两项改回 true。
 */
export const SHOW_MANUAL_DISTILL_BUTTON = false
export const SHOW_DISTILL_FAILED_RETRY_BANNER = false

function resolveAgentDisplayName(agentName: string | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  const trimmed = agentName?.trim()
  if (trimmed) return trimmed
  return t('userPortrait.defaultAgentName', { defaultValue: 'Tin' })
}

// ── 时间格式化 ──────────────────────────────────────

function formatRelativeTime(iso: string | null, t: (k: string) => string): string {
  if (!iso) return t('userPortrait.neverDistilled')
  const dt = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - dt.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return t('userPortrait.justNow')
  if (diffMin < 60) return `${diffMin} ${t('userPortrait.minAgo')}`
  if (diffHour < 24) return `${diffHour} ${t('userPortrait.hourAgo')}`
  if (diffDay < 7) return `${diffDay} ${t('userPortrait.dayAgo')}`
  return dt.toLocaleDateString()
}

// ── 顶部状态条 ──────────────────────────────────────

const TopStatusBar: React.FC<{
  portrait: UserPortrait | null
  isDistilling: boolean
  onTriggerDistill: () => void
  disabled: boolean
}> = ({ portrait, isDistilling, onTriggerDistill, disabled }) => {
  const { t } = useTranslation('space')
  const lastTime = formatRelativeTime(portrait?.last_distilled_at ?? null, t)

  return (
    <div className="rounded-lg border border-border/40 bg-card/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted-foreground/60">
          {t('userPortrait.lastDistilled')}
          <span className="ml-1 text-foreground/80">{lastTime}</span>
        </span>
        {SHOW_MANUAL_DISTILL_BUTTON && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onTriggerDistill}
            disabled={disabled || isDistilling}
            className="h-7 gap-1.5 text-caption"
          >
            {isDistilling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {t('userPortrait.distillNow')}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── 5 段叙事展示 ─────────────────────────────────────

const PortraitContent: React.FC<{ portrait: UserPortrait }> = ({ portrait }) => {
  const sections = parsePortraitSections(portrait.content_md)
  if (sections.length === 0) return null

  return (
    <div className="space-y-5">
      {sections.map((section, idx) => (
        <div key={`${idx}-${section.title}`}>
          <div className="text-body font-medium text-foreground mb-1.5">
            {section.title}
          </div>
          <div className="h-px bg-border/30 mb-2.5" />
          <p className="text-body text-foreground/80 leading-relaxed whitespace-pre-wrap">
            {section.body}
          </p>
        </div>
      ))}
    </div>
  )
}

// ── 空状态 ─────────────────────────────────────────

const EmptyState: React.FC<{ agentName: string }> = ({ agentName }) => {
  const { t } = useTranslation('space')
  return (
    <div className="text-center py-10 px-6">
      <div className="text-heading mb-3" aria-hidden>🌱</div>
      <p className="text-body font-medium text-foreground mb-2">
        {t('userPortrait.empty.title', { name: agentName })}
      </p>
      <p className="text-caption text-muted-foreground/60 leading-relaxed whitespace-pre-line">
        {t('userPortrait.empty.hint', { name: agentName })}
      </p>
    </div>
  )
}

// ── Loading 遮罩（蒸馏中） ─────────────────────────

const DistillingOverlay: React.FC<{ agentName: string }> = ({ agentName }) => {
  const { t } = useTranslation('space')
  return (
    <div className="absolute inset-0 z-overlay bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2 rounded-lg">
      <Loader2 className="h-6 w-6 animate-spin text-accent" />
      <p className="text-body font-medium text-foreground">
        {t('userPortrait.distilling.title', { name: agentName })}
      </p>
      <p className="text-caption text-muted-foreground/60">
        {t('userPortrait.distilling.hint')}
      </p>
    </div>
  )
}

// ── 加载失败 banner（hook.loadError；网络/权限/后端异常） ─────

const LoadErrorBanner: React.FC<{
  message: string
  onRetry: () => void
  disabled: boolean
}> = ({ message, onRetry, disabled }) => {
  const { t } = useTranslation('space')
  return (
    <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-body text-destructive font-medium">
          {t('userPortrait.loadFailed.title')}
        </p>
        <p className="text-caption text-muted-foreground/60 mt-0.5">
          {t('userPortrait.loadFailed.hint')}
        </p>
        <p className="text-caption text-muted-foreground/40 mt-1 break-all" title={message}>
          {message}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onRetry}
        disabled={disabled}
        className="h-7 text-caption"
      >
        <RefreshCw className="h-3.5 w-3.5 mr-1" />
        {t('userPortrait.loadFailed.retry')}
      </Button>
    </div>
  )
}

// ── 蒸馏失败 banner（portrait.last_distill_status === 'failed'） ─

const DistillFailedBanner: React.FC<{
  error: string
  onRetry: () => void
  disabled: boolean
}> = ({ error, onRetry, disabled }) => {
  const { t } = useTranslation('space')
  return (
    <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-body text-destructive font-medium">
          {t('userPortrait.failed.title')}
        </p>
        <p className="text-caption text-muted-foreground/60 mt-0.5 break-all" title={error}>
          {error}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onRetry}
        disabled={disabled}
        className="h-7 text-caption"
      >
        <RefreshCw className="h-3.5 w-3.5 mr-1" />
        {t('userPortrait.failed.retry')}
      </Button>
    </div>
  )
}

// ── 仍在处理 banner（轮询超时但后端可能仍在跑） ──

const StillDistillingBanner: React.FC<{
  onRefresh: () => void
  disabled: boolean
}> = ({ onRefresh, disabled }) => {
  const { t } = useTranslation('space')
  return (
    <div className="flex items-start gap-2 p-3 rounded-md bg-warning/10 border border-warning/20">
      <Clock className="h-4 w-4 text-warning shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-body text-warning font-medium">
          {t('userPortrait.stillDistilling.title')}
        </p>
        <p className="text-caption text-muted-foreground/60 mt-0.5">
          {t('userPortrait.stillDistilling.hint')}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onRefresh}
        disabled={disabled}
        className="h-7 text-caption"
      >
        <RefreshCw className="h-3.5 w-3.5 mr-1" />
        {t('userPortrait.stillDistilling.refresh')}
      </Button>
    </div>
  )
}

// ── 底部 Hint 输入区 ─────────────────────────────────

const HintInput: React.FC<{
  agentName: string
  onSubmit: (text: string) => Promise<void>
  disabled: boolean
}> = ({ agentName, onSubmit, disabled }) => {
  const { t } = useTranslation('space')
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const trimmed = text.trim()
  const hasText = trimmed.length > 0
  const overSoftLimit = trimmed.length > HINT_SOFT_LIMIT
  const overHardLimit = trimmed.length > HINT_HARD_LIMIT

  const handleSubmit = useCallback(async () => {
    if (!hasText || overHardLimit || submitting) return
    setSubmitting(true)
    let succeeded = false
    try {
      await onSubmit(trimmed)
      succeeded = true
    } catch {
      // P0-3：失败时**不清空文本**——用户的字保留下来，能立刻再发一次。
      // 错误展示统一由父组件的 submitNotice / 上方 banner 处理。
    } finally {
      setSubmitting(false)
      if (succeeded) setText('')
    }
  }, [hasText, overHardLimit, submitting, trimmed, onSubmit])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/60 p-3 space-y-2">
      <div className="text-caption text-muted-foreground/60 flex items-center gap-1.5">
        💬 <span>{t('userPortrait.hintInput.label', { name: agentName })}</span>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('userPortrait.hintInput.placeholder')}
        disabled={disabled || submitting}
        rows={2}
        className={cn(
          'w-full resize-none bg-transparent',
          'placeholder:text-muted-foreground/40',
        )}
      />
      <div className="flex items-center justify-between">
        <div className="text-caption text-muted-foreground/40">
          {overSoftLimit && !overHardLimit && (
            <span className="text-warning/80">
              {t('userPortrait.hintInput.softLimit', { limit: HINT_SOFT_LIMIT })}
            </span>
          )}
          {overHardLimit && (
            <span className="text-destructive">
              {t('userPortrait.hintInput.hardLimit', { limit: HINT_HARD_LIMIT })}
            </span>
          )}
        </div>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!hasText || overHardLimit || submitting || disabled}
          className="h-7 gap-1.5 text-caption"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {t('userPortrait.hintInput.send')}
        </Button>
      </div>
    </div>
  )
}

// ── 主组件 ──────────────────────────────────────────

interface UserPortraitPanelProps {
  /** 是否启用：跟随 MemoryPanel 的"启用智能记忆"开关 */
  enabled: boolean
  /** 用户能否管理 */
  canManage: boolean
  /** 当前 Organization ID（必传，API 查询锚点） */
  organizationId: string
  /**
   * 当前 Agent ID（/#4118 关键：画像按 Agent 完全隔离，读写都要该键）。
   * 缺省（''）时面板展示"请从具体 Agent 详情页查看"的过渡态空态，不请求
   * 后端、不猜测 Agent——遗留的组织级调用点（尚未接入 Agent 上下文）迁移
   * 到具体 Agent 详情页前会先看到这个提示。
   */
  agentId?: string
  /** Agent 展示名（空态 / hint 等用户可见文案） */
  agentName?: string
}

export const UserPortraitPanel: React.FC<UserPortraitPanelProps> = ({
  enabled,
  canManage,
  organizationId,
  agentId = '',
  agentName,
}) => {
  const { t } = useTranslation('space')
  const displayAgentName = resolveAgentDisplayName(agentName, t)
  const {
    portrait,
    isLoading,
    loadError,
    isDistilling,
    isStillDistilling,
    refresh,
    submitHint,
    triggerDistill,
  } = useUserPortrait(organizationId, agentId, enabled)

  /**
   * 轻提示槽位——调度成功 / hint 软警告 / hint 提交失败等一闪而过。
   * 加载失败走 LoadErrorBanner；蒸馏失败 UI 由 SHOW_DISTILL_FAILED_RETRY_BANNER 控制（ 关闭=静默）。
   */
  type Notice = { kind: 'info' | 'warn' | 'error'; text: string }
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), TRANSIENT_NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  const handleSubmitHint = useCallback(
    async (text: string) => {
      setNotice(null)
      try {
        const result = await submitHint(text)
        if (result.soft_warning) {
          setNotice({ kind: 'warn', text: result.soft_warning })
        } else if (result.distill_dispatched !== false) {
          setNotice({ kind: 'info', text: t('userPortrait.distillScheduled') })
        }
      } catch (err) {
        const msg = err instanceof UserPortraitApiError ? err.message : String(err)
        setNotice({
          kind: 'error',
          text: `${t('userPortrait.hintInput.submitFailed')} ${msg ? `(${msg})` : ''}`.trim(),
        })
        // P0-3：rethrow，让 HintInput 走失败分支保留用户输入
        throw err
      }
    },
    [submitHint, t],
  )

  // ：按钮/retry banner 关闭时运行时不可达；保留以便开关改回 true 后无需重写。
  const handleTriggerDistill = useCallback(async () => {
    setNotice(null)
    try {
      const result = await triggerDistill()
      // ：accepted=false = 无材料跳过 / Celery 调度失败（后端 message 为人话）
      if (result.accepted === false) {
        setNotice({
          kind: 'info',
          text: result.message || t('userPortrait.distillSkipped'),
        })
      } else if (result.message) {
        setNotice({ kind: 'info', text: result.message })
      } else {
        setNotice({ kind: 'info', text: t('userPortrait.distillScheduled') })
      }
    } catch (err) {
      const msg = err instanceof UserPortraitApiError ? err.message : String(err)
      setNotice({ kind: 'error', text: msg })
    }
  }, [triggerDistill, t])

  if (!enabled) {
    return (
      <div className="text-center py-6 px-4 text-caption text-muted-foreground/60">
        {t('userPortrait.disabled')}
      </div>
    )
  }

  if (!organizationId) {
    return (
      <div className="text-center py-6 px-4 text-caption text-muted-foreground/60">
        {t('userPortrait.noOrganization')}
      </div>
    )
  }

  // /#4118：画像按 Agent 完全隔离，没有"组织共享一份"的画像了——
  // 缺 agentId 的调用点（尚未接入具体 Agent 上下文）引导去 Agent 详情页查看。
  if (!agentId) {
    return (
      <div className="text-center py-6 px-4 text-caption text-muted-foreground/60">
        {t('userPortrait.noAgent', {
          defaultValue: '画像现在按 Agent 分别保存，请在具体 Agent 的记忆页查看',
        })}
      </div>
    )
  }

  const disabled = isLoading || !canManage
  const hasContent = !!portrait && portrait.content_md.trim().length > 0
  // 当前任务已开始时，portrait 可能暂时仍带着上一轮的 failed 状态；
  // 这不是本次任务的终态，避免同时展示“正在整理”和“整理失败”。
  const isDistillFailed = !isDistilling && portrait?.last_distill_status === 'failed'

  // 加载失败但还没拿到 portrait 时不渲染主体——避免空状态混淆"没画像"和"加载失败"
  const showLoadErrorOnly = !!loadError && !portrait

  // 加载失败且无可用画像时，禁用 hint 输入（顶栏手动整理入口  已隐藏）——
  // 用户应先点加载失败 banner 上的「重试」恢复加载，再做后续操作。
  const blockedByLoadError = showLoadErrorOnly

  return (
    <div className="space-y-4 relative">
      <TopStatusBar
        portrait={portrait}
        isDistilling={isDistilling}
        onTriggerDistill={handleTriggerDistill}
        disabled={disabled || blockedByLoadError}
      />

      {/* P0-2：加载/网络错误优先展示，且自带重试按钮 */}
      {loadError && (
        <LoadErrorBanner
          message={loadError}
          onRetry={() => void refresh()}
          disabled={isLoading}
        />
      )}

      {/* 蒸馏失败 retry banner：跟加载失败分开；#8317 临时关闭=失败静默（不写 notice） */}
      {SHOW_DISTILL_FAILED_RETRY_BANNER && isDistillFailed && portrait?.last_distill_error && (
        <DistillFailedBanner
          error={portrait.last_distill_error}
          onRetry={() => void handleTriggerDistill()}
          disabled={disabled}
        />
      )}

      {/* 🟡-1：轮询超时但后端可能仍在跑 */}
      {isStillDistilling && (
        <StillDistillingBanner
          onRefresh={() => void refresh()}
          disabled={isLoading}
        />
      )}

      {notice && (
        <div
          className={cn(
            'px-3 py-2 rounded-md text-caption',
            notice.kind === 'info' && 'bg-info/10 text-info/90',
            notice.kind === 'warn' && 'bg-warning/10 text-warning/80',
            notice.kind === 'error' && 'bg-destructive/10 text-destructive/90',
          )}
        >
          {notice.text}
        </div>
      )}

      {!showLoadErrorOnly && (
        <div className="relative min-h-[200px]">
          {isLoading && !portrait ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : hasContent && portrait ? (
            <ScrollArea className="max-h-[480px]">
              <PortraitContent portrait={portrait} />
            </ScrollArea>
          ) : (
            <EmptyState agentName={displayAgentName} />
          )}

          {/* 🟡-2：空画像首次蒸馏也要看到遮罩 */}
          {isDistilling && <DistillingOverlay agentName={displayAgentName} />}
        </div>
      )}

      {/*
        HintInput 用 (organizationId, agentId) 作 key，确保切换 Organization / Agent
        时草稿被清空——防止用户在 A 写到一半切到 B 后误把 A 的内容发到 B 的画像里
        （画像按 Agent 完全隔离的关键体验保障）。
      */}
      <HintInput
        key={`${organizationId}:${agentId}`}
        agentName={displayAgentName}
        onSubmit={handleSubmitHint}
        disabled={disabled || isDistilling || blockedByLoadError}
      />
    </div>
  )
}
