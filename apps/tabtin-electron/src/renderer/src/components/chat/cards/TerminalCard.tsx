/**
 * TerminalCard — Rich terminal output card for agent chat.
 *
 * Renders shell command results with structured header (command + status label),
 * scrollable stdout/stderr body, and optional cwd footer.
 * Self-registers as 'TerminalCard' in the card renderer registry.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Copy, Check, ExternalLink, Loader2, Square, ArrowDownToLine } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea, toast } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import type { TerminalOutputData } from '@tabtin/chat-client'
import {
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
} from '../registry/chatDesignTokens'

import { safeCopyToClipboard } from '../utils/clipboard'
import { getShellFailureLabel } from '@utils/chat/shellFailureReason'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { truncateTerminalOutput } from './utils/truncateOutput'
import {
  resolveTerminalSessionSpaceId,
  useAgentTerminalTranscriptStore,
  useTerminalSessionStore,
} from '@components/context-space/sources/terminal'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const TRANSCRIPT_SNAPSHOT_COLS = 120
const TRANSCRIPT_SNAPSHOT_ROWS = 30
const TRANSCRIPT_SCROLLBACK_LINES = 1000

/** 从 `max-h-[Npx]` token 解析像素；失败时回落 fallback。 */
function parseCardMaxHeightPx(token: string, fallback: number): number {
  const match = token.match(/max-h-\[(\d+)px\]/)
  return match ? Number(match[1]) : fallback
}

/** 与 CARD_MAX_HEIGHT.md 对齐的输出区内滚上限（250px）。 */
export const TERMINAL_OUTPUT_MAX_HEIGHT_PX = parseCardMaxHeightPx(CARD_MAX_HEIGHT.md, 250)

/**
 * start/loading 骨架 min-height：对齐 CARD_MAX_HEIGHT.xs（96），稳定有界。
 * 刻意小于 md(250)，避免短完成态永久撑满输出区。
 */
export function terminalLoadingSkeletonMinHeightPx(): number {
  return parseCardMaxHeightPx(CARD_MAX_HEIGHT.xs, 96)
}

type TerminalDisplayStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'terminated'
  | 'app_exit'
  | 'backgrounded'
  // Layer 3 诚实降级：前两层全失效、running 快照超 hard_timeout 仍无终态时，
  // Django celery 把它标成 status:"unknown"——前端据此渲染"运行状态未知"中性态
  // （非失败红），而不是无限转圈。
  | 'unknown'

interface TerminalCardProps {
  command?: string
  stdout: string
  stderr: string
  exitCode: number | null
  cwd: string
  backgrounded?: boolean
  displayStatus?: TerminalDisplayStatus
  startedAt?: number
  sessionId?: string
  spaceId?: string
  /**
   * Runtime tool-call metadata 里的用户可见意图摘要。
   *
   * 渲染契约：
   * - 非空 string → 在 header 上方显示一行（caption 字号 / muted 颜色 / 单行
   *   truncate），让用户先读"AI 想干什么"再读实际命令。
   * - 缺省 / 空字符串 / 非 string → 整行不渲染，header 保持原状。
   *
   * 旧历史消息仍可从 input.description 读取；新消息不再把意图放进工具参数。
   */
  description?: string
  /**
   * 当前 UI 标签组 scope（`conversation:<id>` / `desktop:...`）。
   *
   * 「查看终端」跳转必须把 tab 开进**面板实际在读的桶**——右侧工作台按
   * `itemsBySpace[tabScopeKey]` 渲染标签（见 SpaceContextContainer 的
   * `effectiveTabScopeKey`）。缺省（历史回放 / 非对话场景拿不到 scope）退化到
   * 反解出的 spaceId，保持向后兼容。
   */
  tabScopeKey?: string | null
}

function normalizeTranscriptSnapshotText(value: string): string {
  return value.replace(/\r?\n/g, '\r\n')
}

function buildTranscriptSnapshotOutput(command: string | undefined, stdout: string, stderr: string): string {
  const parts: string[] = []
  if (command?.trim()) {
    parts.push(`$ ${command.trim()}\r\n`)
  }
  if (stdout) {
    parts.push(normalizeTranscriptSnapshotText(stdout))
  }
  if (stderr) {
    if (parts.length > 0 && !parts[parts.length - 1].endsWith('\r\n')) {
      parts.push('\r\n')
    }
    parts.push(`\x1b[31m${normalizeTranscriptSnapshotText(stderr)}\x1b[0m`)
  }
  return parts.join('')
}

async function persistAgentTranscriptSnapshotIfNeeded(params: {
  sessionId: string
  command?: string
  stdout: string
  stderr: string
  cwd: string
}): Promise<void> {
  if (!params.sessionId.startsWith('agent-')) return
  const pty = window.tabtin?.pty
  if (!pty?.snapshotSave) return

  try {
    const exists = await pty.has?.(params.sessionId)
    if (exists?.exists) return
  } catch {
    // 如果 has 失败，仍尽力保存快照，避免历史 transcript 点开后空白。
  }

  const ansiOutput = buildTranscriptSnapshotOutput(params.command, params.stdout, params.stderr)
  if (!ansiOutput.trim()) return

  await pty.snapshotSave([{
    sessionId: params.sessionId,
    ansiOutput,
    cwd: params.cwd,
    cols: TRANSCRIPT_SNAPSHOT_COLS,
    rows: TRANSCRIPT_SNAPSHOT_ROWS,
    scrollbackLines: TRANSCRIPT_SCROLLBACK_LINES,
    capturedAt: Date.now(),
  }]).catch(() => undefined)
}

