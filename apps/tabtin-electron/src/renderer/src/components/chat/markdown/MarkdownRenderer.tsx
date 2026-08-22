/**
 * MarkdownRenderer - 对话消息 Markdown 渲染组件
 *
 * 功能：
 * - GFM（表格/删除线/任务列表/自动链接）
 * - 代码块语法高亮 + 语言标签 + 一键复制
 * - 代码引用块 (startLine:endLine:filepath)
 * - 流式输出兼容（增量渲染）
 */

import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { Check, Copy, FileCode2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { Components } from 'react-markdown'
import { MermaidBlock } from './MermaidBlock'
import { safeCopyToClipboard } from '../utils/clipboard'
import { sanitizeSchema, rehypeSanitizeCss } from '@/lib/rehypeSanitizeSchema'
import { splitStreamingMarkdown } from './StreamingMarkdownSplitter'
import { remarkAutolinkResource } from '@tabtin/markdown-resource-autolink'
import { parseResourcePointer } from '@tabtin/resource-router'
import { normalizeSchemelessWebHref } from '@shared/normalize-web-href'
import { resourceRouter } from '@/services/resourceRouter'
import {
  expandCanvasAfterInSpaceOpen,
  resolveSpaceIdForResourceLink,
} from '@/services/openResourceLink'
import { resolveMarkdownResourceLinkLabel } from '../richContent/resolveResourceRefDisplayName'
import { showResourceLinkContextMenu } from '../context/ResourceLinkContextMenu'
import { tryOpenPreviewableDirectUrl } from '../preview/assetPreviewResolver'
import { createLogger } from '@/utils/logger'
import {
  CHAT_MARKDOWN_CODE_BLOCK,
  CHAT_MARKDOWN_HEADING_1,
  CHAT_MARKDOWN_HEADING_2,
  CHAT_MARKDOWN_HEADING_3,
  CHAT_MARKDOWN_HEADING_MINOR,
  CHAT_MARKDOWN_INLINE_CODE,
  CHAT_MARKDOWN_PROSE_LEADING,
  CHAT_MESSAGE_TEXT_BODY,
  IMAGE_PREVIEW,
} from '../registry/chatDesignTokens'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const CODE_BLOCK_HINT_REGEX = /(^|\n)\s*(```|~~~)|(^|\n)( {4}|\t)\S/m
const linkLog = createLogger('MarkdownRenderer.link')
const MarkdownTabScopeContext = React.createContext<string | null>(null)
const MarkdownResourceSpaceContext = React.createContext<string | null>(null)
const MarkdownLinksEnabledContext = React.createContext(true)

/**
 * react-markdown 默认 `urlTransform` 走 `safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i`
 * 协议白名单，把 `tabtin://` / `file://` / `tel:` / 自定义 scheme 的 href 替换
 * 为空字符串——这是 D4 改造前已知的"sanitize 第二层"。
 *
 * W3 改造（RFC §3.3 / §4 D4 默认全开）：自定义 urlTransform 走"全开 + known-bad
 * 黑名单"语义，与 `packages/media-core/svg/primitives.ts:HREF_DANGEROUS_RE` 同款
 * （仅拦 `javascript:` / `vbscript:` / `data:text/html` 三类已确认 XSS 向量）。
 *
 * 任何扩展请同步那里 + 这里。
 */
const KNOWN_BAD_HREF_PROTOCOLS = /^(?:javascript|vbscript)$/i
function permissiveUrlTransform(value: string, key: string): string {
  if (typeof value !== 'string') return ''
  // href / src 上拦 known-bad；其余 attr 一律放行
  if (key === 'href' || key === 'src' || key === 'xlinkHref') {
    const colon = value.indexOf(':')
    if (colon > 0) {
      const proto = value.slice(0, colon)
      if (KNOWN_BAD_HREF_PROTOCOLS.test(proto)) return ''
      // data:text/html 单独检查（其它 data:image/* 等放行）
      if (proto.toLowerCase() === 'data') {
        const lower = value.toLowerCase()
        if (lower.startsWith('data:text/html') || lower.startsWith('data:application/xhtml')) {
          return ''
        }
      }
    }
  }
  return value
}

type ES2024String = string & { toWellFormed(): string }
type MarkdownAstNode = {
  type?: string
  children?: MarkdownAstNode[]
}
type MarkdownRoot = MarkdownAstNode
type RehypeTransformer = (tree: MarkdownRoot, file: unknown) => void
type RehypeAttacher = (...args: unknown[]) => RehypeTransformer | void
type MarkdownRehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>

function shouldFallbackOpenExternal(href: string): boolean {
  return /^(https?|mailto):/i.test(href)
}

function normalizeMarkdownContent(content: string): string {
  const input = typeof content === 'string' ? content : String(content ?? '')
  const wellFormed = typeof (input as ES2024String).toWellFormed === 'function'
    ? (input as ES2024String).toWellFormed()
    : input
  let normalized = wellFormed
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(CONTROL_CHAR_REGEX, '')

  // Fix AI-generated orphaned numbered list items:
  // "1.\n\nContent" → "1. Content" (collapse blank lines between number and content)
  normalized = normalized.replace(/^(\d+\.)[ \t]*\n\n+(?=\S)/gm, '$1 ')

  return normalized
}

function shouldEnableHighlight(content: string): boolean {
  return CODE_BLOCK_HINT_REGEX.test(content)
}

interface NodeWithChildren {
  children?: MarkdownAstNode[]
}

function rehypePruneInvalidChildren() {
  return (tree: MarkdownRoot) => {
    const stack: MarkdownAstNode[] = [tree]
    while (stack.length > 0) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue

      if ('children' in node) {
        const parent = node as NodeWithChildren
        if (!Array.isArray(parent.children)) {
          delete parent.children
          continue
        }

        const children = parent.children
        const cleaned = children.filter(
          (c) => c != null && typeof c === 'object' && typeof c.type === 'string'
        )
        if (cleaned.length !== children.length) {
          parent.children = cleaned
        }

        for (const child of parent.children) {
          if (child && typeof child === 'object') stack.push(child)
        }
      }
    }
  }
}

function wrapSafeRehypeHighlight(
  attacher: RehypeAttacher
): () => RehypeTransformer {
  return () => {
    let transformer: RehypeTransformer | undefined
    try {
      transformer = attacher() as RehypeTransformer | undefined
    } catch {
      return () => {}
    }
    return (tree: MarkdownRoot, file: unknown) => {
      try {
        return transformer?.(tree, file)
      } catch {
        // highlight failed — skip silently, code blocks still render uncolored
      }
    }
  }
}

interface MarkdownErrorBoundaryProps {
  children: React.ReactNode
  resetKey: string
  fallback: React.ReactNode
  onError?: (error: unknown) => void
}

interface MarkdownErrorBoundaryState {
  hasError: boolean
}

class MarkdownErrorBoundary extends React.Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): MarkdownErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error)
  }

  componentDidUpdate(prevProps: MarkdownErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

/* ---------- rehype-highlight 延迟加载（模块级预加载） ---------- */
let _rehypeHighlightPlugin: RehypeAttacher | null = null
const _highlightReady = import('rehype-highlight').then(mod => {
  _rehypeHighlightPlugin = mod.default as RehypeAttacher
  return _rehypeHighlightPlugin
})

function useRehypeHighlight() {
  const [plugin, setPlugin] = useState<RehypeAttacher | null>(_rehypeHighlightPlugin)
  useEffect(() => {
    if (!plugin) {
      _highlightReady.then(p => setPlugin(() => p))
    }
  }, [plugin])
  return plugin
}

/* ---------- 代码引用格式检测 ---------- */
const CODE_REF_PATTERN = /^(\d+):(\d+):(.+)$/

/* ---------- 代码块复制按钮 ---------- */

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    safeCopyToClipboard(text, () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-all',
        copied
          ? 'text-success'
          : 'text-muted-foreground/80 hover:text-foreground hover:bg-muted/60'
      )}
      title={copied ? t('card.copied') : t('card.copy_code')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? t('card.copied') : t('card.copy_label')}</span>
    </button>
  )
}

