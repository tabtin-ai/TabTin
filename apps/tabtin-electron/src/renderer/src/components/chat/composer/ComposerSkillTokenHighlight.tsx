/**
 * Composer 输入区内的斜杠 Skill token 叠层高亮（pill）。
 *
 * textarea 无法渲染 inline chip，因此在正下方叠一层只读镜像：
 * 已确认的 token（可多个）用主题色底/字，其余文本保持前景色；
 * textarea 本身在有高亮时文字透明，只保留 caret / 选区。
 */

import React, { useEffect, useRef } from 'react'
import { cn } from '@utils/cn'
import type { ComposerSkillTokenHighlight as HighlightSpan } from '../skill/skillSlashCommand'

/**
 * 主题色浅底 + 降饱和主题文字。
 * 故意不加 px / -mx：水平 padding + 负 margin 会让相邻 pill（中间只有一个空格）背景互相侵占重叠，
 * 且叠层必须与 textarea 字宽严格对齐，不能靠 padding 撑宽。
 */
export const COMPOSER_SKILL_TOKEN_PILL_CLASS =
  'rounded-[4px] bg-accent/15 box-decoration-clone text-accent-text'

interface ComposerSkillTokenHighlightOverlayProps {
  value: string
  highlights: HighlightSpan[]
  /** 与 textarea 完全同款的 typography + padding class，保证字距/换行对齐 */
  surfaceClassName: string
  scrollTop: number
}

export function ComposerSkillTokenHighlightOverlay({
  value,
  highlights,
  surfaceClassName,
  scrollTop,
}: ComposerSkillTokenHighlightOverlayProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (el.scrollTop !== scrollTop) el.scrollTop = scrollTop
  }, [scrollTop])

  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const highlight of highlights) {
    if (highlight.start > cursor) {
      nodes.push(value.slice(cursor, highlight.start))
    }
    nodes.push(
      <span key={`skill-token-${highlight.start}`} className={COMPOSER_SKILL_TOKEN_PILL_CLASS}>
        {value.slice(highlight.start, highlight.end)}
      </span>,
    )
    cursor = highlight.end
  }
  if (cursor < value.length) {
    nodes.push(value.slice(cursor))
  }
  if (value.endsWith('\n')) {
    nodes.push('\n')
  }

  return (
    <div
      ref={scrollerRef}
      aria-hidden
      data-testid="composer-skill-token-highlight"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className={cn('w-full whitespace-pre-wrap break-words', surfaceClassName)}>
        {nodes}
      </div>
    </div>
  )
}