const TerminalCard: React.FC<TerminalCardProps> = React.memo(
  ({ command, stdout, stderr, exitCode, cwd, backgrounded, displayStatus, startedAt, sessionId, spaceId: spaceIdProp, tabScopeKey }) => {
    const { t } = useTranslation('chat')
    const [copied, setCopied] = useState(false)
    const [stopPending, setStopPending] = useState(false)
    const [detachPending, setDetachPending] = useState(false)

    // 部分终端来源（PTY 快照 / 终端 buffer 回显）会把 `$ 命令` 提示行写进
    // stdout。卡片已单独渲染命令输入行，这里精确剥离 stdout 开头与命令完全
    // 重复的 echo 行，避免命令显示两遍；只在严格相等时剥离，不误删真实输出。
    const rawStdout = useMemo(
      () => stripEchoedCommandLine(stdout, command),
      [stdout, command],
    )
    // 「单行长 JSON」stdout（tabtin CLI / API 类命令的典型输出）pretty-print
    // 成可读缩进——仅用于屏幕显示；复制路径（fullText）保留原始字节，用户
    // 复制拿到的是命令的真实输出而非改写后文本。
    const normalizedStdout = useMemo(
      () => prettifySingleLineJsonStdout(rawStdout),
      [rawStdout],
    )

    const fullText = [rawStdout, stderr].filter(Boolean).join('\n')
    const { displayStdout, displayStderr, isTruncated } = truncateTerminalOutput(normalizedStdout, stderr)

    const hasOutput = !!(normalizedStdout || stderr)

    const sessionFromStore = useTerminalSessionStore(
      state => {
        if (!sessionId) return null
        // 先按 spaceIdProp 桶快查；miss 时跨桶兜底——agent 会话 materialize
        // 后落在 conversation:/desktop: scope 桶，spaceIdProp（真实 space_id）
        // 桶里查不到，恒 null 会让 executionSpaceId 优先分支失效（bugbot ）
        if (spaceIdProp) {
          const inProp = state.sessionsBySpace[spaceIdProp]?.find(s => s.id === sessionId)
          if (inProp) return inProp
        }
        for (const sessions of Object.values(state.sessionsBySpace)) {
          const found = sessions.find(s => s.id === sessionId)
          if (found) return found
        }
        return null
      },
    )
    const hiddenTranscript = useAgentTerminalTranscriptStore(
      state => (sessionId ? state.transcriptsById[sessionId] ?? null : null),
    )
    const isSessionClosed = (sessionFromStore?.status ?? hiddenTranscript?.status) === 'closed'

    const effectiveStatus = useMemo(() => {
      const fromEnvelope = displayStatus ?? deriveDisplayStatusFromTerminalFields({
        backgrounded,
        exitCode,
        stderr,
      })
      // 2026-05-23 push 通知重构 commit C / PRD §8.1 修链 C：
      // envelope 说还在 running 但 session 已 closed（用户外部 kill 或进程崩溃）
      // → 覆盖为 terminated，避免 UI 卡在"假运行"
      if ((fromEnvelope === 'running' || fromEnvelope === 'backgrounded') && isSessionClosed) {
        return 'terminated'
      }
      return fromEnvelope
    }, [displayStatus, backgrounded, exitCode, stderr, isSessionClosed])

    const canStopAgentCommand =
      (effectiveStatus === 'running' || effectiveStatus === 'backgrounded')
      && !!sessionId
      && sessionId.startsWith('agent-')

    const canDetachAgentCommand =
      effectiveStatus === 'running'
      && !!sessionId
      && sessionId.startsWith('agent-')

    useEffect(() => {
      if (effectiveStatus !== 'running' && effectiveStatus !== 'backgrounded') {
        setStopPending(false)
      }
      if (effectiveStatus !== 'running') {
        setDetachPending(false)
      }
    }, [effectiveStatus])

    // 状态标签取值：后台运行态（'backgrounded'）归一为中性 'running'——「后台」
    // 类别由 header 徽标承载，状态标签只表达运行态，避免徽标 + 琥珀双重标记。
    const statusLabelValue = effectiveStatus === 'backgrounded' ? 'running' : effectiveStatus

    const [elapsedNow, setElapsedNow] = useState(() => Date.now())
    const shouldTickElapsed = effectiveStatus === 'running' && typeof startedAt === 'number'
    useEffect(() => {
      if (!shouldTickElapsed) return undefined
      setElapsedNow(Date.now())
      const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000)
      return () => window.clearInterval(timer)
    }, [shouldTickElapsed])
    const elapsedMs = shouldTickElapsed ? Math.max(0, elapsedNow - startedAt) : undefined

    // ── Layer 3 诚实降级视觉提示（终端假运行根治 v3 §5）──
    // 触发 = effectiveStatus === 'unknown'：Django celery **主判定**已把"超 hard_timeout
    // 仍 running 无终态"的快照标成 status:"unknown"，重载读到后渲染诚实提示。
    //
    // 设计取舍（三视角 review 后定稿）：**判定（超 hard_timeout）归 celery，显示归前端**
    // ——纯前端本地计时锚点（startedAt）来自 ephemeral 的 useChatRuntimeStore，冷重载
    // （正是"假运行"主场景）不会重建，恒 undefined → 本地计时形同摆设且易误杀长跑；故
    // 不在前端做朴素超时判定，统一由 celery（独立于前两层的 Django 侧机制）越过锚点后
    // 标 unknown，前端只负责把它诚实地显示出来。
    const showUnknownHint = effectiveStatus === 'unknown'

    const sessionSpaceId = resolveTerminalSessionSpaceId({
      sessionFromStore,
      hiddenTranscriptSpaceId: hiddenTranscript?.spaceId,
      spaceIdProp,
      sessionId,
    })
    const canJump = sessionSpaceId != null
    // 面板实际在读的标签桶：优先当前 UI scope（`conversation:<id>` / `desktop:...`），
    // 缺省退化到反解 spaceId。原实现恒用 raw spaceId 作桶 → tab 写进
    // `itemsBySpace[spaceId]`，而工作台按 `itemsBySpace[tabScopeKey]` 渲染 →
    // 桶不匹配、tab 不可见（点「查看终端」毫无反应）。
    const tabBucketKey = tabScopeKey ?? sessionSpaceId
    const openResourceTab = useSpaceContextTabsStore(state => state.openResourceTab)
    const addSpaceSession = useTerminalSessionStore(state => state.addSpaceSession)

    const handleJumpToTerminal = useCallback(() => {
      if (!sessionId || !sessionSpaceId || !tabBucketKey) return
      void (async () => {
        const didSelect = await ensureSpaceSelectedWithFeedback(sessionSpaceId, {
          failureToast: {
            title: t('card.terminal_open_failed', { defaultValue: '无法打开终端，所属工作空间不可用' }),
            variant: 'destructive',
          },
        })
        if (!didSelect) {
          return
        }
        const title = sessionFromStore?.title
          || hiddenTranscript?.title
          || command
          || t('card.agent_terminal', { defaultValue: 'Agent terminal' })
        const sessionCwd = sessionFromStore?.cwd || hiddenTranscript?.cwd || cwd || undefined
        await persistAgentTranscriptSnapshotIfNeeded({
          sessionId,
          command,
          stdout,
          stderr,
          cwd: sessionCwd || '',
        })
        if (!sessionFromStore) {
          // 桶 key 用 tabBucketKey；sessionSpaceId 作为 executionSpaceId 记录，
          // 让会话即便挂在 conversation scope 桶下也知道自己的执行 Space。
          addSpaceSession(tabBucketKey, sessionId, title, 'agent', sessionCwd, sessionSpaceId)
        }
        openResourceTab(tabBucketKey, {
          type: 'terminal',
          id: sessionId,
          title,
          meta: {
            source: sessionFromStore?.source ?? hiddenTranscript?.source ?? 'agent',
            status: sessionFromStore?.status ?? hiddenTranscript?.status ?? 'active',
            cwd: sessionCwd,
            createdAt: sessionFromStore?.createdAt ?? hiddenTranscript?.createdAt,
          },
        })
      })()
    }, [
      addSpaceSession,
      command,
      cwd,
      hiddenTranscript,
      openResourceTab,
      sessionFromStore,
      sessionId,
      sessionSpaceId,
      tabBucketKey,
      t,
    ])

    const handleCopy = useCallback(() => {
      safeCopyToClipboard(fullText, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [fullText])

    const handleStop = useCallback(() => {
      if (!sessionId || stopPending) return
      void (async () => {
        setStopPending(true)
        let killed = false
        try {
          const result = await window.tabtin?.pty?.agentKill?.(sessionId)
          killed = result?.success === true
          if (!killed) {
            toast({
              title: t('card.terminal_stop_failed', { defaultValue: '停止失败' }),
              variant: 'destructive',
            })
          }
        } catch {
          toast({
            title: t('card.terminal_stop_failed', { defaultValue: '停止失败' }),
            variant: 'destructive',
          })
        }
        if (!killed) {
          setStopPending(false)
          return
        }
        // IPC 成功只代表 SIGTERM 已发出，进程可能忽略信号继续跑（bugbot ）。
        // 给状态收敛留一个窗口后恢复按钮——若命令真结束，effectiveStatus 会离开
        // running 使按钮消失；若仍在跑，用户可以再次点停止。
        window.setTimeout(() => setStopPending(false), 5000)
      })()
    }, [sessionId, stopPending, t])

    const handleDetach = useCallback(() => {
      if (!sessionId || detachPending) return
      void (async () => {
        setDetachPending(true)
        let detached = false
        try {
          const result = await window.tabtin?.pty?.agentDetach?.(sessionId)
          detached = result?.success === true
          if (!detached) {
            toast({
              title: t('card.terminal_detach_failed', { defaultValue: '转入后台失败' }),
              variant: 'destructive',
            })
          }
        } catch {
          toast({
            title: t('card.terminal_detach_failed', { defaultValue: '转入后台失败' }),
            variant: 'destructive',
          })
        }
        if (!detached) {
          setDetachPending(false)
          return
        }
        // detach 请求由 runtime 下一轮 poll（100ms 级）消费后 envelope 才更新
        // 卡片为 backgrounded；同样给收敛窗口后恢复，防止 envelope 未及时到达
        // 时按钮永久 pending（对齐 handleStop 的处理）。
        window.setTimeout(() => setDetachPending(false), 5000)
      })()
    }, [sessionId, detachPending, t])

    // unknown / 已关闭态：header 跳转按钮的 tooltip 收敛成"查看（已结束）"语义，
    // 不再用现在时"打开终端"误导（卡片状态明明是"运行状态未知/已结束"）。
    const isEndedLike = isSessionClosed || effectiveStatus === 'unknown'

    // body-only：折叠行 + 下沉外框由外层 ToolStepCard 统一提供（终端式壳）。
    // 本组件只渲染「终端窗口」内容——标题栏（终端标识 + 状态 + 复制 / 外开）+
    // 屏幕（命令输入行 + 输出回显）+ cwd footer。
    return (
      <div data-testid="terminal-card">
        {/* Layer 3 诚实降级：unknown 提示（运行状态未知）放屏幕之上 */}
        {showUnknownHint && (
          <div
            className={cn(
              'flex items-center gap-2 flex-wrap',
              CARD_HEADER_PADDING.x,
              'py-1',
              TEXT.meta,
              TEXT_COLOR.muted,
            )}
          >
            <span>
              {t('card.terminal_state_unknown_hint', {
                defaultValue: '运行状态未知（可能已结束，结果未同步）',
              })}
            </span>
            {sessionId && canJump && (
              <button
                type="button"
                onClick={handleJumpToTerminal}
                className={cn('underline underline-offset-2 hover:text-foreground transition-colors')}
              >
                {t('card.view_output', { defaultValue: '查看输出' })}
              </button>
            )}
          </div>
        )}

        {/* 标题栏：终端标识 + 状态 + 复制 / 外开。带浅底 + 下分隔线，
            与下方「屏幕」区拉开层次（终端窗口标题栏审美）。 */}
        <div
          className={cn(
            'flex items-center gap-2 border-b',
            BORDER.subtle,
            BG.header,
            CARD_HEADER_PADDING.x,
            'py-1',
          )}
        >
          <Terminal className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0')} />
          <span className={cn(TEXT.meta, TEXT_COLOR.muted, 'flex-1 truncate')}>
            {t('card.terminal_label')}
          </span>

          {/* 状态标签只表达「运行态」：后台任务的 backgrounded 显示态归一到中性
              「运行中」（「后台」类别标识由 ToolStepCard 折叠行的徽标承载，折叠/
              展开都常驻可见），避免琥珀「后台运行中」与折叠行徽标双重标记。
              前置状态圆点让扫视时不用读文字即可判断成败/运行态。 */}
          <span className="flex items-center gap-1.5 shrink-0">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                getTerminalStatusDotClass(statusLabelValue, exitCode),
              )}
              aria-hidden
            />
            <span
              className={cn(
                TEXT.meta,
                'font-mono',
                getTerminalStatusColor(statusLabelValue, exitCode),
              )}
            >
              {getTerminalStatusLabel(t, statusLabelValue, exitCode)}
            </span>
          </span>

          {hasOutput && (
            <ChatIconTooltip content={t('card.copy_output')}>
              <button
                type="button"
                onClick={handleCopy}
                className={cn(
                  'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                  TEXT_COLOR.muted,
                )}
                aria-label={t('card.copy_output')}
              >
                {copied ? (
                  <Check className={cn(ICON_SIZE.sm, 'text-success')} />
                ) : (
                  <Copy className={ICON_SIZE.sm} />
                )}
              </button>
            </ChatIconTooltip>
          )}

          {canStopAgentCommand && (
            <ChatIconTooltip content={t('card.terminal_stop', { defaultValue: '停止命令' })}>
              <button
                type="button"
                onClick={handleStop}
                disabled={stopPending}
                className={cn(
                  'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                  TEXT_COLOR.muted,
                  stopPending && 'opacity-60 cursor-not-allowed hover:bg-transparent',
                )}
                aria-label={t('card.terminal_stop', { defaultValue: '停止命令' })}
              >
                {stopPending ? (
                  <Loader2 className={cn(ICON_SIZE.sm, 'animate-spin')} />
                ) : (
                  <Square className={ICON_SIZE.sm} />
                )}
              </button>
            </ChatIconTooltip>
          )}

          {canDetachAgentCommand && (
            <ChatIconTooltip content={t('card.terminal_detach', { defaultValue: '转入后台' })}>
              <button
                type="button"
                onClick={handleDetach}
                disabled={detachPending}
                className={cn(
                  'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                  TEXT_COLOR.muted,
                  detachPending && 'opacity-60 cursor-not-allowed hover:bg-transparent',
                )}
                aria-label={t('card.terminal_detach', { defaultValue: '转入后台' })}
              >
                {detachPending ? (
                  <Loader2 className={cn(ICON_SIZE.sm, 'animate-spin')} />
                ) : (
                  <ArrowDownToLine className={ICON_SIZE.sm} />
                )}
              </button>
            </ChatIconTooltip>
          )}

          {sessionId && (
            <ChatIconTooltip
              content={!canJump
                ? t('card.terminal_space_missing', { defaultValue: 'This terminal session is not linked to an available Space' })
                : isEndedLike
                  ? t('card.view_terminal_history', { defaultValue: 'View terminal (ended)' })
                  : t('card.open_terminal', { defaultValue: 'Open terminal' })}
            >
              <button
                type="button"
                onClick={canJump ? handleJumpToTerminal : undefined}
                disabled={!canJump}
                className={cn(
                  'shrink-0 p-0.5 rounded hover:bg-muted/30 transition-colors',
                  TEXT_COLOR.muted,
                  isEndedLike && 'opacity-60',
                  !canJump && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                )}
                aria-label={!canJump
                  ? t('card.terminal_space_missing', { defaultValue: 'This terminal session is not linked to an available Space' })
                  : isEndedLike
                    ? t('card.view_terminal_history', { defaultValue: 'View terminal (ended)' })
                    : t('card.open_terminal', { defaultValue: 'Open terminal' })}
              >
                <ExternalLink className={ICON_SIZE.sm} />
              </button>
            </ChatIconTooltip>
          )}
        </div>

        {/* 屏幕：命令输入行 + 输出回显 */}
        <ScrollArea
          data-testid="terminal-output-scroll"
          className={cn(CARD_MAX_HEIGHT.md)}
          style={{ maxHeight: TERMINAL_OUTPUT_MAX_HEIGHT_PX }}
          scrollBar="both"
        >
          <div className={cn('px-2.5 py-2', TEXT.code)}>
            {command && (
              <div className="flex gap-2">
                <span className={cn('shrink-0 select-none', TEXT_COLOR.accent)}>$</span>
                <span className="min-w-0 whitespace-pre-wrap break-all">
                  {cwd && (
                    <>
                      <span className={cn('font-mono', TEXT_COLOR.faint)} title={cwd}>
                        {shortenCwdForDisplay(cwd)}
                      </span>
                      <span className={cn('mx-1.5 select-none', TEXT_COLOR.accent)}>{'>'}</span>
                    </>
                  )}
                  <span className={cn('font-medium', TEXT_COLOR.primary)}>{command}</span>
                </span>
              </div>
            )}

            {hasOutput ? (
              <div
                className={cn(
                  command && 'mt-1.5',
                  'whitespace-pre-wrap break-all',
                  TEXT_COLOR.secondary,
                )}
              >
                {displayStdout}
                {isTruncated && (
                  <span className={cn(TEXT_COLOR.faint, 'block mt-1')}>
                    {'... '}({t('card.chars_count', { count: fullText.length })})
                  </span>
                )}
                {displayStderr && (
                  <span className="text-destructive/80">
                    {displayStdout ? '\n' : ''}
                    {displayStderr}
                  </span>
                )}
              </div>
            ) : (
              <div className={cn(command && 'mt-1.5', TEXT.meta, TEXT_COLOR.muted, 'italic')}>
                {effectiveStatus === 'running' && elapsedMs != null
                  ? t('card.running_no_output', {
                    seconds: Math.max(1, Math.floor(elapsedMs / 1000)),
                    defaultValue: `运行中 ${formatElapsedSeconds(elapsedMs)}，暂无输出`,
                  })
                  : t('card.no_output')}
              </div>
            )}

            {backgrounded && sessionId && canJump && (
              <button
                type="button"
                onClick={handleJumpToTerminal}
                className={cn(
                  'flex items-center gap-1 mt-2',
                  'text-caption text-muted-foreground/60 hover:text-foreground transition-colors',
                )}
              >
                <ExternalLink className={ICON_SIZE.sm} />
                {t('card.view_live_output')}
              </button>
            )}
          </div>
        </ScrollArea>
      </div>
    )
  },
)

