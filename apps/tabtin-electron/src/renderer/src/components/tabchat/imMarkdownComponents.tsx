import React from 'react'
import type { Components } from 'react-markdown'
import { cn } from '@utils/cn'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
} from '@/services/openResourceLink'
import { normalizeSchemelessWebHref } from '@shared/normalize-web-href'
import { isMentionHref } from './mentionMarkdown'
import { IM_MENTION_CHIP_CLASS, IM_MESSAGE_MARKDOWN_TEXT } from './tabchatUi'

export interface ImMarkdownResourceLinkContext {
  tabScopeKey?: string | null
  executionSpaceId?: string | null
}

function createResourceLinkComponent(
  context?: ImMarkdownResourceLinkContext,
): NonNullable<Components['a']> {
  return ({ href, children }) => {
    if (isMentionHref(href)) {
      return (
        <span
          className={IM_MENTION_CHIP_CLASS}
          data-mention-href={href}
        >
          {children}
        </span>
      )
    }
    const normalizedHref = href ? normalizeSchemelessWebHref(href) : href
    return (
      <a
        href={normalizedHref}
        onClick={(e) => handleResourceLinkClick(
          e,
          normalizedHref ?? '',
          context?.tabScopeKey,
          context?.executionSpaceId,
        )}
        onContextMenu={(e) => handleResourceLinkContextMenu(
          e,
          normalizedHref ?? '',
          context?.tabScopeKey,
          context?.executionSpaceId,
        )}
        className="text-info underline underline-offset-2 break-all"
      >
        {children}
      </a>
    )
  }
}

export const markdownComponents: Components = {
  p: ({ children }) => <p className="my-0 whitespace-pre-wrap">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1.5 border-b border-border/30 pb-1 text-subtitle font-bold leading-snug first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className={cn('mt-2 mb-1 border-l-2 border-border/50 pl-2 font-bold leading-snug first:mt-0', IM_MESSAGE_MARKDOWN_TEXT)}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className={cn('mt-1.5 mb-0.5 border-l border-border/40 pl-2 font-semibold leading-snug first:mt-0', IM_MESSAGE_MARKDOWN_TEXT)}>
      {children}
    </h3>
  ),
  h4: ({ children }) => <h4 className={cn('mt-1.5 mb-0.5 font-medium first:mt-0', IM_MESSAGE_MARKDOWN_TEXT)}>{children}</h4>,
  h5: ({ children }) => <h5 className={cn('mt-1 mb-0.5 font-medium first:mt-0', IM_MESSAGE_MARKDOWN_TEXT)}>{children}</h5>,
  h6: ({ children }) => <h6 className="text-caption font-medium text-muted-foreground mt-1 mb-0.5 first:mt-0">{children}</h6>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: createResourceLinkComponent(),
  code: ({ className, children, ...rest }) => {
    const isBlock = typeof className === 'string' && className.startsWith('language-')
    if (!isBlock) {
      return (
        <code className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-caption font-mono" {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-1.5 p-2.5 rounded-lg bg-black/10 dark:bg-white/10 overflow-x-auto text-caption font-mono leading-relaxed">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 pl-3 border-l-2 border-accent/60 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="min-w-full text-caption border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold border-b border-border/40">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 border-b border-border/20">{children}</td>
  ),
  hr: () => <hr className="my-2 border-border/30" />,
}

export function createImMarkdownComponents(
  context: ImMarkdownResourceLinkContext,
): Components {
  return {
    ...markdownComponents,
    a: createResourceLinkComponent(context),
  }
}
