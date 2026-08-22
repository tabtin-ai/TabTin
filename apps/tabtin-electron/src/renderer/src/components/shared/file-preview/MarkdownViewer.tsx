/**
 * MarkdownViewer - 文件预览面板的 Markdown 渲染组件
 *
 * GFM（remark-gfm）+ 代码高亮 + raw HTML（rehype-raw），再经
 * rehype-sanitize / rehypeSanitizeCss 收口，对齐 GitHub 可渲染 HTML 的口径。
 */

import React, { useMemo, useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { sanitizeSchema, rehypeSanitizeCss } from '@/lib/rehypeSanitizeSchema'
import { handleResourceLinkClick } from '@/services/openResourceLink'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { Components } from 'react-markdown'

interface MarkdownViewerProps {
  content: string
  filePath?: string
  className?: string
}

type RehypeAttacher = (...args: unknown[]) => ((tree: unknown, file: unknown) => void) | void
type MarkdownRehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>

/* ---------- rehype-highlight 延迟加载 ---------- */

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

function wrapSafeRehypeHighlight(attacher: RehypeAttacher): () => (tree: unknown, file: unknown) => void {
  return () => {
    let transformer: ((tree: unknown, file: unknown) => void) | undefined
    try {
      transformer = attacher() as ((tree: unknown, file: unknown) => void) | undefined
    } catch {
      return () => {}
    }
    return (tree: unknown, file: unknown) => {
      try {
        return transformer?.(tree, file)
      } catch {
        // highlight failed — code blocks still render without coloring
      }
    }
  }
}

/* ---------- 自定义渲染组件（文件预览场景） ---------- */

const viewerComponents: Components = {
  pre({ children }) {
    return <>{children}</>
  },
  code({ className, children, ...rest }) {
    const isBlock = /language-/.test(className || '') || String(children).includes('\n')
    if (!isBlock) {
      return (
        <code
          className="rounded-md border border-border/20 bg-muted/40 px-1.5 py-0.5 text-body font-mono text-foreground"
          {...rest}
        >
          {children}
        </code>
      )
    }

    const lang = (className || '').replace(/language-/, '') || ''

    return (
      <div className="group/code relative my-4 overflow-hidden rounded-lg border border-border/20 bg-muted/15">
        {lang && (
          <div className="flex items-center border-b border-border/15 bg-muted/20 px-3 py-1.5">
            <span className="text-caption font-medium uppercase tracking-wider text-muted-foreground/60">
              {lang}
            </span>
          </div>
        )}
        <ScrollArea scrollBar="horizontal">
          <pre className="!m-0 !bg-transparent p-4 text-body leading-relaxed">
            <code className={cn(className, '!bg-transparent')} {...rest}>
              {children}
            </code>
          </pre>
        </ScrollArea>
      </div>
    )
  },

  table({ children }) {
    return (
      <ScrollArea className="my-4 rounded-lg border border-border/20" scrollBar="horizontal">
        <table className="min-w-full text-body">{children}</table>
      </ScrollArea>
    )
  },
  thead({ children }) {
    return <thead className="bg-muted/20">{children}</thead>
  },
  th({ children }) {
    return (
      <th className="border-b border-border/20 px-3 py-2 text-left text-body font-semibold text-muted-foreground/80">
        {children}
      </th>
    )
  },
  td({ children }) {
    return (
      <td className="border-b border-border/10 px-3 py-2 text-foreground">{children}</td>
    )
  },

  a({ href, children }) {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      // 相对路径 / 锚点不派发；http(s)/mailto 走 ResourceRouter（内置 TabWeb，⌘/Ctrl 仍外开）
      if (href && /^https?:|^mailto:/i.test(href)) {
        handleResourceLinkClick(e, href)
      }
    }
    return (
      <a
        href={href}
        onClick={handleClick}
        className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent transition-colors cursor-pointer"
      >
        {children}
      </a>
    )
  },

  blockquote({ children }) {
    return (
      <blockquote className="my-3 border-l-2 border-border/40 pl-4 text-muted-foreground/80 italic">
        {children}
      </blockquote>
    )
  },

  ul({ children }) {
    return <ul className="my-2 ml-6 list-disc space-y-1.5">{children}</ul>
  },
  ol({ children }) {
    return <ol className="my-2 ml-6 list-decimal space-y-1.5">{children}</ol>
  },
  li({ children }) {
    return <li className="text-foreground leading-[1.7] [&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">{children}</li>
  },

  h1({ children }) {
    return <h1 className="mt-6 mb-3 text-title font-semibold text-foreground tracking-tight">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="mt-5 mb-2 text-title font-semibold text-foreground tracking-tight">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="mt-4 mb-1.5 text-subtitle font-semibold text-foreground">{children}</h3>
  },
  h4({ children }) {
    return <h4 className="mt-3 mb-1 text-body font-semibold text-foreground">{children}</h4>
  },

  p({ children }) {
    return <p className="my-2.5 leading-[1.7]">{children}</p>
  },

  hr() {
    return <hr className="my-6 border-border/25" />
  },

  strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>
  },
  em({ children }) {
    return <em className="italic">{children}</em>
  },
  del({ children }) {
    return <del className="line-through text-muted-foreground/60">{children}</del>
  },

}