TerminalCard.displayName = 'TerminalCard'

function deriveDisplayStatusFromTerminalFields(params: {
  backgrounded?: boolean
  exitCode: number | null
  stderr: string
}): TerminalDisplayStatus {
  if (params.backgrounded) return 'backgrounded'
  // 退出码非零 ≠ 失败（见 deriveStatusFromStructuredFields）：displayStatus prop 缺失时的
  // 内部兜底，有退出码即进程正常跑完 → 完成；被信号杀 / 超时等仍由 stderr 文案兜底识别。
  if (typeof params.exitCode === 'number') return 'success'
  return inferTerminatedStatusFromText(params.stderr) ?? 'running'
}

/**
 * **LEGACY 兜底**（终端假运行根治 v3 / PRD §1.3 老硬伤治本）：
 *
 * 早期实现里前端**不读结构化 status**，靠后端往 stderr 塞英文关键词
 * （terminated/killed/timed out）做子串匹配反推显示状态——这是脆弱的反向耦合：
 * 任何人把文案本地化成中文、或去掉英文关键词，卡片就会静默回落到"失败"
 * （红色误导）甚至"运行中"转圈。
 *
 * 现在终态判定**优先**走 {@link deriveStatusFromStructuredFields} 读结构化字段
 * （killed_reason / status / exited_by / exit_code）。本函数仅在结构化字段
 * **完全缺失**时作为兜底——服务历史数据 / 老版本投递的终态（无新字段），
 * 保持向后兼容。新代码路径不应再依赖它。
 */
