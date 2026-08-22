/**
 * TrackerRunStatusIndicator — ChatSession UI 4 个表达点之 #4: 末尾 Run 状态指示器
 *
 * Charter v1.8 §6.7: 对话流末尾必须显示 Run 当前状态:
 *  - 进行中: ⏳ "Run 进行中"
 *  - 已结束: ✓/✗/⊘ + Run 编号 + 结束时间 + 用时,且明确告知用户"后续发的消息属于事后讨论,
 *    不会改变 Run 状态"
 */

import React, { useState } from 'react'
import {
  CheckCircle2, XCircle, Loader2, MinusCircle, Clock,
  Link as LinkIcon, Check, RefreshCw, ArrowRightLeft, ShieldCheck, Wallet, Hourglass,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { TrackerRunMeta, RecoveryAction } from '@tabtin/chat-client'
import { resolveArtifactAppFromSkill } from '@services/trackerArtifactMap'
import { getPrimaryContextRefTypeForApp } from '@services/manifestResourceIdMap'
import * as trackerApi from '@services/trackerApi'
import { displayFromRunStatus } from '@/services/trackerRunStatus'
import { invalidateTrackerAfterTrigger } from '@/services/invalidateTrackerAfterTrigger'

interface TrackerRunStatusIndicatorProps {
  trackerRun: TrackerRunMeta
  className?: string
}

/** Wave 6 续作 P0-4:RecoveryAction kind → 图标 */
function iconForRecoveryKind(kind: RecoveryAction['kind']) {
  switch (kind) {
    case 'rerun': return <RefreshCw className="h-3 w-3" aria-hidden />
    case 'retry_with_model': return <RefreshCw className="h-3 w-3" aria-hidden />
    case 'switch_agent': return <ArrowRightLeft className="h-3 w-3" aria-hidden />
    case 'check_permission': return <ShieldCheck className="h-3 w-3" aria-hidden />
    case 'adjust_budget': return <Wallet className="h-3 w-3" aria-hidden />
    case 'wait_and_rerun': return <Hourglass className="h-3 w-3" aria-hidden />
    default: return <RefreshCw className="h-3 w-3" aria-hidden />
  }
}

/** 由 TrackerRun.status 推导显示状态（统一走 trackerRunStatus） */
type Display = ReturnType<typeof displayFromRunStatus>

function displayFromStatus(status: string): Display {
  return displayFromRunStatus(status)
}

function formatTime(iso?: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return null
  }
}

function formatDuration(startIso?: string | null, endIso?: string | null): string | null {
  if (!startIso || !endIso) return null
  try {
    const start = new Date(startIso).getTime()
    const end = new Date(endIso).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    const ms = end - start
    if (ms < 1000) return '<1s'
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.floor(min / 60)
    return `${hr}h${min % 60}m`
  } catch {
    return null
  }
}

/**
 * 生成 Run 产物 deep link：用户复制 → 外部聊天工具粘贴 → Electron deep-link
 * 拦截后跳到对应产物。
 *
 * **W3 设计**（专题"Agent 产物在 Space 内的打开" RFC §10.3 / N0-4 / L13）：
 *   path 形态 `tabtin://resource/<type>/<id>?hint=<app>&...`，与 iOS 已自约定
 *   `tabtin://resource/<type>/<id>` 跨端 path 一致。
 *
 *   - `<type>` = ContextRefType（从 contextRegistry handler 反查，manifest 驱动）
 *   - `<id>` = 主资源 id（artifact_ref 中的具体产物字段优先；缺失退化为 run_id
 *     让 app 落主面板）
 *   - hint = 目标 carrier app id（D2 优先级第 3 层）
 *   - 其余 query：artifact_ref 全字段透传（camelCase）+ run / tracker 调试用
 *
 * 链接生成失败（skill_key 不命中 / handler 缺失）→ 返回 null，按钮降级不渲染。
 */
function buildArtifactLink(trackerRun: TrackerRunMeta): string | null {
  const app = resolveArtifactAppFromSkill(trackerRun.skill_key)
  if (!app) return null
  // `<type>` 取 manifest opens.types[0].type（ContextRefType，如 'memo' / 'document'）
  // 而非 ContextItemType（'tabmemo' / 'tabdoc'）——RFC §10.3 + iOS 跨端约定
  const refType = getPrimaryContextRefTypeForApp(app)
  if (!refType) return null
  const ref = trackerRun.artifact_ref
  // 主资源 id 优先级：具体产物字段 > artifact_id > run_id 兜底（让 app 落主面板）
  const resourceId =
    ref?.memo_id ||
    ref?.doc_id ||
    ref?.slide_id ||
    ref?.code_path ||
    ref?.artifact_id ||
    trackerRun.run_id
  const params = new URLSearchParams({
    hint: app,
    run: trackerRun.run_id,
    tracker: trackerRun.tracker_id,
  })
  if (ref) {
    if (ref.memo_id) params.set('memoId', ref.memo_id)
    if (ref.doc_id) params.set('docId', ref.doc_id)
    if (ref.slide_id) params.set('slideId', ref.slide_id)
    if (ref.code_path) params.set('codePath', ref.code_path)
    if (ref.artifact_id) params.set('artifactId', ref.artifact_id)
    if (Array.isArray(ref.record_ids) && ref.record_ids.length > 0) {
      params.set('recordIds', ref.record_ids.join(','))
    }
  }
  return `tabtin://resource/${encodeURIComponent(refType)}/${encodeURIComponent(resourceId)}?${params.toString()}`
}

