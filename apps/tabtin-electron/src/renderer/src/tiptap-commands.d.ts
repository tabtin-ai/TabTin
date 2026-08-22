/**
 * Module augmentation for TipTap extension commands.
 *
 * pnpm strict isolation prevents transitive type declarations from
 * @tiptap/extension-* packages (via novel) from being visible to TS.
 * This file replicates the Commands interface augmentations that each
 * extension would normally contribute, using the same nested structure.
 */

import '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    bold: {
      setBold: () => ReturnType
      toggleBold: () => ReturnType
      unsetBold: () => ReturnType
    }
    italic: {
      setItalic: () => ReturnType
      toggleItalic: () => ReturnType
      unsetItalic: () => ReturnType
    }
    strike: {
      setStrike: () => ReturnType
      toggleStrike: () => ReturnType
      unsetStrike: () => ReturnType
    }
    code: {
      setCode: () => ReturnType
      toggleCode: () => ReturnType
      unsetCode: () => ReturnType
    }
    underline: {
      setUnderline: () => ReturnType
      toggleUnderline: () => ReturnType
      unsetUnderline: () => ReturnType
    }
    heading: {
      setHeading: (attributes: { level: 1 | 2 | 3 | 4 | 5 | 6 }) => ReturnType
      toggleHeading: (attributes: { level: 1 | 2 | 3 | 4 | 5 | 6 }) => ReturnType
    }
    bulletList: {
      toggleBulletList: () => ReturnType
    }
    orderedList: {
      toggleOrderedList: () => ReturnType
    }
    blockquote: {
      setBlockquote: () => ReturnType
      toggleBlockquote: () => ReturnType
      unsetBlockquote: () => ReturnType
    }
    codeBlock: {
      setCodeBlock: (attributes?: { language?: string }) => ReturnType
      toggleCodeBlock: (attributes?: { language?: string }) => ReturnType
    }
    taskList: {
      toggleTaskList: () => ReturnType
    }
    highlight: {
      setHighlight: (attributes?: { color?: string }) => ReturnType
      toggleHighlight: (attributes?: { color?: string }) => ReturnType
      unsetHighlight: () => ReturnType
    }
    color: {
      setColor: (color: string) => ReturnType
      unsetColor: () => ReturnType
    }
    link: {
      setLink: (attributes: { href: string; target?: string | null }) => ReturnType
      toggleLink: (attributes: { href: string; target?: string | null }) => ReturnType
      unsetLink: () => ReturnType
    }
    horizontalRule: {
      setHorizontalRule: () => ReturnType
    }
    youtube: {
      setYoutubeVideo: (options: { src: string; width?: number; height?: number }) => ReturnType
    }
    tabDataBlock: {
      insertTabDataBlock: (attributes: {
        tableId: string
        viewId?: string | null
        title?: string
      }) => ReturnType
    }
  }
}