function inferTerminatedStatusFromText(text: string): TerminalDisplayStatus | undefined {
  const lower = text.toLowerCase()
  if (!lower) return undefined
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout'
  if (lower.includes('terminated') || lower.includes('killed') || lower.includes('aborted')) {
    return 'terminated'
  }
  return undefined
}

/** killed_reason 枚举 → 显示状态（终态结构化字段判定，不依赖 stderr 文案）。 */
function mapKilledReasonToStatus(killedReason: string): TerminalDisplayStatus {
  switch (killedReason) {
    case 'hard_timeout':
      return 'timeout'
    case 'app_exit':
      return 'app_exit'
    case 'kill_tool':
    case 'user_interrupt':
      return 'terminated'
    default:
      // 未知 killed_reason（未来新增枚举）也判"已终止"——命令确实被主动杀死，
      // 比静默回落"失败/运行中"诚实。
      return 'terminated'
  }
}

/**
 * 终态显示状态判定 **P1（终端假运行根治 v3 / PRD §1.3 治本）**：优先读
 * tool_result 携带的**结构化终态字段**，**不依赖 stderr 英文文案**。
 *
 * 返回 `undefined` = 无结构化终态信号 → 调用方回落 {@link inferTerminatedStatusFromText}
 * legacy 字符串推断（历史数据 / 老版本投递的终态）。
 *
 * 字段以执行域实际产出为准（`background-task-terminal-result.ts` / `shell.ts`）；
 * 与执行 A 契约描述如有出入以代码为准：
 *   - `killed_reason`: hard_timeout | kill_tool | user_interrupt | app_exit
 *       —— host 主动杀死后台命令的原因，**出现即代表"被终止"**（最强信号，
 *       本次根治的核心）。后端执行 A 已改用 `deriveBackgroundTaskStatus`，被杀时
 *       status 现为 completed|killed|failed（不再恒 completed）；本卡仍以
 *       killed_reason 为主信号、对两态兼容，不看 status 字面值。
 *   - `error_kind`/`abort_reason`: 前台等待超时 / abort（既有结构化信号）。
 *       前台 abort 会同时带 `status:'failed'` + `error_kind:'request_timeout'`，
 *       所以超时判定必须排在 `status==='failed'` 之前，避免"已超时"被误判成"失败"。
 *   - `exited_by`: normal_exit | exec_failure | signal —— 进程结束方式。
 *       signal（无 killed_reason，如外部 kill / OOM）→ 已终止；exec_failure → 失败。
 *   - `status`: completed | running | failed（前台）/ 后台现为 completed|killed|failed
 *       （执行 A deriveBackgroundTaskStatus 输出，不再恒 completed）。killed 一并
 *       识别（已落地 + 向前兼容）。
 *   - `exit_code`: number | null
 */
