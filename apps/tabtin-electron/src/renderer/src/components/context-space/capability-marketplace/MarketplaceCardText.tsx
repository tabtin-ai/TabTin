import { useCallback, useLayoutEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useScopedResizeObserver } from '@hooks/spaceActivity'
import { cn } from '@utils/cn'
import { fitMarketplaceTextWithEllipsis } from './marketplaceCardTextFit'

interface MarketplaceCardTextProps {
  text: string
  lines: 1 | 2
  className?: string
}

function normalizeMarketplaceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function createMeasurementNode(source: HTMLElement, lines: 1 | 2): HTMLSpanElement {
  const computed = window.getComputedStyle(source)
  const node = document.createElement('span')
  node.style.position = 'fixed'
  node.style.left = '-10000px'
  node.style.top = '0'
  node.style.visibility = 'hidden'
  node.style.pointerEvents = 'none'
  node.style.display = 'block'
  node.style.width = `${source.clientWidth}px`
  node.style.height = 'auto'
  node.style.maxHeight = 'none'
  node.style.overflow = 'visible'
  node.style.whiteSpace = lines === 1 ? 'nowrap' : 'normal'
  node.style.font = computed.font
  node.style.fontSize = computed.fontSize
  node.style.fontWeight = computed.fontWeight
  node.style.letterSpacing = computed.letterSpacing
  node.style.lineHeight = computed.lineHeight
  node.style.wordBreak = computed.wordBreak
  node.style.overflowWrap = computed.overflowWrap
  return node
}

function textFits(node: HTMLSpanElement, text: string, lines: 1 | 2, lineHeight: number): boolean {
  node.textContent = text
  if (lines === 1) return node.scrollWidth <= node.clientWidth + 0.5
  return node.scrollHeight <= lineHeight * lines + 0.5
}

function fitTextToRenderedLines(source: HTMLElement, fullText: string, lines: 1 | 2): string {
  if (!fullText || source.clientWidth <= 0) return fullText

  const computed = window.getComputedStyle(source)
  const parsedLineHeight = Number.parseFloat(computed.lineHeight)
  const lineHeight = Number.isFinite(parsedLineHeight)
    ? parsedLineHeight
    : Number.parseFloat(computed.fontSize) * 1.5
  const measurement = createMeasurementNode(source, lines)
  document.body.appendChild(measurement)

  try {
    return fitMarketplaceTextWithEllipsis(
      fullText,
      candidate => textFits(measurement, candidate, lines, lineHeight),
    )
  } finally {
    measurement.remove()
  }
}

export function MarketplaceCardText({ text, lines, className }: MarketplaceCardTextProps) {
  const fullText = normalizeMarketplaceText(text)
  const [textElement, setTextElement] = useState<HTMLSpanElement | null>(null)
  const [displayText, setDisplayText] = useState(fullText)

  const measure = useCallback(() => {
    if (!textElement) return
    setDisplayText(fitTextToRenderedLines(textElement, fullText, lines))
  }, [fullText, lines, textElement])

  useLayoutEffect(() => {
    measure()
  }, [measure])
  useScopedResizeObserver(textElement, measure)

  const content = (
    <span
      ref={setTextElement}
      className={cn(
        'block min-w-0 overflow-hidden',
        lines === 1 ? 'whitespace-nowrap' : 'h-[2lh]',
        className,
      )}
    >
      {displayText}
    </span>
  )

  if (displayText === fullText) return content
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[28rem] whitespace-normal break-words">
          {fullText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
