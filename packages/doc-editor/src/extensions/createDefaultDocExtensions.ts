import type { AnyExtension } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'


export interface DocEditorSchemaProfile {
  heading: boolean
  paragraph: boolean
  bulletList: boolean
  orderedList: boolean
  blockquote: boolean
  codeBlock: boolean
  table: boolean
  taskList: boolean
  link: boolean
}

export interface CreateDefaultDocExtensionsInput {
  profile?: Partial<DocEditorSchemaProfile>
  enableLinkAutolink?: boolean
  enableLinkOpenOnClick?: boolean
  /** Disable the tiptap-markdown extension (e.g. when the host provides its own). Default false. */
  disableMarkdown?: boolean
  /** Disable the built-in History extension from StarterKit (e.g. when the host manages its own undo/redo). Default false. */
  disableHistory?: boolean
}

const DOC_EDITOR_DEFAULT_PROFILE: DocEditorSchemaProfile = {
  heading: true,
  paragraph: true,
  bulletList: true,
  orderedList: true,
  blockquote: true,
  codeBlock: true,
  table: true,
  taskList: true,
  link: true,
}

export const createDocEditorSchemaProfile = (
  overrides: Partial<DocEditorSchemaProfile> = {}
): DocEditorSchemaProfile => ({
  ...DOC_EDITOR_DEFAULT_PROFILE,
  ...overrides,
})

export const createDefaultDocExtensions = (
  input: CreateDefaultDocExtensionsInput = {}
): AnyExtension[] => {
  const profile = createDocEditorSchemaProfile(input.profile)

  const starterKit = StarterKit.configure({
    heading: profile.heading ? undefined : false,
    paragraph: profile.paragraph ? undefined : false,
    bulletList: profile.bulletList ? undefined : false,
    orderedList: profile.orderedList ? undefined : false,
    blockquote: profile.blockquote ? undefined : false,
    codeBlock: profile.codeBlock ? undefined : false,
    history: input.disableHistory ? false : undefined,
  })

  const extensions: AnyExtension[] = [starterKit as unknown as AnyExtension]

  // Underline mark (not in StarterKit)
  extensions.push(Underline)

  // tiptap-markdown: automatic Markdown ↔ ProseMirror conversion
  // Use editor.storage.markdown.getMarkdown() for serialization
  // Pass markdown strings directly to editor.commands.setContent() for deserialization
  if (!input.disableMarkdown) {
    extensions.push(
      Markdown.configure({
        html: true,
        tightLists: true,
        tightListClass: 'tight',
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      })
    )
  }

  if (profile.taskList) {
    extensions.push(
      TaskList.configure({
        HTMLAttributes: { class: 'task-list' },
      }),
      TaskItem.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            todoId: {
              default: null,
              parseHTML: (element: HTMLElement) => element.getAttribute('data-todo-id'),
              renderHTML: (attributes: Record<string, unknown>) => {
                if (!attributes.todoId) return {}
                return { 'data-todo-id': attributes.todoId }
              },
            },
          }
        },
      }).configure({
        nested: true,
      })
    )
  }

  if (profile.table) {
    extensions.push(
      Table.configure({
        resizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell
    )
  }

  if (profile.link) {
    extensions.push(
      Link.configure({
        autolink: input.enableLinkAutolink ?? true,
        openOnClick: input.enableLinkOpenOnClick ?? false,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      })
    )
  }

  return extensions
}

export { DOC_EDITOR_DEFAULT_PROFILE }