function deriveStatusFromStructuredFields(
  payload: Record<string, unknown>,
): TerminalDisplayStatus | undefined {
  const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')
  const killedReason = asStr(payload.killed_reason)
  const errorKind = asStr(payload.error_kind)
  const abortReason = asStr(payload.abort_reason)
  const exitedBy = asStr(payload.exited_by)
  const status = asStr(payload.status)

  // 1) killed_reason：后台命令被 host 主动杀死（本次根治的核心信号）。
  if (killedReason) return mapKilledReasonToStatus(killedReason)

  // 2) 前台等待超时 / abort（既有结构化信号，非 stderr 文案）。
  //    必须早于 status==='failed'：abort 路径同时带这两者。
  if (errorKind === 'request_timeout' || abortReason === 'timeout') return 'timeout'

  // 3) exited_by：被信号杀死但无 killed_reason（外部 kill / OOM）→ 已终止；
  //    命令无法执行（spawn/exec 失败）→ 真失败。均为结构化判定，不看 stderr 文案。
  if (exitedBy === 'signal') return 'terminated'
  if (exitedBy === 'exec_failure') return 'failed'

  // 4) status 枚举（执行 A deriveBackgroundTaskStatus 已落地 killed/failed 终态）。
  if (status === 'killed') return 'terminated'
  if (status === 'failed') return 'failed'
  // Layer 3 诚实降级（终端假运行根治 v3 §5）：Django celery 把超 hard_timeout 仍 running
  // 无终态的快照标成 status:"unknown"——诚实"运行状态未知"，既非成功/失败也非转圈。
  if (status === 'unknown') return 'unknown'
  // 退出码非零 ≠ 失败（核心修复）：进程是否「非正常结束」已由上面的 exited_by
  // （exec_failure=126/127 起不来、signal=被杀）+ killed_reason + status(failed/killed)
  // 全部拦截。能走到 completed 这里就是正常跑完——退出码只是命令自己的返回值
  // （du 遇无权限目录返 1、grep 无匹配返 1、build 失败返 1 都属正常结束）。展示层不再
  // 凭退出码二次裁决「失败」，把结果好坏交给用户 / Agent 看输出判断（对齐执行层
  // shell.ts:1704 的 exited_by 语义）。
  if (status === 'completed') return 'success'
  return undefined
}