export const TrackerRunStatusIndicator: React.FC<TrackerRunStatusIndicatorProps> = ({
  trackerRun,
  className,
}) => {
  const { t } = useTranslation('chat')
  const display = displayFromStatus(trackerRun.run_status)
  const finishedAt = formatTime(trackerRun.finished_at)
  const duration = formatDuration(trackerRun.started_at, trackerRun.finished_at)
  const artifactLink = display === 'success' ? buildArtifactLink(trackerRun) : null
  const [copied, setCopied] = useState(false)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const recoveryActions: RecoveryAction[] =
    display === 'failed' && Array.isArray(trackerRun.recovery_actions)
      ? trackerRun.recovery_actions
      : []

  const handleCopyLink = async () => {
    if (!artifactLink) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(artifactLink)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    } catch {
      // 剪贴板被禁用:静默失败,按钮无副作用
    }
  }

  /**
   * Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
   *   点击恢复动作按钮的统一处理。
   *
   *   - rerun / retry_with_model / wait_and_rerun → trackerApi.triggerTask 立即重跑
   *     (model 字段透传到 trigger_context.override_model,后端尚未消费时降级为
   *     沿用原配置 — 比"什么都不做"友好)
   *   - switch_agent → 跳自动化详情让用户改 agent(本期不做静默切换 Agent,
   *     避免误触发,符合 charter §4.3 "面板承担精调")
   *   - check_permission / adjust_budget → 跳 settings(adjust_budget→billing)
   *
   *   失败时 toast 错误,不让按钮"看上去成功了"。
   */
  const handleRecoveryAction = async (action: RecoveryAction, key: string) => {
    if (pendingActionKey) return
    setPendingActionKey(key)
    try {
      switch (action.kind) {
        case 'rerun':
        case 'wait_and_rerun': {
          await trackerApi.triggerTask(trackerRun.tracker_id)
          await invalidateTrackerAfterTrigger(trackerRun.tracker_id)
          toast.success(t('trackerRun.recoveryRerunSuccess', { defaultValue: '已重新触发' }))
          break
        }
        case 'retry_with_model': {
          await trackerApi.triggerTask(trackerRun.tracker_id, {
            override_model: action.model,
          })
          await invalidateTrackerAfterTrigger(trackerRun.tracker_id)
          toast.success(t('trackerRun.recoveryRerunSuccess', { defaultValue: '已重新触发' }))
          break
        }
        case 'switch_agent':
        case 'check_permission':
        case 'adjust_budget': {
          // 跳自动化详情让用户人工配置(charter §4.3 面板精调)
          // 这里不做跳转(避免在 chat 流里强行换面板),仅 toast 提示。
          toast.info(t('trackerRun.recoveryRedirect', {
            defaultValue: '请到自动化任务详情页继续操作',
          }))
          break
        }
        default: {
          // unknown kind:与 utils.py 的 fallback 行为一致 — 当作 rerun
          await trackerApi.triggerTask(trackerRun.tracker_id)
          await invalidateTrackerAfterTrigger(trackerRun.tracker_id)
          toast.success(t('trackerRun.recoveryRerunSuccess', { defaultValue: '已重新触发' }))
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t('trackerRun.recoveryFailed', {
        defaultValue: '操作失败:{{msg}}',
        msg,
      }))
    } finally {
      setPendingActionKey(null)
    }
  }

  /**
   * Wave 6 治理：横幅样式契约 — 容器永远白底 hairline，状态退到图标色 + label 文字色上。
   *
   * 旧版：每种状态各自染整片色面（bg-green-50 / bg-red-50 / bg-orange-50）+ 边框换色，
   *       且写死 Tailwind 原色（green-600 / red-600 / orange-600），不跟随主题切换。
   * 新版：tone class 只决定 label 文字色（point-only），容器统一 border-border/40 bg-background。
   *       图标用语义 token：success / destructive / warning，未来主题切换自动适配。
   *
   * P1-6 修复点保留：cancelled vs pending 仍要可区分——
   *   - cancelled 用 muted/70 + MinusCircle（"用户主动停止"语义）
   *   - pending   用 muted/60 + Clock（"待开始"语义）
   *   icon 形状本身就是区分点，无需再用整片橙色面。
   */
  const meta = (() => {
    switch (display) {
      case 'running':
        return {
          icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />,
          label: t('trackerRun.statusRunning', { defaultValue: 'Run 进行中' }),
          labelTone: 'text-accent',
        }
      case 'success':
        return {
          icon: <CheckCircle2 className="h-3.5 w-3.5 text-success/80" aria-hidden />,
          label: t('trackerRun.statusSuccess', { defaultValue: 'Run 已完成' }),
          labelTone: 'text-foreground/90',
        }
      case 'failed':
        return {
          icon: <XCircle className="h-3.5 w-3.5 text-destructive/80" aria-hidden />,
          label: t('trackerRun.statusFailed', { defaultValue: 'Run 失败' }),
          labelTone: 'text-destructive/80',
        }
      case 'cancelled':
        return {
          icon: <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/80" aria-hidden />,
          label: t('trackerRun.statusCancelled', { defaultValue: 'Run 已取消' }),
          labelTone: 'text-muted-foreground',
        }
      default:
        return {
          icon: <Clock className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden />,
          label: t('trackerRun.statusPending', { defaultValue: 'Run 待开始' }),
          labelTone: 'text-muted-foreground',
        }
    }
  })()

  const isFinished = display === 'success' || display === 'failed' || display === 'cancelled'

  return (
    <div
      className={cn(
        'mx-3 my-2 rounded-md border border-border/40 bg-background px-3 py-2 text-caption',
        className,
      )}
      data-testid="tracker-run-status-indicator"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">{meta.icon}</div>
        <div className="flex-1 space-y-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className={cn('text-body font-medium', meta.labelTone)}>
              {meta.label}
            </span>
            <span className="text-muted-foreground/80 tabular-nums">
              {t('trackerRun.runNumber', { defaultValue: 'Run #{{idx}}', idx: trackerRun.run_index })}
            </span>
            {finishedAt && (
              <span className="text-muted-foreground/60 tabular-nums">{finishedAt}</span>
            )}
            {duration && (
              <span className="text-muted-foreground/60 tabular-nums">· {duration}</span>
            )}
          </div>
          {/* charter §6.7 表达点 #4 关键约束: 已结束 Run 必须明确告知"后续消息属于事后讨论" */}
          {isFinished && (
            <div className="text-muted-foreground/60">
              {t('trackerRun.afterRunHint', {
                defaultValue: '后续发送的消息属于事后讨论,不会改变本次 Run 的状态。',
              })}
            </div>
          )}
          {/* Wave 6 (charter §4.4 / Phase 6.3 transcript 可读性):成功 Run 提供"复制产物链接" */}
          {artifactLink && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={handleCopyLink}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/60',
                  'px-2 py-0.5 text-caption text-muted-foreground/80 hover:bg-muted/40 transition-colors',
                )}
                data-testid="tracker-run-copy-artifact-link"
                aria-label={t('trackerRun.copyArtifactLink', { defaultValue: '复制产物链接' })}
              >
                {copied
                  ? <Check className="h-3 w-3 text-success" aria-hidden />
                  : <LinkIcon className="h-3 w-3" aria-hidden />}
                <span>
                  {copied
                    ? t('trackerRun.copied', { defaultValue: '已复制' })
                    : t('trackerRun.copyArtifactLink', { defaultValue: '复制产物链接' })}
                </span>
              </button>
            </div>
          )}
          {/* Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
              失败 Run 渲染可点击的恢复动作按钮列表(每条对应 1 个动作)。 */}
          {recoveryActions.length > 0 && (
            <div
              className="mt-1.5 flex flex-wrap gap-1.5"
              data-testid="tracker-run-recovery-actions"
            >
              {recoveryActions.map((action, idx) => {
                const key = `${action.kind}-${idx}`
                const pending = pendingActionKey === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void handleRecoveryAction(action, key)}
                    disabled={pending || pendingActionKey !== null}
                    // 恢复动作按钮跟横幅按钮同语言：白底 hairline + destructive 文字
                    // （"危险动作"语义留在文字色上承担，不再有 red-50 整片粉色面）
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-0.5 text-caption transition-colors',
                      'text-destructive/80 hover:bg-muted/40',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                    data-testid={`tracker-run-recovery-action-${action.kind}`}
                    data-action-kind={action.kind}
                    {...(action.model ? { 'data-action-model': action.model } : {})}
                    aria-label={action.label}
                  >
                    {pending
                      ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      : iconForRecoveryKind(action.kind)}
                    <span>{action.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
