/**
 * PromptComposeDialog — 编写并发送一条指令卡（metadata.card.type='prompt'）。
 *
 * 体验：单输入区（首行即卡片标题）→ 发给 {同事}（IM 上下文已明确对端，不再重复展示收件人条）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SquareTerminal } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle } from '@components/ui'
import { cn } from '@utils/cn'

export const PROMPT_CARD_TEXT_MAX_LEN = 8000
export const PROMPT_CARD_TITLE_MAX_LEN = 200

interface Props {
  isOpen: boolean
  onClose: () => void
  onSend: (promptText: string, title: string) => void
  /** 用于 CTA「发给 {name}」；IM 输入区已有对端上下文，不在弹窗内重复展示收件人条 */
  recipientName?: string | null
}

function resolvePromptTitleFromText(promptText: string): string {
  const firstLine = promptText
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? ''
  return firstLine.slice(0, PROMPT_CARD_TITLE_MAX_LEN)
}

export const PromptComposeDialog: React.FC<Props> = ({
  isOpen,
  onClose,
  onSend,
  recipientName,
}) => {
  const { t } = useTranslation('tabchat')
  const [promptText, setPromptText] = useState('')

  useEffect(() => {
    if (!isOpen) setPromptText('')
  }, [isOpen])

  const trimmedText = promptText.trim()
  const canSend = trimmedText.length > 0 && trimmedText.length <= PROMPT_CARD_TEXT_MAX_LEN

  const recipientLabel = useMemo(() => {
    const name = recipientName?.trim()
    if (!name) return null
    return name
  }, [recipientName])

  const submitLabel = recipientLabel
    ? t('promptComposeSubmitTo', {
      name: recipientLabel,
      defaultValue: `发给 ${recipientLabel}`,
    })
    : t('promptComposeSend', { defaultValue: '发送' })

  const handleSend = useCallback(() => {
    if (!canSend) return
    const title = resolvePromptTitleFromText(trimmedText)
    onSend(trimmedText, title)
    onClose()
  }, [canSend, onClose, onSend, trimmedText])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[440px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <SquareTerminal className="h-4 w-4 text-accent" aria-hidden />
          <DialogTitle className="text-body font-medium">
            {t('promptComposeTitle', { defaultValue: '发送指令' })}
          </DialogTitle>
        </div>

        <div className="px-4 py-4">
          <label className="block space-y-1.5">
            <span className="sr-only">
              {t('promptComposeBodyField', { defaultValue: '指令内容' })}
            </span>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              maxLength={PROMPT_CARD_TEXT_MAX_LEN}
              rows={9}
              placeholder={t('promptComposeTextPlaceholder', {
                defaultValue: '写下希望对方 Agent 执行的步骤与要求…\n第一行会作为卡片标题',
              })}
              className={cn(
                'w-full resize-none rounded-interactive bg-muted/30 px-3 py-2.5 text-body outline-none',
                'placeholder:text-muted-foreground/60 focus:bg-muted/45',
              )}
              autoFocus
            />
            <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground/70">
              <span>
                {t('promptComposeApplyHint', {
                  defaultValue: '对方可一键预填到新任务，发送仍由其确认',
                })}
              </span>
              <span className="shrink-0 tabular-nums">
                {promptText.length} / {PROMPT_CARD_TEXT_MAX_LEN}
              </span>
            </div>
          </label>
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            {t('promptComposeCancel', { defaultValue: '取消' })}
          </Button>
          <Button disabled={!canSend} onClick={handleSend}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
