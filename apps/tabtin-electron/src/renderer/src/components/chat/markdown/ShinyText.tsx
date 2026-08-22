/**
 * ShinyText — React Bits 风格扫光文字（纯 CSS，无 motion 依赖）。
 * @see https://reactbits.dev/text-animations/shiny-text
 */
import React, { useLayoutEffect, useRef } from 'react'
import { cn } from '@utils/cn'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'

export type ShinyTextProps = React.HTMLAttributes<HTMLSpanElement> & {
  children: React.ReactNode
  /** 单次扫过时长（秒），默认 1.6 */
  speed?: number
  /** 允许该实例与其他扫光文字同时激活；默认仍维持页面内单实例动效。 */
  allowConcurrent?: boolean
}

type ShinyEntry = {
  node: HTMLSpanElement
  isForeground: boolean
  order: number
}

const shinyEntries = new Set<ShinyEntry>()
let shinyOrder = 0

function syncActiveShinyText(): void {
  const visible = [...shinyEntries]
    .filter((entry) => (
      entry.isForeground
      && entry.node.isConnected
      && entry.node.getClientRects().length > 0
    ))
    .sort((a, b) => a.order - b.order)
  const active = visible.at(-1)
  for (const entry of shinyEntries) {
    if (!entry.node.isConnected) {
      shinyEntries.delete(entry)
      continue
    }
    entry.node.dataset.shinyActive = entry === active ? 'true' : 'false'
  }
}

export const ShinyText: React.FC<ShinyTextProps> = ({
  children,
  className,
  speed = 1.6,
  allowConcurrent = false,
  style,
  ...rest
}) => {
  const nodeRef = useRef<HTMLSpanElement>(null)
  const { isForeground } = useSpaceActivity()

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (allowConcurrent) {
      node.dataset.shinyActive = isForeground ? 'true' : 'false'
      return () => {
        delete node.dataset.shinyActive
      }
    }
    const order = shinyOrder
    shinyOrder += 1
    const entry: ShinyEntry = {
      node,
      isForeground,
      order,
    }
    shinyEntries.add(entry)
    syncActiveShinyText()
    return () => {
      shinyEntries.delete(entry)
      syncActiveShinyText()
    }
  }, [allowConcurrent, isForeground])

  return (
    <span
      ref={nodeRef}
      className={cn('thinking-shiny-text', className)}
      style={{ animationDuration: `${speed}s`, ...style }}
      data-testid="shiny-text"
      {...rest}
    >
      {children}
    </span>
  )
}
ShinyText.displayName = 'ShinyText'