const resolveImageSrc = (src: string | undefined, dirPath: string | undefined): string | undefined => {
  if (!src) return src
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  if (!dirPath) return src
  const segments = `${dirPath}/${src}`.split('/').filter(Boolean)
  const normalized: string[] = []
  for (const seg of segments) {
    if (seg === '.') continue
    if (seg === '..') { normalized.pop(); continue }
    normalized.push(seg)
  }
  const fullPath = '/' + normalized.join('/')
  const encoded = fullPath
    .split('/')
    .map(seg => (seg ? encodeURIComponent(seg) : ''))
    .join('/')
  return `tabtin-file://${encoded}`
}

/* ---------- MarkdownViewer 主组件 ---------- */

export const MarkdownViewer: React.FC<MarkdownViewerProps> = React.memo(
  ({ content, filePath, className }) => {
    const rehypeHighlight = useRehypeHighlight()

    const dirPath = useMemo(
      () => (filePath ? filePath.replace(/[\\/][^\\/]*$/, '') : undefined),
      [filePath]
    )

    const components = useMemo<Components>(
      () => ({
        ...viewerComponents,
        img({ src, alt }) {
          const resolvedSrc = resolveImageSrc(src, dirPath)
          return (
            <img
              src={resolvedSrc}
              alt={alt || ''}
              className="my-2 max-w-full rounded-lg border border-border/30"
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )
        },
      }),
      [dirPath]
    )

    const remarkPlugins = useMemo(() => [remarkGfm], [])
    const rehypePlugins = useMemo(
      () => {
        // 顺序：raw HTML → sanitize（含 CSS）→ highlight，先收口再着色。
        const plugins: MarkdownRehypePlugins = [
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeSanitizeCss,
        ]
        if (rehypeHighlight) {
          plugins.push(wrapSafeRehypeHighlight(rehypeHighlight))
        }
        return plugins
      },
      [rehypeHighlight]
    )

    const [renderError, setRenderError] = useState(false)
    const handleError = useCallback(() => setRenderError(true), [])

    // 内容变化时重置错误状态
    useEffect(() => {
      setRenderError(false)
    }, [content])

    if (renderError) {
      return (
        <ScrollArea className={cn('h-full', className)}>
          <pre className="whitespace-pre-wrap break-words p-4 font-sans text-body leading-[1.7] text-foreground">
            {content}
          </pre>
        </ScrollArea>
      )
    }

    return (
      <ScrollArea className={cn('h-full', className)}>
        <div className="markdown-body p-4 text-body leading-[1.7] text-foreground">
          <MarkdownErrorBoundary
            resetKey={content}
            onError={handleError}
          >
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
            >
              {content}
            </ReactMarkdown>
          </MarkdownErrorBoundary>
        </div>
      </ScrollArea>
    )
  }
)

MarkdownViewer.displayName = 'MarkdownViewer'

/* ---------- 错误边界 ---------- */

interface MarkdownErrorBoundaryProps {
  children: React.ReactNode
  resetKey: string
  onError?: () => void
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

  componentDidCatch(): void {
    this.props.onError?.()
  }

  componentDidUpdate(prevProps: MarkdownErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) return null
    return this.props.children
  }
}
