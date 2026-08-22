/**
 * Host 镜像待发区抽屉
 *
 * 直接订 store 数组引用（写入侧只 enqueue queuePosition>=1）。
 * 禁止在 selector 里 .filter() 造新数组——React 19 getSnapshot 会 Maximum update depth。
 *
 * 行内三按钮对齐旧 MessageQueueItemRow：编辑 / 立即发送（插队）/ 移除。
 */

import React, { useEffect, useState } from 'react'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Pencil, Play, X } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chat/useChatStore'
import type { HostPendingSendItem } from '@/stores/chat/messages/hostPending/hostPendingSendSlice'
import { COMPOSER_TEXT_META_BASE, COMPOSER_TEXT_MICRO } from '../registry/chatDesignTokens'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

const EMPTY_HOST_PENDING_QUEUE: HostPendingSendItem[] = []

interface HostPendingSendDrawerProps {
  sessionId: string | null | undefined
}

export function HostPendingSendDrawer({ sessionId }: HostPendingSendDrawerProps) {
  const { t } = useTranslation('chat')
  const queue = useChatStore((s) => (
    sessionId
      ? (s.hostPendingSendsBySessionId[sessionId] ?? EMPTY_HOST_PENDING_QUEUE)
      : EMPTY_HOST_PENDING_QUEUE
  ))
  const interruptAndPromoteHostPending = useChatStore((s) => s.interruptAndPromoteHostPending)
  const cancelHostPendingSend = useChatStore((s) => s.cancelHostPendingSend)
  const editHostPendingSend = useChatStore((s) => s.editHostPendingSend)
  const [collapsed, setCollapsed] = useState(false)
  const visibleQueue = queue.filter((item) => item.phase !== 'starting')

  useEffect(() => {
    if (visibleQueue.length > 0 && collapsed) {
      setCollapsed(false)
    }
  }, [visibleQueue.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (visibleQueue.length === 0) return null

  return (
    <div className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className={cn(
          'flex w-full min-w-0 items-center justify-between gap-2 px-3 py-1.5',
          COMPOSER_TEXT_META_BASE,
          'text-muted-foreground hover:bg-muted/30 transition-colors',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning/80 animate-pulse" />
          <span className="min-w-0 truncate">
            {t('queue.count', { count: visibleQueue.length, defaultValue: '{{count}} 条消息排队中' })}
          </span>
        </span>
        {collapsed
          ? <ChevronUp className="h-3.5 w-3.5 shrink-0" />
          : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <ScrollArea className="max-h-[160px] border-t border-border/30">
              {visibleQueue.map((item, index) => {
                const preview = item.userMessage.content?.trim()
                  || item.titleText.trim()
                  || t('queue.pendingUntitled', { defaultValue: '（无正文）' })
                const isLast = index === visibleQueue.length - 1
                return (
                  <div
                    key={item.runId}
                    className={cn(
                      'group/qi flex items-center gap-2 px-3 py-2',
                      'hover:bg-muted/30 transition-colors',
                      !isLast && 'border-b border-border/20',
                    )}
                  >
                    <span
                      className={cn(
                        'flex-shrink-0 tabular-nums w-4 text-right',
                        COMPOSER_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="flex-1 min-w-0 text-body text-foreground/80 truncate">
                      {preview}
                    </span>
                    {sessionId ? (
                      <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover/qi:opacity-100 transition-opacity">
                        <ChatIconTooltip content={t('queue.edit', { defaultValue: '撤回重新编辑' })}>
                          <button
                            type="button"
                            onClick={() => {
                              void editHostPendingSend(sessionId, item.runId)
                            }}
                            className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                            aria-label={t('queue.edit', { defaultValue: '撤回重新编辑' })}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        </ChatIconTooltip>
                        <ChatIconTooltip content={t('queue.sendNow', { defaultValue: '立即发送（插队）' })}>
                          <button
                            type="button"
                            onClick={() => {
                              void interruptAndPromoteHostPending(sessionId, item.runId)
                            }}
                            className="flex items-center justify-center h-6 w-6 rounded-md text-accent hover:bg-accent/10 transition-colors"
                            aria-label={t('queue.sendNow', { defaultValue: '立即发送（插队）' })}
                          >
                            <Play className="h-3 w-3" />
                          </button>
                        </ChatIconTooltip>
                        <ChatIconTooltip content={t('queue.remove', { defaultValue: '移除' })}>
                          <button
                            type="button"
                            onClick={() => {
                              void cancelHostPendingSend(sessionId, item.runId)
                            }}
                            className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                            aria-label={t('queue.remove', { defaultValue: '移除' })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </ChatIconTooltip>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
