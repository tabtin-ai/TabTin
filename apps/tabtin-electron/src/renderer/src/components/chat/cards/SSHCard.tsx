/**
 * SSHCard — SSH remote command output card for agent chat.
 *
 * Similar to TerminalCard but with server badge to distinguish
 * remote output from local terminal output.
 * Self-registers as 'SSHCard' in the card renderer registry.
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, Copy, Check } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_HEADER_PADDING,
  TEXT,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
  TAG,
} from '../registry/chatDesignTokens'

import { safeCopyToClipboard } from '../utils/clipboard'
import { getShellFailureLabel } from '@utils/chat/shellFailureReason'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import { truncateTerminalOutput } from './utils/truncateOutput'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

interface SSHCardProps {
  serverName?: string
  host?: string
  command?: string
  stdout: string
  stderr: string
  exitCode: number | null
  /** 执行层结构化终态（与 shell.ts 同源）：exec_failure/signal 才是真失败，退出码非零本身不算。 */
  exitedBy?: string
  status?: string
  success?: boolean
  durationMs?: number
}

const SSHCard: React.FC<SSHCardProps> = React.memo(
  ({ serverName, host, command, stdout, stderr, exitCode, exitedBy, status, success }) => {
    const { t } = useTranslation('chat')
    const [copied, setCopied] = useState(false)

    const fullText = [stdout, stderr].filter(Boolean).join('\n')
    const { displayStdout, displayStderr, isTruncated } = truncateTerminalOutput(stdout, stderr)

    const hasOutput = !!(stdout || stderr)
    const serverLabel = serverName || host || 'SSH'
    // 退出码非零 ≠ 失败（与 TerminalCard / helpers 同口径）：以执行层 exited_by/status 为准。
    // 真失败 = status:failed / exec_failure（126/127 起不来）/ signal（被杀）/ success:false；
    // 否则有退出码即正常完成（远程 du / grep 返非零也属正常结束）。
    const isFailure =
      status === 'failed' || exitedBy === 'exec_failure' || exitedBy === 'signal' || success === false
    const isRunning = exitCode == null && !isFailure
    const statusLabel = isRunning
      ? t('card.running', { defaultValue: 'running...' })
      : isFailure
        ? getShellFailureLabel(t, exitCode)
        : t('card.completed', { defaultValue: '已完成' })

    const handleCopy = useCallback(() => {
      safeCopyToClipboard(fullText, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [fullText])

    // body-only：折叠行 + 下沉外框由外层 ToolStepCard 统一提供（与 TerminalCard 同款终端式壳）。
    // 本组件只渲染「终端窗口」内容——标题栏（服务器标识 + 状态 + 复制）+
    // 屏幕（命令输入行 + 输出回显）。host 作为命令前缀（$ host > command），耗时由外层显示。
    return (
      <div data-testid="ssh-card">
        {/* 标题栏：服务器标识 + 状态 + 复制 */}
        <div
          className={cn('flex items-center gap-2', CARD_HEADER_PADDING.x, CARD_HEADER_PADDING.y)}
        >
          <Server className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0')} />
          <span
            className={cn(
              TEXT.meta,
              'shrink-0 rounded px-1.5 py-0.5',
              TAG.bg, TAG.text,
            )}
          >
            {serverLabel}
          </span>
          <span className="flex-1" />

          <span
            className={cn(
              TEXT.meta,
              'font-mono shrink-0',
              isRunning ? 'text-muted-foreground/60' : isFailure ? 'text-destructive/80' : 'text-success/80',
            )}
          >
            {statusLabel}
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
        </div>

        {/* 屏幕：命令输入行 + 输出回显 */}
        <ScrollArea className={cn(CARD_MAX_HEIGHT.md)} scrollBar="both">
          <div className={cn('px-2.5 py-2', TEXT.code)}>
            {command && (
              <div className="flex gap-2">
                <span className={cn('shrink-0 select-none', TEXT_COLOR.accent)}>$</span>
                <span className="min-w-0 whitespace-pre-wrap break-all">
                  {host && (
                    <>
                      <span className={cn('font-mono', TEXT_COLOR.faint)}>{host}</span>
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
                {t('card.no_output')}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    )
  },
)

SSHCard.displayName = 'SSHCard'

const SSHCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, durationMs, error, phase }) => {
  if (error) return <ErrorBanner error={error} />
  if (!data && !output && !input) {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }
  const raw = (data ?? output ?? input ?? {}) as Record<string, unknown>
  return (
    <SSHCard
      serverName={String(raw.server_name ?? raw.serverName ?? '')}
      host={String(raw.host ?? '')}
      command={(input as Record<string, unknown>)?.command as string | undefined}
      stdout={String(raw.stdout ?? '')}
      stderr={String(raw.stderr ?? '')}
      exitCode={raw.exit_code != null || raw.exitCode != null ? Number(raw.exit_code ?? raw.exitCode) : null}
      exitedBy={typeof raw.exited_by === 'string' ? raw.exited_by : undefined}
      status={typeof raw.status === 'string' ? raw.status : undefined}
      success={raw.success === false ? false : undefined}
      durationMs={(raw.duration_ms ?? raw.durationMs ?? durationMs) as number | undefined}
    />
  )
}

export { SSHCard, SSHCardRenderer }
export default SSHCard

/* ─── Self-registration ───────────────────────────────────────────── */

import { registerCardRenderer } from '../registry/cardRenderers'
registerCardRenderer('SSHCard', SSHCardRenderer)