/* ---------- 提取代码块纯文本 ---------- */

function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('')
  if (React.isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode }
    return extractTextFromChildren(props.children)
  }
  return String(children ?? '')
}

/* ---------- 代码引用块（startLine:endLine:filepath） ---------- */

const CodeReference: React.FC<{
  startLine: number
  endLine: number
  filePath: string
  children: React.ReactNode
  codeText: string
}> = ({ startLine, endLine, filePath, children, codeText }) => {
  const fileName = filePath.split('/').pop() || filePath
  const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`

  return (
    <div className="group/coderef my-4 overflow-hidden rounded-lg border border-accent/20 bg-accent/5">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-accent/10 bg-accent/5 px-3 py-1.5">
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-accent', CHAT_MESSAGE_TEXT_BODY)}>
          <FileCode2 className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium">{fileName}</span>
          <span className="shrink-0 text-muted-foreground/60">{lineRange}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 max-w-[min(100%,300px)] truncate text-caption text-muted-foreground/60"
            title={filePath}
          >
            {filePath}
          </span>
          <CopyButton text={codeText} />
        </div>
      </div>
      <ScrollArea scrollBar="horizontal">
        <pre className={cn('!m-0 !bg-transparent p-4', CHAT_MARKDOWN_CODE_BLOCK)}>
          <code className="!bg-transparent">{children}</code>
        </pre>
      </ScrollArea>
    </div>
  )
}

/* ---------- 可折叠代码块 ---------- */

const CODE_COLLAPSE_LINE_THRESHOLD = 50
const COLLAPSED_CODE_MAX_HEIGHT = '400px'

const _codeExpandState = new Map<string, boolean>()
const MAX_CODE_EXPAND_ENTRIES = 200
function _getCodeExpandKey(codeText: string): string {
  let h = 0
  for (let i = 0; i < Math.min(codeText.length, 500); i++) {
    h = ((h << 5) - h + codeText.charCodeAt(i)) | 0
  }
  return `cb-${h}-${codeText.length}`
}

const CollapsibleCodeBlock: React.FC<{
  lang: string
  codeText: string
  className?: string
  children: React.ReactNode
  rest?: Record<string, unknown>
}> = ({ lang, codeText, className, children, rest = {} }) => {
  const { t } = useTranslation('chat')
  const lineCount = codeText.split('\n').length
  const shouldCollapse = lineCount > CODE_COLLAPSE_LINE_THRESHOLD
  const expandKey = useMemo(() => _getCodeExpandKey(codeText), [codeText])
  const [isExpanded, setIsExpanded] = useState(() => {
    if (!shouldCollapse) return true
    return _codeExpandState.get(expandKey) ?? false
  })

  const prevExpandKeyRef = useRef(expandKey)
  useEffect(() => {
    if (prevExpandKeyRef.current !== expandKey) {
      const prevState = _codeExpandState.get(prevExpandKeyRef.current)
      if (prevState !== undefined) {
        _codeExpandState.delete(prevExpandKeyRef.current)
        _codeExpandState.set(expandKey, prevState)
        setIsExpanded(prevState)
      }
      prevExpandKeyRef.current = expandKey
    }
  }, [expandKey])

  const handleToggle = useCallback((expanded: boolean) => {
    setIsExpanded(expanded)
    _codeExpandState.delete(expandKey)
    _codeExpandState.set(expandKey, expanded)
    if (_codeExpandState.size > MAX_CODE_EXPAND_ENTRIES) {
      const firstKey = _codeExpandState.keys().next().value
      if (firstKey !== undefined) _codeExpandState.delete(firstKey)
    }
  }, [expandKey])

  return (
    <div className="group/code relative my-4 overflow-hidden rounded-lg border border-border/20 bg-muted/15">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/15 bg-muted/20 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-caption font-medium uppercase tracking-wider text-muted-foreground/60">
          {lang || 'code'}
          {shouldCollapse && (
            <span className="ml-1.5 normal-case tracking-normal font-normal text-muted-foreground/40">
              ({lineCount} {t('code.lines', { defaultValue: 'lines' })})
            </span>
          )}
        </span>
        <CopyButton text={codeText} />
      </div>
      <div
        className="relative"
        style={!isExpanded && shouldCollapse ? { maxHeight: COLLAPSED_CODE_MAX_HEIGHT, overflow: 'hidden' } : undefined}
      >
        <ScrollArea scrollBar="horizontal">
          <pre className={cn('!m-0 !bg-transparent p-4', CHAT_MARKDOWN_CODE_BLOCK)}>
            <code className={cn(className, '!bg-transparent')} {...rest}>
              {children}
            </code>
          </pre>
        </ScrollArea>
        {shouldCollapse && !isExpanded && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[hsl(var(--muted)/0.8)] to-transparent pointer-events-none" />
        )}
      </div>
      {shouldCollapse && !isExpanded && (
        <button
          type="button"
          onClick={() => handleToggle(true)}
          className="w-full py-1.5 text-center text-caption font-medium text-accent hover:text-accent/80 transition-colors border-t border-border/10"
        >
          {t('code.expandAll', { count: lineCount, defaultValue: `展开全部 (${lineCount} 行)` })}
        </button>
      )}
      {shouldCollapse && isExpanded && (
        <button
          type="button"
          onClick={() => handleToggle(false)}
          className="w-full py-1 text-center text-caption font-medium text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors border-t border-border/10"
        >
          {t('code.collapse', { defaultValue: '收起' })}
        </button>
      )}
    </div>
  )
}

/* ---------- Chat Markdown 排版 ---------- */

const markdownTypography = {
  inlineCode: cn(
    'break-words rounded-md border border-border/15 bg-muted/25 px-1.5 py-0.5 [overflow-wrap:anywhere]',
    CHAT_MARKDOWN_INLINE_CODE,
  ),
  paragraph: cn(
    'my-3 first:mt-0 min-w-0 break-words [overflow-wrap:anywhere]',
    CHAT_MARKDOWN_PROSE_LEADING,
  ),
  heading1: CHAT_MARKDOWN_HEADING_1,
  heading2: CHAT_MARKDOWN_HEADING_2,
  heading3: CHAT_MARKDOWN_HEADING_3,
  headingMinor: CHAT_MARKDOWN_HEADING_MINOR,
}

function getMarkdownHeadingClass(level: number): string {
  if (level === 1) return markdownTypography.heading1
  if (level === 2) return markdownTypography.heading2
  if (level === 3) return markdownTypography.heading3
  return markdownTypography.headingMinor
}

/**
 * Markdown 链接（合法组件名才能用 hooks；不能写在 mdComponents.a 小写函数里）。
 * onClick → ResourceRouter；⌘/Ctrl+点击走系统应用；右键菜单。
 */
const MarkdownLink: React.FC<{
  href?: string
  children?: React.ReactNode
}> = ({ href, children }) => {
  const tabScopeKey = React.useContext(MarkdownTabScopeContext)
  const resourceSpaceId = React.useContext(MarkdownResourceSpaceContext)
  const linksEnabled = React.useContext(MarkdownLinksEnabledContext)
  const normalizedHref = href ? normalizeSchemelessWebHref(href) : href
  const linkText = extractTextFromChildren(children)
  const displayText = normalizedHref
    ? resolveMarkdownResourceLinkLabel(normalizedHref, linkText)
    : linkText

  if (!linksEnabled) {
    return <span className="break-words [overflow-wrap:anywhere]">{displayText}</span>
  }

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (!normalizedHref) return
    const isExternalShortcut = e.metaKey || e.ctrlKey
    // 普通点击：xlsx/xls/csv/pdf/image 等直链进预览 Modal，禁止 tabweb BrowserView。
    if (!isExternalShortcut && tryOpenPreviewableDirectUrl(normalizedHref)) {
      linkLog.info('chat markdown previewable file opened in lightbox', { href: normalizedHref })
      return
    }
    const spaceId = resourceSpaceId || resolveSpaceIdForResourceLink(tabScopeKey)
    if (!spaceId) {
      // chat 在 Space 选中前不应有可点链接；保险起见兜底走 system，
      // 用户至少能看到外部应用打开的反馈
      const pointer = parseResourcePointer(normalizedHref)
      void resourceRouter
        .open(spaceId, pointer, {
          modifierExternal: true,
          triggerSource: 'chat_markdown',
        })
        .then((outcome) => linkLog.info('chat markdown link opened without selected space', {
          href: normalizedHref,
          scheme: pointer.scheme,
          outcome: outcome.outcome,
          resolveSource: outcome.resolveSource,
          errorMessage: outcome.errorMessage,
        }))
        .catch((err) => {
          linkLog.warn('chat markdown link open without selected space threw', { href: normalizedHref, err })
          if (shouldFallbackOpenExternal(normalizedHref)) {
            void window.tabtin?.openExternal?.(normalizedHref)
          }
        })
      return
    }
    const pointer = parseResourcePointer(normalizedHref)
    void resourceRouter
      .open(spaceId, pointer, {
        triggerSource: 'chat_markdown',
        tabScopeKey,
        ...(isExternalShortcut ? { modifierExternal: true } : {}),
      })
      .then((outcome) => {
        expandCanvasAfterInSpaceOpen(tabScopeKey, outcome)
        linkLog.info('chat markdown link opened', {
          href: normalizedHref,
          spaceId,
          scheme: pointer.scheme,
          outcome: outcome.outcome,
          carrierAppId: outcome.carrierAppId,
          resolveSource: outcome.resolveSource,
          errorMessage: outcome.errorMessage,
        })
        if (outcome.outcome === 'error' && shouldFallbackOpenExternal(normalizedHref)) {
          linkLog.warn('chat markdown link fallback to external', {
            href: normalizedHref,
            spaceId,
            scheme: pointer.scheme,
            errorMessage: outcome.errorMessage,
          })
          void window.tabtin?.openExternal?.(normalizedHref)
        }
      })
      .catch((err) => {
        linkLog.warn('chat markdown link open threw', { href: normalizedHref, spaceId, err })
        if (shouldFallbackOpenExternal(normalizedHref)) {
          void window.tabtin?.openExternal?.(normalizedHref)
        }
      })
  }
  const onContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (!normalizedHref) return
    const spaceId = resourceSpaceId || resolveSpaceIdForResourceLink(tabScopeKey)
    const pointer = parseResourcePointer(normalizedHref)
    showResourceLinkContextMenu({
      x: e.clientX,
      y: e.clientY,
      href: normalizedHref,
      spaceId,
      tabScopeKey,
      pointer,
    })
  }
  return (
    <a
      href={normalizedHref}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="break-words text-accent underline underline-offset-2 decoration-accent/40 transition-colors [overflow-wrap:anywhere] hover:decoration-accent"
    >
      {displayText}
    </a>
  )
}

/* ---------- 自定义渲染组件 ---------- */

const mdComponents: Components = {
  /* 代码块 & 行内代码 */
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className || '') || String(children).includes('\n')
    if (!isBlock) {
      return (
        <code
          className={markdownTypography.inlineCode}
          {...rest}
        >
          {children}
        </code>
      )
    }

    const lang = (className || '').replace(/language-/, '') || ''
    const codeText = extractTextFromChildren(children).replace(/\n$/, '')

    if (lang === 'mermaid') {
      return <MermaidBlock code={codeText} />
    }

    const refMatch = lang.match(CODE_REF_PATTERN)
    if (refMatch) {
      return (
        <CodeReference
          startLine={parseInt(refMatch[1], 10)}
          endLine={parseInt(refMatch[2], 10)}
          filePath={refMatch[3]}
          codeText={codeText}
        >
          {children}
        </CodeReference>
      )
    }

    return (
      <CollapsibleCodeBlock lang={lang} codeText={codeText} className={className} rest={rest}>
        {children}
      </CollapsibleCodeBlock>
    )
  },

  /* 表格 */
  table({ children }) {
    return (
      <ScrollArea className="my-4 rounded-lg border border-border/20" scrollBar="horizontal">
        <table className={cn('min-w-full', CHAT_MESSAGE_TEXT_BODY)}>{children}</table>
      </ScrollArea>
    )
  },
  thead({ children }) {
    return <thead className="bg-muted/20">{children}</thead>
  },
  th({ children }) {
    return (
      <th className={cn('border-b border-border/20 px-3 py-2 text-left font-semibold text-muted-foreground/80', CHAT_MESSAGE_TEXT_BODY)}>
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td className="border-b border-border/10 px-3 py-2 text-foreground">{children}</td>
    )
  },

  /* 链接（W3 拦截）— 见 MarkdownLink */
  a: MarkdownLink,

  /* 引用块 */
  blockquote({ children }) {
    return (
      <blockquote className="my-3 min-w-0 border-l-2 border-border/40 pl-4 text-muted-foreground/80 break-words [overflow-wrap:anywhere]">
        {children}
      </blockquote>
    )
  },

  /* 列表 */
  ul({ children }) {
    return <ul className="my-2 ml-6 list-disc space-y-2">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-2 ml-6 list-decimal space-y-2">{children}</ol>
  },
  li({ children }) {
    return <li className={cn('text-foreground [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0', CHAT_MARKDOWN_PROSE_LEADING)}>{children}</li>
  },

  /* 标题 */
  h1({ children }) {
    return <h1 className={markdownTypography.heading1}>{children}</h1>
  },
  h2({ children }) {
    return <h2 className={markdownTypography.heading2}>{children}</h2>
  },
  h3({ children }) {
    return <h3 className={markdownTypography.heading3}>{children}</h3>
  },
  h4({ children }) {
    return <h4 className={markdownTypography.headingMinor}>{children}</h4>
  },
  h5({ children }) {
    return <h5 className={markdownTypography.headingMinor}>{children}</h5>
  },
  h6({ children }) {
    return <h6 className={markdownTypography.headingMinor}>{children}</h6>
  },

  /* 段落 */
  p({ children }) {
    return <p className={markdownTypography.paragraph}>{children}</p>
  },

  /* 分隔线 */
  hr() {
    return <hr className="my-6 border-border/25" />
  },

  /* 强调 */
  strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>
  },
  em({ children }) {
    return <em className="italic">{children}</em>
  },
  del({ children }) {
    return <del className="line-through text-muted-foreground/80">{children}</del>
  },

  /* 图片：对话内缩略预览，点击走统一 Lightbox */
  img({ src, alt }) {
    if (!src) return null
    return (
      <button
        type="button"
        className={cn('my-2 block cursor-zoom-in rounded-lg border border-border/30 overflow-hidden', IMAGE_PREVIEW.maxWClass)}
        onClick={() => {
          useResourcePreviewStore.getState().open([{
            id: `md:${src}`,
            kind: 'image',
            url: src,
            name: alt || 'image',
          }], 0)
        }}
        aria-label={alt || '查看图片'}
      >
        <img
          src={src}
          alt={alt || ''}
          className={IMAGE_PREVIEW.img}
          loading="lazy"
        />
      </button>
    )
  },
}

/* ---------- Level 3 简化渲染器（无 remark/rehype pipeline） ---------- */

const SIMPLIFIED_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const SIMPLIFIED_HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SIMPLIFIED_TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/

function splitSimplifiedTableRow(line: string): string[] {
  const trimmed = line.trim()
  const withoutOuterPipes = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return withoutOuterPipes.split('|').map(cell => cell.trim())
}

function isSimplifiedTableCandidate(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.includes('|') && splitSimplifiedTableRow(trimmed).length >= 2
}

function isSimplifiedTableSeparator(line: string, expectedCellCount: number): boolean {
  if (!isSimplifiedTableCandidate(line)) return false
  const cells = splitSimplifiedTableRow(line)
  if (cells.length !== expectedCellCount) return false
  return cells.every(cell => SIMPLIFIED_TABLE_SEPARATOR_CELL_PATTERN.test(cell.replace(/\s+/g, '')))
}

function renderInlineCode(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={i}
          className={markdownTypography.inlineCode}
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}

function renderSimplifiedHeading(
  key: number,
  level: number,
  content: string,
): React.ReactElement {
  const children = renderInlineCode(content.replace(/[ \t]+#+[ \t]*$/, ''))
  const className = getMarkdownHeadingClass(level)

  switch (level) {
    case 1:
      return <h1 key={key} className={className}>{children}</h1>
    case 2:
      return <h2 key={key} className={className}>{children}</h2>
    case 3:
      return <h3 key={key} className={className}>{children}</h3>
    case 4:
      return <h4 key={key} className={className}>{children}</h4>
    case 5:
      return <h5 key={key} className={className}>{children}</h5>
    default:
      return <h6 key={key} className={className}>{children}</h6>
  }
}

function renderSimplifiedTable(
  key: number,
  headerCells: string[],
  bodyRows: string[][],
): React.ReactElement {
  return (
    <ScrollArea key={key} className="my-4 rounded-lg border border-border/20" scrollBar="horizontal">
      <table className={cn('min-w-full', CHAT_MESSAGE_TEXT_BODY)}>
        <thead className="bg-muted/20">
          <tr>
            {headerCells.map((cell, cellIndex) => (
              <th
                key={cellIndex}
                className={cn('border-b border-border/20 px-3 py-2 text-left font-semibold text-muted-foreground/80', CHAT_MESSAGE_TEXT_BODY)}
              >
                {renderInlineCode(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {headerCells.map((_, cellIndex) => (
                <td key={cellIndex} className="border-b border-border/10 px-3 py-2 text-foreground">
                  {renderInlineCode(row[cellIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  )
}

function renderSimplifiedMarkdown(content: string): React.ReactNode[] {
  const lines = content.split('\n')
  const result: React.ReactNode[] = []
  let inCodeBlock = false
  let codeFenceMarker = ''
  let codeLines: string[] = []
  let codeLang = ''
  let paraLines: string[] = []
  let key = 0

  const flushParagraph = () => {
    if (paraLines.length === 0) return
    const text = paraLines.join('\n')
    if (text.trim()) {
      result.push(
        <p key={key++} className={markdownTypography.paragraph}>
          {renderInlineCode(text)}
        </p>
      )
    }
    paraLines = []
  }

  const flushCodeBlock = () => {
    result.push(
      <div key={key++} className="my-4 overflow-hidden rounded-lg border border-border/20 bg-muted/15">
        {codeLang && (
          <div className="border-b border-border/15 bg-muted/20 px-3 py-1.5">
            <span className="text-caption font-medium uppercase tracking-wider text-muted-foreground/60">
              {codeLang}
            </span>
          </div>
        )}
        <pre className={cn('!m-0 !bg-transparent p-4 overflow-x-auto', CHAT_MARKDOWN_CODE_BLOCK)}>
          <code className="!bg-transparent">{codeLines.join('\n')}</code>
        </pre>
      </div>
    )
    codeFenceMarker = ''
    codeLines = []
    codeLang = ''
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const fenceMatch = line.match(SIMPLIFIED_FENCE_PATTERN)
    if (inCodeBlock) {
      const fenceMarker = fenceMatch?.[1] ?? ''
      const isClosingFence = fenceMarker
        && codeFenceMarker
        && fenceMarker[0] === codeFenceMarker[0]
        && fenceMarker.length >= codeFenceMarker.length
        && (fenceMatch?.[2] ?? '').trim() === ''

      if (isClosingFence) {
        flushCodeBlock()
        inCodeBlock = false
      } else {
        codeLines.push(line)
      }
    } else if (fenceMatch) {
      flushParagraph()
      inCodeBlock = true
      codeFenceMarker = fenceMatch[1]
      codeLang = fenceMatch[2].trim()
    } else if (line.trim() === '') {
      flushParagraph()
    } else if (SIMPLIFIED_HEADING_PATTERN.test(line)) {
      const headingMatch = line.match(SIMPLIFIED_HEADING_PATTERN)
      if (headingMatch) {
        flushParagraph()
        result.push(renderSimplifiedHeading(key++, headingMatch[1].length, headingMatch[2] ?? ''))
      }
    } else if (
      isSimplifiedTableCandidate(line)
      && lineIndex + 1 < lines.length
      && isSimplifiedTableSeparator(
        lines[lineIndex + 1],
        splitSimplifiedTableRow(line).length,
      )
    ) {
      flushParagraph()
      const headerCells = splitSimplifiedTableRow(line)
      const bodyRows: string[][] = []
      lineIndex += 2
      while (lineIndex < lines.length && lines[lineIndex].trim() !== '') {
        if (!isSimplifiedTableCandidate(lines[lineIndex])) {
          lineIndex--
          break
        }
        bodyRows.push(splitSimplifiedTableRow(lines[lineIndex]))
        lineIndex++
      }
      result.push(renderSimplifiedTable(key++, headerCells, bodyRows))
    } else {
      paraLines.push(line)
    }
  }

  if (inCodeBlock && codeLines.length > 0) {
    flushCodeBlock()
  }
  flushParagraph()

  return result
}

const SimplifiedContent: React.FC<{ content: string }> = React.memo(({ content }) => {
  const elements = useMemo(() => renderSimplifiedMarkdown(content), [content])
  return <>{elements}</>
})
SimplifiedContent.displayName = 'SimplifiedContent'

/* ---------- FrozenStableBlock: ReactMarkdown 冻住的稳定区 ---------- */

const FrozenStableBlock: React.FC<{
  content: string
  tabScopeKey?: string | null
  resourceSpaceId?: string | null
  linksEnabled?: boolean
}> = React.memo(
  ({ content, tabScopeKey = null, resourceSpaceId = null, linksEnabled = true }) => {
    if (!content) return null
    return (
      <MarkdownLinksEnabledContext.Provider value={linksEnabled}>
        <MarkdownResourceSpaceContext.Provider value={resourceSpaceId}>
          <MarkdownTabScopeContext.Provider value={tabScopeKey}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkAutolinkResource]}
              urlTransform={permissiveUrlTransform}
              components={mdComponents}
            >
              {content}
            </ReactMarkdown>
          </MarkdownTabScopeContext.Provider>
        </MarkdownResourceSpaceContext.Provider>
      </MarkdownLinksEnabledContext.Provider>
    )
  },
  (prev, next) => (
    prev.content === next.content
    && prev.tabScopeKey === next.tabScopeKey
    && prev.resourceSpaceId === next.resourceSpaceId
    && prev.linksEnabled === next.linksEnabled
  ),
)
FrozenStableBlock.displayName = 'FrozenStableBlock'

/* ---------- StreamingTail: 轻量渲染尾部未完成块 ---------- */

const StreamingTail: React.FC<{ content: string }> = React.memo(({ content }) => {
  const elements = useMemo(() => renderSimplifiedMarkdown(content), [content])
  return <>{elements}</>
})
StreamingTail.displayName = 'StreamingTail'

/* ---------- MarkdownRenderer 主组件 ---------- */

interface MarkdownRendererProps {
  content: string
  className?: string
  tabScopeKey?: string | null
  /** Markdown 资源链接所属的明确 Space；非对话宿主不要回退到全局 selectedSpace。 */
  resourceSpaceId?: string | null
  /** 卡片等外层已可点击的区域可关闭链接交互，仍保留统一 Markdown 排版。 */
  linksEnabled?: boolean
  /** Skip syntax highlighting for historical messages (perf optimisation) */
  lightweight?: boolean
  /** Rendering level: 1=full, 2=no highlight, 3=simplified (no remark/rehype) */
  renderLevel?: 1 | 2 | 3
  /** Whether this message is currently streaming — enables incremental rendering + cursor */
  isStreaming?: boolean
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({
    content,
    className,
    tabScopeKey = null,
    resourceSpaceId = null,
    linksEnabled = true,
    lightweight = false,
    renderLevel = 1,
    isStreaming = false,
  }) => {
    const rehypeHighlight = useRehypeHighlight()
    const safeContent = useMemo(() => normalizeMarkdownContent(content), [content])

    // Level 3→1 仅保留短时 opacity 过渡视觉；滚动校正交给 ConversationViewportController
    // 的 content ResizeObserver / layout-changed，内容层禁止写祖先 scrollTop。
    const [transitioning, setTransitioning] = useState(false)
    const prevLevelRef = useRef(renderLevel)
    useLayoutEffect(() => {
      if (prevLevelRef.current === 3 && renderLevel === 1) {
        setTransitioning(true)
      }
      prevLevelRef.current = renderLevel
    }, [renderLevel])
    useEffect(() => {
      if (transitioning) {
        const raf = requestAnimationFrame(() => setTransitioning(false))
        return () => cancelAnimationFrame(raf)
      }
    }, [transitioning])

    const { stable, tail } = useMemo(
      () => isStreaming ? splitStreamingMarkdown(safeContent) : { stable: '', tail: '' },
      [safeContent, isStreaming],
    )

    const enableHighlight = useMemo(
      () => renderLevel < 2 && !lightweight && shouldEnableHighlight(safeContent),
      [safeContent, lightweight, renderLevel],
    )
    const remarkPlugins = useMemo(() => [remarkGfm, remarkAutolinkResource], [])
    const rehypePlugins = useMemo(
      () => {
        const plugins: MarkdownRehypePlugins = []
        plugins.push(rehypePruneInvalidChildren)
        if (rehypeHighlight && enableHighlight) {
          plugins.push(wrapSafeRehypeHighlight(rehypeHighlight))
          plugins.push(rehypePruneInvalidChildren)
        }
        plugins.push([rehypeSanitize, sanitizeSchema])
        plugins.push(rehypeSanitizeCss)
        return plugins
      },
      [rehypeHighlight, enableHighlight]
    )
    const fallbackContent = useMemo(
      () => (
        <pre className={cn('my-2.5 whitespace-pre-wrap break-words font-sans', CHAT_MESSAGE_TEXT_BODY)}>
          {safeContent}
        </pre>
      ),
      [safeContent]
    )
    const handleRenderError = useCallback(
      (error: unknown) => {
        console.error('[MarkdownRenderer] ReactMarkdown render failed, fallback to plain text', {
          error,
          rawLength: content.length,
          safeLength: safeContent.length,
          strippedChars: Math.max(content.length - safeContent.length, 0),
          preview: safeContent.slice(0, 200),
        })
      },
      [content, safeContent]
    )

    if (isStreaming && safeContent) {
      return (
        <div className={cn(
          'markdown-body is-streaming min-w-0 max-w-full break-words [overflow-wrap:anywhere]',
          CHAT_MESSAGE_TEXT_BODY,
          className,
        )}>
          {stable && (
            <FrozenStableBlock
              content={stable}
              tabScopeKey={tabScopeKey}
              resourceSpaceId={resourceSpaceId}
              linksEnabled={linksEnabled}
            />
          )}
          <StreamingTail content={tail} />
        </div>
      )
    }

    return (
      <div className={cn(
        'markdown-body min-w-0 max-w-full break-words [overflow-wrap:anywhere]',
        CHAT_MESSAGE_TEXT_BODY,
        'transition-opacity duration-150',
        transitioning ? 'opacity-0' : 'opacity-100',
        className,
      )}>
        {renderLevel === 3 ? (
          <SimplifiedContent content={safeContent} />
        ) : (
          <MarkdownErrorBoundary
            resetKey={safeContent}
            fallback={fallbackContent}
            onError={handleRenderError}
          >
            <MarkdownLinksEnabledContext.Provider value={linksEnabled}>
              <MarkdownResourceSpaceContext.Provider value={resourceSpaceId}>
                <MarkdownTabScopeContext.Provider value={tabScopeKey}>
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    urlTransform={permissiveUrlTransform}
                    components={mdComponents}
                  >
                    {safeContent}
                  </ReactMarkdown>
                </MarkdownTabScopeContext.Provider>
              </MarkdownResourceSpaceContext.Provider>
            </MarkdownLinksEnabledContext.Provider>
          </MarkdownErrorBoundary>
        )}
      </div>
    )
  }
)

MarkdownRenderer.displayName = 'MarkdownRenderer'
