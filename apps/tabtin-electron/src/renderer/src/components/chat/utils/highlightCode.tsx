/**
 * highlightCode — chat 代码卡（DiffCard / CodeBlock）的语法高亮工具。
 *
 * 复用 chat Markdown 已用的 highlight.js 引擎（lowlight，与 rehype-highlight 同源），
 * 把一段代码 tokenize 成带 `hljs-*` class 的 span 树。颜色由 globals.css 的
 * `.tabtin-code-hl .hljs-*` 主题提供——所以**渲染容器必须带 `tabtin-code-hl` class**
 * 作为色彩作用域（见 DiffCard / CodeBlock）。
 *
 * 设计取向：代码符号色和 diff 红绿一样属于「信息本身」，不是装饰——一眼能分清
 * 关键字 / 字符串 / 标签，阅读 diff 与文件内容的效率显著高于单色。
 */

import React, { useMemo } from 'react'
import { common, createLowlight } from 'lowlight'

// 模块级单例：common 覆盖 ~35 种常见语言，足够 chat 场景；按需可换 all。
const lowlight = createLowlight(common)

/** 文件后缀 → highlight.js 语言 id。命不中返回 undefined（= 不高亮，原样纯文本）。 */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml', svg: 'xml', snap: 'xml',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', php: 'php', swift: 'swift', dart: 'dart',
}

export function langFromFileName(fileName?: string | null): string | undefined {
  if (!fileName) return undefined
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim())
  if (!m) return undefined
  return EXT_TO_LANG[m[1].toLowerCase()]
}

type HastNode =
  | { type: 'text'; value: string }
  | { type: 'element'; properties?: { className?: string[] }; children: HastNode[] }
  | { type: 'root'; children: HastNode[] }

function renderHast(nodes: HastNode[], keyPrefix = ''): React.ReactNode {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.value
    if (n.type === 'element') {
      const cls = n.properties?.className?.join(' ')
      return (
        <span key={`${keyPrefix}${i}`} className={cls}>
          {renderHast(n.children, `${keyPrefix}${i}-`)}
        </span>
      )
    }
    return null
  })
}

export interface HighlightedCodeProps {
  code: string
  /** highlight.js 语言 id（用 langFromFileName 从文件名推）；缺省/不支持 → 原样纯文本 */
  lang?: string
}

/**
 * 把一行/一段代码渲染成高亮 span。无 lang 或 lowlight 抛错（语言未注册）时
 * 降级为原样文本——永远不丢内容。
 */
export const HighlightedCode: React.FC<HighlightedCodeProps> = React.memo(({ code, lang }) => {
  const nodes = useMemo<HastNode[] | null>(() => {
    if (!code || !lang) return null
    try {
      const tree = lowlight.highlight(lang, code) as unknown as { children: HastNode[] }
      return tree.children
    } catch {
      return null
    }
  }, [code, lang])
  if (!nodes) return <>{code}</>
  return <>{renderHast(nodes)}</>
})

HighlightedCode.displayName = 'HighlightedCode'