function deriveDisplayStatusFromPayload(params: {
  phase?: CardRendererProps['phase']
  payload: Record<string, unknown>
  exitCode: number | null
  backgrounded: boolean
  stderr: string
}): TerminalDisplayStatus {
  if (params.backgrounded) return 'backgrounded'
  if (params.phase === 'start' || params.phase === 'running') return 'running'

  // ── P1：优先读结构化终态字段（不依赖 stderr 文案，根治 PRD §1.3 老硬伤）──
  const structured = deriveStatusFromStructuredFields(params.payload)
  if (structured) return structured

  // ── legacy 兜底：结构化字段缺失（历史数据 / 老版本投递）才走 stderr 文案推断 ──
  if (params.payload.success === false) {
    return inferTerminatedStatusFromText(params.stderr) ?? 'failed'
  }
  // legacy 兜底（无结构化字段）同样不凭退出码判失败：真失败已由上面 success===false
  // 捕获；走到这里有退出码即说明进程正常跑完 → 完成（不论退出码 0 / 非零）。
  if (typeof params.exitCode === 'number') return 'success'
  if (params.phase === 'error') return inferTerminatedStatusFromText(params.stderr) ?? 'failed'
  return inferTerminatedStatusFromText(params.stderr) ?? 'running'
}

/**
 * 状态圆点配色：与 {@link getTerminalStatusColor} 同一套判定口径。
 * running 用中性色 + pulse 动画表达「进行中」；app_exit / unknown 中性灰
 * （非命令自身出错，避免红色误导——同 PRD §1.3 反「红色误导」取向）。
 */
function getTerminalStatusDotClass(status: TerminalDisplayStatus, exitCode: number | null): string {
  if (status === 'running') return 'bg-muted-foreground/60 animate-pulse'
  if (status === 'app_exit' || status === 'unknown') return 'bg-muted-foreground/60'
  if (status === 'success' || exitCode === 0) return 'bg-success/80'
  return 'bg-destructive/80'
}

