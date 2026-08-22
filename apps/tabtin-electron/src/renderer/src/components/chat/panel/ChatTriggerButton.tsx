/**
 * ChatTriggerButton - Chat 触发按钮（右下角悬浮）
 */

import React from 'react'
import { MessageSquare } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@tabtin/smartsheet-ui'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useTranslation } from 'react-i18next'

export const ChatTriggerButton: React.FC = () => {
  const { t } = useTranslation('chat')
  const isPanelOpen = useChatStore(s => s.isPanelOpen)
  const togglePanel = useChatStore(s => s.togglePanel)

  // 面板打开时不显示按钮
  if (isPanelOpen) {
    return null
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="fixed bottom-6 right-6 z-modal group"
      >
        <Button
          onClick={togglePanel}
          size="icon"
          className={cn(
            'relative h-14 w-14 rounded-full',
            'bg-primary text-primary-foreground',
            'hover:bg-primary/90',
            'transition-colors duration-200',
            'shadow-[var(--shadow-float)]',
          )}
          title={t('trigger.title')}
        >
          <MessageSquare className="h-6 w-6" />
        </Button>

        {/* 提示气泡 */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.2 }}
          className={cn(
            'absolute bottom-full right-0 mb-3',
            'px-3 py-2 rounded-interactive',
            'text-body font-medium',
            OVERLAY_SURFACE_CLASS,
            'whitespace-nowrap pointer-events-none',
            'group-hover:opacity-0 transition-opacity duration-200'
          )}
        >
          <div className="flex items-center gap-2">
            <span>{t('trigger.hint')}</span>
          </div>
          <div className="absolute -bottom-1.5 right-6 w-3 h-3 bg-[hsl(var(--glass-bg-strong))] rotate-45" />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
