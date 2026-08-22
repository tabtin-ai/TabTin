/**
 * SafeHighlight — 安全的搜索高亮渲染（PRD 8.3.C）
 *
 * 后端 ES 在 highlight 片段里返回 `<em>...</em>` 标记。
 * **禁止** `dangerouslySetInnerHTML`（XSS 风险）。
 * 本组件只识别 `<em>` 标签把命中部分包成 `<mark>`，其余文本作为
 * React 文本节点输出（自动 HTML 转义），任何 `<script>` / `<img onerror>`
 * 都会被 React 当作纯文本，永不执行。
 *
 * 兼容多次出现的命中片段、空字符串、null。
 */

import React, { memo } from 'react'

// 大小写不敏感 + dotall：兼容潜在的网关大小写改写、ES 自定义高亮标签变种
const EM_PATTERN = /(<em>[\s\S]*?<\/em>)/gi

interface SafeHighlightProps {
  /** 含 `<em>...</em>` 的字符串；其他 HTML 字符被原样渲染（React 自动 escape） */
  html: string | null | undefined
  /** 应用到 `<mark>` 的额外 className（默认主题色高亮） */
  markClassName?: string
}

const DEFAULT_MARK_CLASSNAME = 'bg-transparent text-primary font-medium p-0'

function SafeHighlightImpl({ html, markClassName = DEFAULT_MARK_CLASSNAME }: SafeHighlightProps) {
  if (!html) return null
  // split 保留分隔符 → 偶数索引是普通文本，奇数索引是匹配到的 <em>...</em>
  const parts = html.split(EM_PATTERN)
  if (parts.length === 1) return <>{html}</>
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        const lower = part.toLowerCase()
        if (lower.startsWith('<em>') && lower.endsWith('</em>')) {
          // slice(4, -5) 准确剥掉 <em>/<EM> 与 </em>/</EM>（同样是 4/5 个字符）
          return (
            <mark key={i} className={markClassName}>
              {part.slice(4, -5)}
            </mark>
          )
        }
        return <React.Fragment key={i}>{part}</React.Fragment>
      })}
    </>
  )
}

export const SafeHighlight = memo(SafeHighlightImpl)
