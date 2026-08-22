/**
 * MermaidBlock - 懒加载 Mermaid 图表渲染组件
 *
 * 如果 mermaid 包不可用，回退显示原始代码。
 */

import React, { useEffect, useRef, useState, useId } from 'react'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useUIStore } from '@stores/useUIStore'
import { mermaidConfigFor, sanitizeMermaidSvg } from './mermaidRender'

let mermaidInstance: typeof import('mermaid') | null = null
let mermaidLoading = false
const loadCallbacks: Array<() => void> = []

function ensureMermaid(cb: () => void) {
  if (mermaidInstance) {
    cb()
    return
  }
  loadCallbacks.push(cb)
  if (mermaidLoading) return
  mermaidLoading = true
  import('mermaid')
    .then((mod) => {
      mermaidInstance = mod
      loadCallbacks.forEach((fn) => fn())
      loadCallbacks.length = 0
    })
    .catch(() => {
      mermaidLoading = false
      loadCallbacks.forEach((fn) => fn())
      loadCallbacks.length = 0
    })
}

interface MermaidBlockProps {
  code: string
}

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const uniqueId = useId().replace(/:/g, '_')
  const resolvedTheme = useUIStore((s) => s.resolvedTheme)

  useEffect(() => {
    let cancelled = false

    ensureMermaid(async () => {
      if (cancelled || !mermaidInstance) {
        if (!cancelled) setError('mermaid 未安装')
        return
      }
      try {
        // 配置是 mermaid 的全局状态，每次渲染前重设才能让主题切换立即生效。
        mermaidInstance.default.initialize(mermaidConfigFor(resolvedTheme))
        const { svg: rendered } = await mermaidInstance.default.render(
          `mermaid-${uniqueId}`,
          code,
        )
        if (!cancelled) setSvg(sanitizeMermaidSvg(rendered))
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })

    return () => {
      cancelled = true
    }
  }, [code, uniqueId, resolvedTheme])

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
        <div className="mb-1 text-caption font-medium text-warning">Mermaid 渲染失败</div>
        <pre className="break-words text-body text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center rounded-lg border border-border/40 bg-muted/20 p-6 text-muted-foreground text-body">
        渲染图表中…
      </div>
    )
  }

  return (
    <ScrollArea className="my-3 rounded-lg border border-border/40 bg-background" scrollBar="horizontal">
      <div
        ref={containerRef}
        className="flex justify-center p-4 [&>svg]:max-h-[70vh]"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ScrollArea>
  )
}

MermaidBlock.displayName = 'MermaidBlock'