function getTerminalStatusColor(status: TerminalDisplayStatus, exitCode: number | null): string {
  // app_exit（应用退出导致的优雅停止）/ running / unknown（Layer 3 诚实降级"运行状态
  // 未知"）用中性灰——都不是命令本身出错，用 destructive 红色会误导用户以为命令失败
  // （PRD §1.3 反"红色误导"）。
  if (status === 'app_exit' || status === 'running' || status === 'unknown') return 'text-muted-foreground/60'
  if (status === 'success' || exitCode === 0) return 'text-success/80'
  return 'text-destructive/80'
}

function getTerminalStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: TerminalDisplayStatus,
  exitCode: number | null,
): string {
  if (status === 'success') {
    return t('card.completed', { defaultValue: '已完成' })
  }
  if (status === 'failed') {
    return getShellFailureLabel(t, exitCode)
  }
  switch (status) {
    case 'timeout':
      return t('card.timeout', { defaultValue: '已超时' })
    case 'terminated':
      return t('card.terminated', { defaultValue: '已终止' })
    case 'app_exit':
      // 退出客户端导致的后台命令终止（killed_reason='app_exit'）：与普通"已终止"
      // 区分文案，明确告诉用户"是因为你退出了应用，命令本身没出错"。
      return t('card.app_exit_stopped', { defaultValue: '应用退出已停止' })
    case 'unknown':
      // Layer 3 诚实降级（终端假运行根治 v3 §5）：前两层全失效、running 超 hard_timeout
      // 仍无终态——诚实标"运行状态未知"，不冒充成功/失败/运行中。
      return t('card.status_unknown', { defaultValue: '运行状态未知' })
    case 'backgrounded':
      return t('card.backgrounded', { defaultValue: 'backgrounded' })
    case 'running':
    default:
      return t('card.running', { defaultValue: 'running...' })
  }
}

function formatElapsedSeconds(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

/**
 * 「单行长 JSON」stdout pretty-print：tabtin CLI / curl 类命令常输出压缩成
 * 一行的 JSON，在卡片里是一堵不可读的字符墙。仅当 stdout 整体是**单行**且
 * 超过阈值的合法 JSON 对象/数组时格式化为 2 空格缩进；多行输出（含已格式化
 * JSON、普通文本）一律原样保留。仅影响屏幕显示——复制路径（fullText）保留
 * 原始字节。
 */
const JSON_PRETTIFY_MIN_CHARS = 120

function prettifySingleLineJsonStdout(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed.length < JSON_PRETTIFY_MIN_CHARS) return stdout
  if (trimmed.includes('\n')) return stdout
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return stdout
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return stdout
  }
}

/**
 * cwd 展示精简：完整绝对路径（`/Users/foo/workspace/Bar/apps/x`）对用户是噪音，
 * 命令行提示符习惯只显示末级目录（对齐 zsh `%1~` / oh-my-zsh 默认）。完整路径
 * 保留在 title tooltip 里悬停可查。只有一级的短路径（`/tmp`、`~`）原样显示。
 */
function shortenCwdForDisplay(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  if (!trimmed) return cwd
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return lastSegment || trimmed
}

/**
 * 剥离 stdout 开头与命令重复的 echo 行。
 *
 * 终端 buffer / PTY 快照常把执行的命令以 `$ 命令` 或裸 `命令` 形式回显进
 * stdout 首行。卡片已单独渲染命令输入行，保留 echo 会让命令显示两遍。
 * 仅在首行 trim 后与命令严格相等（或加 `$ ` 提示符前缀）时剥离，避免把
 * 恰好与命令同文本的真实输出误删。
 */
function stripEchoedCommandLine(stdout: string, command: string | undefined): string {
  const cmd = command?.trim()
  if (!cmd || !stdout) return stdout
  const newlineIdx = stdout.indexOf('\n')
  const firstLine = (newlineIdx === -1 ? stdout : stdout.slice(0, newlineIdx)).trim()
  if (firstLine === cmd || firstLine === `$ ${cmd}`) {
    return newlineIdx === -1 ? '' : stdout.slice(newlineIdx + 1)
  }
  return stdout
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  const inner = (obj.kwargs as Record<string, unknown> | undefined) ?? obj
  const raw = inner.command
  return typeof raw === 'string' && raw.trim() ? raw : undefined
}

function extractWaitMs(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  const inner = (obj.kwargs as Record<string, unknown> | undefined) ?? obj
  const raw = inner.wait_ms
  return typeof raw === 'number' ? raw : undefined
}

/**
 * ：判定一条 `run_terminal_command` 是否为后台任务。
 *
 * 持久信号 `wait_ms === 0`（detach 启动，与执行状态无关）保证后台任务跑完后
 * 仍可识别；运行期再叠加输出侧信号（旧 PTY `backgrounded` / 新 envelope
 * `status:"running"`）兜底首屏 output 已到但 input 缺 wait_ms 的历史数据。
 *
 * 导出供 `ToolStepCard` 折叠行复用——折叠态也要能一眼区分后台/前台。
 */
export function isBackgroundTerminalTask(input: unknown, output: unknown): boolean {
  if (extractWaitMs(input) === 0) return true
  const payload = parseRecordPayload(output)
  if (payload.backgrounded === true) return true
  if (payload.status === 'running') return true
  return false
}

function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function extractLegacyDescription(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  const inner = (obj.kwargs as Record<string, unknown> | undefined) ?? obj
  return normalizeDescription(inner.description)
}

function parseRecordPayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Wrapper conforming to CardRendererProps for the registry */
const TerminalCardRenderer: React.FC<CardRendererProps> = ({
  data,
  input,
  output,
  error,
  phase,
  intent,
  startedAt,
  tabScopeKey,
}) => {
  const { t } = useTranslation('chat')
  if (error) return <ErrorBanner error={error} />

  // ToolStepCard 对 TerminalCard 走 self-framed 路径，外壳 compactSummary 不会
  // 渲染——runtime intent 由本组件折叠行承载（与 ThinkingBlockView 同款）。
  const terminal = data as TerminalOutputData | undefined
  const description = normalizeDescription(intent) ?? extractLegacyDescription(input)

  if (terminal && terminal.kind === 'terminal') {
    const rawOutputPayload = parseRecordPayload(output)
    const displayStatus = deriveDisplayStatusFromPayload({
      phase,
      payload: rawOutputPayload,
      exitCode: terminal.exit_code,
      backgrounded: terminal.backgrounded === true,
      stderr: terminal.stderr,
    })
    return (
      <TerminalCard
        command={terminal.command || extractCommand(input)}
        stdout={terminal.stdout}
        stderr={terminal.stderr}
        exitCode={terminal.exit_code}
        cwd={terminal.cwd}
        backgrounded={terminal.backgrounded === true}
        displayStatus={displayStatus}
        startedAt={startedAt}
        sessionId={terminal.session_id}
        spaceId={terminal.space_id}
        tabScopeKey={tabScopeKey}
        description={description}
      />
    )
  }

  if (output == null && input == null) {
    if (phase === 'start' || phase === 'running') {
      return (
        <div
          data-testid="terminal-loading-skeleton"
          style={{ minHeight: terminalLoadingSkeletonMinHeightPx() }}
        >
          <LoadingPlaceholder />
        </div>
      )
    }
    return null
  }

  // phase=end/error 但 output 还没到达的极短窗口：不再闪「结果正在同步…」。
  // 有已知命令/描述时只保留命令头；否则直接空渲染，等 output 到位再出完整卡。
  if (phase !== 'start' && phase !== 'running' && output == null) {
    const pendingCommand = extractCommand(input)
    const pendingLabel = description ?? pendingCommand
    if (!pendingLabel) return null
    return (
      <div className="my-0.5" data-testid="terminal-card">
        <div
          className={cn(
            'flex items-center gap-1.5 pl-0 pr-2 py-0.5',
            TEXT.body,
            TEXT_COLOR.muted,
          )}
        >
          <Terminal className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'flex-shrink-0')} />
          <span className={cn(TEXT_COLOR.secondary, 'min-w-0 flex-1 truncate')}>
            {pendingLabel}
          </span>
        </div>
      </div>
    )
  }

  /**
   * @deprecated Legacy fallback for unstructured terminal data.
   * Handles snake_case/camelCase dual formats and missing `kind` discriminator.
   * Target removal: when all persisted chat history has been migrated to
   * TerminalOutputData (kind === 'terminal') format.
   */
  let rawPayload = output ?? input ?? {}
  if (typeof rawPayload === 'string') {
    try {
      rawPayload = JSON.parse(rawPayload)
    } catch {
      // Keep legacy fallback tolerant: unparsable text is plain stdout.
      rawPayload = { output: rawPayload }
    }
  }
  const raw = rawPayload as Record<string, unknown>
  const isBg = raw.backgrounded === true
  const rawCommand = typeof raw.command === 'string' && raw.command.trim()
    ? raw.command
    : extractCommand(input)
  // **2026-05-17 dogfood 事故堵漏**：runtime `buildToolErrorResult` 失败
  // 路径输出 `{ success:false, error_kind, error:'<原因>', stdout:'', stderr:'' }`
  // ——stderr 通常为空，"为什么挂的"写在顶层 `error`。原 legacy fallback 只读
  // `raw.stderr`，error 字段被丢，用户看到空白 body 完全不知道为什么挂。
  // 补 fallback：stderr 缺省时把顶层 `error` 字符串升上来当 stderr 渲染。
  // 与 `extractTerminal` 同款语义，保证结构化路径 + legacy 路径行为一致。
  const rawStderr = String(raw.stderr ?? '')
  const rawErrorMsg = typeof raw.error === 'string' ? raw.error : ''
  const effectiveStderr = rawStderr || rawErrorMsg
  const rawExitCode = raw.exit_code != null || raw.exitCode != null ? Number(raw.exitCode ?? raw.exit_code) : null
  const displayStatus = deriveDisplayStatusFromPayload({
    phase,
    payload: raw,
    exitCode: isBg ? null : rawExitCode,
    backgrounded: isBg,
    stderr: effectiveStderr,
  })
  return (
    <TerminalCard
      command={rawCommand}
      stdout={String(raw.stdout ?? raw.output ?? '')}
      stderr={effectiveStderr}
      exitCode={isBg ? null : rawExitCode}
      cwd={String(raw.cwd ?? '')}
      backgrounded={isBg}
      displayStatus={displayStatus}
      startedAt={startedAt}
      sessionId={(raw.session_id ?? raw.sessionId ?? raw.agent_session_id ?? raw.agentSessionId) as string | undefined}
      spaceId={(raw.space_id ?? raw.spaceId ?? raw._space_id) as string | undefined}
      tabScopeKey={tabScopeKey}
      description={description}
    />
  )
}

export { TerminalCard, TerminalCardRenderer }
export default TerminalCard

/* ─── Self-registration ───────────────────────────────────────────── */

import { registerCardRenderer } from '../registry/cardRenderers'
registerCardRenderer('TerminalCard', TerminalCardRenderer)
