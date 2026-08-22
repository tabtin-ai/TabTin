/**
 * AgentChatOverlay —— app-focus 下展开的悬浮对话面板。
 * 内嵌真实 ChatSidePanel：composer / 上下文注入 / HITL 全链路直接可用。
 * transform-origin 钉右下角（origin-aware：从胶囊位置长出）。
 *
 * 与缩略胶囊一样挂在主 renderer：网页标签须走 webview 容器，
 * 才能与文档等页同一套层叠；不再为 WCV 开 overlay / hide 整页支线。
 */
import React, { useRef } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Columns2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { ChatSidePanel } from '@components/chat/panel/ChatSidePanel'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { useScopedEventListener } from '@hooks/spaceActivity'

export interface AgentChatOverlayProps {
  spaceContext: SpaceContext
  organizationId?: string | null
  /** 指向收起胶囊锚点，保证展开 / 收起沿同一空间路径。 */
  transformOrigin?: string
  onCollapse: () => void
  onBackToSplit: () => void
}

const iconBtn =
  'inline-flex h-7 w-7 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-foreground/[0.05] hover:text-foreground no-drag'

export const AgentChatOverlay: React.FC<AgentChatOverlayProps> = ({
  spaceContext,
  organizationId,
  transformOrigin = '100% 100%',
  onCollapse,
  onBackToSplit,
}) => {
  const { t } = useTranslation('chat')
  const rootRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()

  useScopedEventListener<KeyboardEvent>(window, 'keydown', (event) => {
    if (event.key === 'Escape') onCollapse()
  })

  return (
    <motion.div
      ref={rootRef}
      data-agent-chat-overlay
      role="dialog"
      aria-label={t('capsule.expand')}
      style={{ transformOrigin }}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 10 }}
      animate={reducedMotion
        ? { opacity: 1, transition: { duration: 0.12 } }
        : { opacity: 1, scale: 1, y: 0, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
      exit={reducedMotion
        ? { opacity: 0, transition: { duration: 0.12 } }
        : { opacity: 0, scale: 0.95, y: 8, transition: { duration: 0.16, ease: 'easeOut' } }}
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden rounded-2xl',
        'border border-border/60 bg-background/95 shadow-2xl backdrop-blur-2xl no-drag',
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-end gap-0.5 border-b border-border/60 px-2">
        <button type="button" className={iconBtn} title={t('capsule.backToSplit')} onClick={onBackToSplit}>
          <Columns2 className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" className={iconBtn} title={t('capsule.collapse')} onClick={onCollapse}>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ChatSidePanel spaceContext={spaceContext} organizationId={organizationId} />
      </div>
    </motion.div>
  )
}
