import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Textarea,
} from '@components/ui'

interface TeamSpaceCreateTaskDialogProps {
  isOpen: boolean
  isSubmitting: boolean
  sourcePreview: string
  onClose: () => void
  onConfirm: (additionalContext: string) => void
}

export const TEAM_SPACE_TASK_ADDITIONAL_CONTEXT_MAX_LEN = 4000

export const TeamSpaceCreateTaskDialog: React.FC<TeamSpaceCreateTaskDialogProps> = ({
  isOpen,
  isSubmitting,
  sourcePreview,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation('tabchat')
  const [additionalContext, setAdditionalContext] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isOpen) {
      setAdditionalContext('')
      return
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }, [isOpen])

  const trimmed = additionalContext.trim()

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !isSubmitting) onClose() }}>
      <DialogContent className="w-[420px] max-w-[calc(100vw-32px)] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Bot className="h-4 w-4 text-accent-text" />
          <DialogTitle className="text-body font-medium">
            {t('agentTaskDialogTitle', { defaultValue: '询问 Agent' })}
          </DialogTitle>
        </div>

        <div className="space-y-3 px-4 py-4">
          <DialogDescription className="text-caption text-muted-foreground">
            {t('agentTaskDialogDescription', {
              defaultValue: '源消息和回复线程会自动带入，你也可以补充更明确的问题、边界或产出要求。',
            })}
          </DialogDescription>

          <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
            <div className="text-caption font-medium text-muted-foreground">
              {t('agentTaskDialogSourceLabel', { defaultValue: '默认上下文' })}
            </div>
            <p className="mt-1 line-clamp-3 text-body text-foreground/90">
              {sourcePreview || t('agentTaskDialogSourceFallback', { defaultValue: '将自动带入这条消息和它的回复线程。' })}
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="text-caption font-medium text-muted-foreground">
              {t('agentTaskDialogAdditionalContextLabel', { defaultValue: '补充上下文（可选）' })}
            </span>
            <Textarea
              ref={textareaRef}
              value={additionalContext}
              maxLength={TEAM_SPACE_TASK_ADDITIONAL_CONTEXT_MAX_LEN}
              rows={5}
              disabled={isSubmitting}
              placeholder={t('agentTaskDialogAdditionalContextPlaceholder', {
                defaultValue: '例如：希望 Agent 优先验证哪句话、避开什么方向，或把回答限制成某种格式。',
              })}
              onChange={(event) => setAdditionalContext(event.target.value)}
              className="resize-none text-body"
            />
            <span className="block text-right text-caption text-muted-foreground">
              {additionalContext.length}/{TEAM_SPACE_TASK_ADDITIONAL_CONTEXT_MAX_LEN}
            </span>
          </label>
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onClose}>
            {t('cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => onConfirm(trimmed)}
          >
            {isSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {t('agentTaskDialogConfirm', { defaultValue: '发送并打开' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
