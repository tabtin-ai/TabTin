/**
 * 外部历史注入横幅——替代塞进系统气泡的长文前缀。
 */

import React from 'react'
import { cn } from '@utils/cn'
import type { ChatMessage } from '@tabtin/chat-client'
import companionUrl from '@/assets/brand/tabtin-input-companion.png?url'
import { IMPORT_SOURCE_LABELS } from '@components/onboarding/external-import/useExternalImportDetection'
import { TEXT } from '../../../registry/chatDesignTokens'

export interface ExternalArchivePrefixInfo {
  source: string
  sourceLabel: string
  title: string | null
  cwd: string | null
}

export function resolveImportSourceLabel(source: string | null | undefined): string {
  if (!source) return '外部工具'
  return IMPORT_SOURCE_LABELS[source] ?? source
}

// eslint-disable-next-line complexity -- 外部历史前缀同时兼容新 metadata 与旧文本前缀两种导入形态。
export function parseExternalArchivePrefix(
  message: Pick<ChatMessage, 'content' | 'metadata'>,
): ExternalArchivePrefixInfo | null {
  const meta = message.metadata as Record<string, unknown> | null | undefined
  if (meta?.system_fact === 'external_archive_prefix') {
    const source = typeof meta.source === 'string' ? meta.source : ''
    const title =
      typeof meta.title === 'string' && meta.title.trim()
        ? meta.title.trim()
        : null
    const cwd =
      typeof meta.cwd === 'string' && meta.cwd.trim()
        ? meta.cwd.trim()
        : null
    if (source || title) {
      return {
        source,
        sourceLabel: resolveImportSourceLabel(source),
        title,
        cwd,
      }
    }
  }

  const content = (message.content || '').trim()
  if (!content.startsWith('【外部历史')) return null

  const sourceMatch = content.match(/来源：([^\n]+)/)
  const titleMatch = content.match(/原会话：([^\n]+)/)
  const cwdMatch = content.match(/原工作目录：([^\n]+)/)
  const sourceLabel = sourceMatch?.[1]?.trim() || '外部工具'
  const source =
    Object.entries(IMPORT_SOURCE_LABELS).find(([, label]) => label === sourceLabel)?.[0]
    ?? sourceLabel.toLowerCase()

  return {
    source,
    sourceLabel,
    title: titleMatch?.[1]?.trim() || null,
    cwd: cwdMatch?.[1]?.trim() || null,
  }
}

export function isExternalArchivePrefixMessage(
  message: Pick<ChatMessage, 'content' | 'metadata' | 'role'>,
): boolean {
  if (message.role !== 'system') return false
  return parseExternalArchivePrefix(message) != null
}

export const ExternalArchivePrefixBubble: React.FC<{
  info: ExternalArchivePrefixInfo
}> = ({ info }) => {
  const subtitle = info.title || info.cwd
  const tooltip = [
    info.sourceLabel,
    info.title ? `原会话：${info.title}` : null,
    info.cwd ? `原目录：${info.cwd}` : null,
  ].filter(Boolean).join('\n')

  return (
    <div
      className="flex justify-center px-1 pb-2.5 pt-11"
      data-testid="external-archive-prefix-banner"
    >
      <div
        className={cn(
          'relative w-full max-w-xl rounded-md border border-border/40 bg-muted/25 px-3 py-2.5 pl-4',
          'shadow-[inset_0_1px_0_0_hsl(var(--foreground)/0.03)]',
        )}
        title={tooltip}
      >
        <div
          aria-hidden="true"
        className="pointer-events-none absolute -top-10 left-2 z-sticky select-none"
        >
          <img
            src={companionUrl}
            alt=""
            draggable={false}
            className="h-14 w-auto object-contain drop-shadow-[0_3px_8px_rgba(0,0,0,0.12)]"
            data-testid="external-archive-prefix-mascot"
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(TEXT.meta, 'shrink-0 font-medium text-foreground/80')}>
            新任务
          </span>
          <span className="shrink-0 text-muted-foreground/35" aria-hidden>
            ·
          </span>
          <span className={cn(TEXT.meta, 'shrink-0 text-muted-foreground/75')}>
            来自 {info.sourceLabel}
          </span>
          {subtitle ? (
            <>
              <span className="shrink-0 text-muted-foreground/35" aria-hidden>
                ·
              </span>
              <span className={cn(TEXT.meta, 'min-w-0 truncate text-muted-foreground/60')}>
                {subtitle}
              </span>
            </>
          ) : null}
        </div>
        <p className={cn(TEXT.meta, 'mt-1 text-muted-foreground/60')}>
          上面是外来历史，当作上下文即可——从这里开始，都可以交给小 Tin 继续做
        </p>
      </div>
    </div>
  )
}
