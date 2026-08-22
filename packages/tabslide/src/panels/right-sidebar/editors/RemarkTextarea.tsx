import React, { useCallback, useRef, useEffect } from 'react'
import { useSlideStore } from '../../../store/slide'
import { useHistoryStore } from '../../../store/history'
import { useT } from '../../../i18n'

export const RemarkTextarea: React.FC<{
  value: string
  pageIndex: number
  /** 底部胶片条等紧凑区域：固定高度、内部滚动，不做 auto-resize */
  compact?: boolean
  autoFocus?: boolean
}> = ({ value, pageIndex, compact = false, autoFocus = false }) => {
  const translate = useT()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const snapshotPushedRef = useRef(false)

  const pushSnapshotOnce = useCallback(() => {
    if (snapshotPushedRef.current) return
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    snapshotPushedRef.current = true
  }, [])

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 300)}px`
  }, [])

  useEffect(() => {
    if (compact) return
    autoResize()
  }, [value, autoResize, compact])

  return (
    <textarea
      ref={textareaRef}
      value={value}
      placeholder={translate('property.remarkPlaceholder')}
      onChange={(e) => {
        pushSnapshotOnce()
        useSlideStore.getState().updatePageRemark(pageIndex, e.target.value)
      }}
      className={
        compact
          ? 'h-full min-h-0 w-full resize-none overflow-y-auto rounded bg-muted/40 px-1.5 py-1 text-caption leading-snug text-foreground outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:ring-1 focus:ring-accent/40 placeholder:text-muted-foreground/60'
          : 'min-h-[60px] w-full resize-y rounded bg-muted/40 px-1.5 py-1.5 text-body leading-relaxed text-foreground outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:ring-1 focus:ring-accent/40 placeholder:text-muted-foreground/60'
      }
      style={compact ? undefined : { maxHeight: 300 }}
      autoFocus={autoFocus}
      onFocus={() => { snapshotPushedRef.current = false }}
    />
  )
}
