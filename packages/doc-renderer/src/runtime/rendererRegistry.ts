import type { MarkdownRendererAdapter } from '../types'

let rendererAdapter: MarkdownRendererAdapter | null = null

export const configureMarkdownRenderer = (adapter: MarkdownRendererAdapter): void => {
  rendererAdapter = adapter
}

export const getMarkdownRenderer = (): MarkdownRendererAdapter | null => rendererAdapter

export const resetMarkdownRenderer = (): void => {
  rendererAdapter = null
}

