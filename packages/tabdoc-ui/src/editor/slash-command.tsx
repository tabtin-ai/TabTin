import {
  CheckSquare,
  Code,
  Code2,
  Database,
  Grid3X3,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  List,
  ListOrdered,
  Minus,
  SigmaIcon,
  Table2,
  Text,
  TextQuote,
} from 'lucide-react'
import type { EditorView } from '@tiptap/pm/view'
import type { Editor, Range } from '@tiptap/core'
import { Command, createSuggestionItems, renderItems } from 'novel'
import { OVERLAY_SURFACE_CLASS } from '@tabtin/smartsheet-ui'
import { TABDOC_FLOATING_MENU_SURFACE_CLASS } from './floating-menu-surface'
import {
  createSlashRemoteOriginGate,
  shouldAllowSlashSuggestion,
} from './slash-command-origin'
import { HTML_UPLOAD_ACCEPT } from './html-upload'
import { ensureParagraphAfterCurrentTable } from './table-exit'

export { shouldAllowSlashSuggestion } from './slash-command-origin'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

type ImageUploadFn = (file: File, view: EditorView, pos: number) => void

export const TABDOC_SLASH_COMMAND_MENU_CLASS = [
  TABDOC_FLOATING_MENU_SURFACE_CLASS,
  'z-dropdown h-auto max-h-[330px] overflow-y-auto rounded-md px-1 py-2 transition-all',
  OVERLAY_SURFACE_CLASS,
].join(' ')

/** HTML 文件上传入口：由宿主注入，拿到 File 后异步上传并在 pos 处插入 htmlBlock。 */
type HtmlUploadFn = (file: File, view: EditorView, pos: number) => void

export interface SlashCommandActions {
  onRequestMathFormula?: () => void
  onRequestCreateDatabase?: () => void
  onRequestSelectTable?: () => void
}

/** slash 菜单项的稳定标识（与 `slash.<key>` i18n key 对齐）。 */
export type SlashItemKey =
  | 'text'
  | 'todo'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'quote'
  | 'code'
  | 'table'
  | 'horizontalRule'
  | 'image'
  | 'html'
  | 'math'
  | 'database'
  | 'embedTable'

export interface SlashCommandOptions {
  /**
   * 需要排除的菜单项（按稳定 key）。用于宿主能力受限的场景，
   * 如公开分享 edit 页不支持 database / embedTable（需宿主 runtime）、
   * 无上传通道时不显示 image。
   */
  exclude?: SlashItemKey[]
  /**
   * 覆盖默认 Tippy/React 菜单渲染（主要用于单测捕获 onStart/onExit，
   * 生产路径不传，沿用 novel `renderItems`）。
   */
  render?: typeof renderItems
}

function runSlashAction(
  action: (() => void) | undefined,
  actionName: 'math' | 'createDatabase' | 'selectTable',
) {
  if (action) {
    action()
    return
  }

  console.warn(`[tabdoc] slash action "${actionName}" is unavailable in the current host`)
}

export function getSuggestionItems(
  t: TranslateFn,
  imageUploadFn?: ImageUploadFn,
  actions?: SlashCommandActions,
  options?: SlashCommandOptions,
  htmlUploadFn?: HtmlUploadFn,
) {
  const activeUploadFn = imageUploadFn
  const activeHtmlUploadFn = htmlUploadFn
  const items = createSuggestionItems([
    {
      title: t('slash.text', { defaultValue: 'Text' }),
      description: t('slash.textDesc', { defaultValue: 'Just start typing with plain text.' }),
      searchTerms: ['p', 'paragraph', '文本', '段落'],
      icon: <Text size={18} />,
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .toggleNode('paragraph', 'paragraph')
          .run()
      },
    },
    {
      title: t('slash.todo', { defaultValue: 'To-do List' }),
      description: t('slash.todoDesc', { defaultValue: 'Track tasks with a to-do list.' }),
      searchTerms: ['todo', 'task', 'list', 'check', 'checkbox', '待办', '任务'],
      icon: <CheckSquare size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run()
      },
    },
    {
      title: t('slash.heading1', { defaultValue: 'Heading 1' }),
      description: t('slash.heading1Desc', { defaultValue: 'Big section heading.' }),
      searchTerms: ['title', 'big', 'large', '标题', '大标题'],
      icon: <Heading1 size={18} />,
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 1 })
          .run()
      },
    },
    {
      title: t('slash.heading2', { defaultValue: 'Heading 2' }),
      description: t('slash.heading2Desc', { defaultValue: 'Medium section heading.' }),
      searchTerms: ['subtitle', 'medium', '二级标题'],
      icon: <Heading2 size={18} />,
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 2 })
          .run()
      },
    },
    {
      title: t('slash.heading3', { defaultValue: 'Heading 3' }),
      description: t('slash.heading3Desc', { defaultValue: 'Small section heading.' }),
      searchTerms: ['subtitle', 'small', '三级标题'],
      icon: <Heading3 size={18} />,
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode('heading', { level: 3 })
          .run()
      },
    },
    {
      title: t('slash.bulletList', { defaultValue: 'Bullet List' }),
      description: t('slash.bulletListDesc', { defaultValue: 'Create a simple bullet list.' }),
      searchTerms: ['unordered', 'point', '无序列表', '列表'],
      icon: <List size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run()
      },
    },
    {
      title: t('slash.numberedList', { defaultValue: 'Numbered List' }),
      description: t('slash.numberedListDesc', { defaultValue: 'Create a list with numbering.' }),
      searchTerms: ['ordered', '有序列表', '编号'],
      icon: <ListOrdered size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run()
      },
    },
    {
      title: t('slash.quote', { defaultValue: 'Quote' }),
      description: t('slash.quoteDesc', { defaultValue: 'Capture a quote.' }),
      searchTerms: ['blockquote', '引用'],
      icon: <TextQuote size={18} />,
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .toggleNode('paragraph', 'paragraph')
          .toggleBlockquote()
          .run(),
    },
    {
      title: t('slash.code', { defaultValue: 'Code' }),
      description: t('slash.codeDesc', { defaultValue: 'Capture a code snippet.' }),
      searchTerms: ['codeblock', '代码'],
      icon: <Code size={18} />,
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: t('slash.table', { defaultValue: 'Table' }),
      description: t('slash.tableDesc', { defaultValue: 'Insert a table.' }),
      searchTerms: ['table', 'grid', '表格'],
      icon: <Grid3X3 size={18} />,
      command: ({ editor, range }) => {
        const inserted = editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run()
        // 表为末节点时保证表后有空段，避免卡在表格里
        if (inserted) ensureParagraphAfterCurrentTable(editor)
      },
    },
    {
      title: t('slash.horizontalRule', { defaultValue: 'Horizontal Rule' }),
      description: t('slash.horizontalRuleDesc', { defaultValue: 'Insert a horizontal divider.' }),
      searchTerms: ['hr', 'divider', 'separator', '分割线', '分隔线'],
      icon: <Minus size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run()
      },
    },
    {
      title: t('slash.image', { defaultValue: 'Image' }),
      description: t('slash.imageDesc', { defaultValue: 'Upload an image from your device.' }),
      searchTerms: ['image', 'photo', 'picture', 'upload', '图片', '图像'],
      icon: <ImageIcon size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = () => {
          const file = input.files?.[0]
          if (file) {
            const pos = editor.view.state.selection.from
            activeUploadFn?.(file, editor.view, pos)
          }
        }
        input.click()
      },
    },
    // HTML 嵌入块：仅当宿主注入了上传能力时才提供（无上传通道的公开分享 / standalone 不显示）。
    ...(activeHtmlUploadFn
      ? [
          {
            title: t('slash.html', { defaultValue: 'HTML' }),
            description: t('slash.htmlDesc', {
              defaultValue: 'Upload an HTML file to embed and run inline.',
            }),
            searchTerms: ['html', 'htm', 'embed', 'code', '嵌入', '网页', '交互', '原型'],
            icon: <Code2 size={18} />,
            command: ({ editor, range }: { editor: Editor; range: Range }) => {
              editor.chain().focus().deleteRange(range).run()
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = HTML_UPLOAD_ACCEPT
              input.onchange = () => {
                const file = input.files?.[0]
                if (file) {
                  const pos = editor.view.state.selection.from
                  activeHtmlUploadFn(file, editor.view, pos)
                }
              }
              input.click()
            },
          },
        ]
      : []),
    {
      title: t('slash.math', { defaultValue: 'Math Formula' }),
      description: t('slash.mathDesc', { defaultValue: 'Insert a LaTeX math formula.' }),
      searchTerms: ['math', 'formula', 'latex', 'katex', 'equation', '公式', '数学', 'gs', 'eq'],
      icon: <SigmaIcon size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        runSlashAction(actions?.onRequestMathFormula, 'math')
      },
    },
    {
      title: t('slash.database', { defaultValue: 'Database' }),
      description: t('slash.databaseDesc', { defaultValue: 'Create and embed an inline database.' }),
      searchTerms: ['database', 'tabdata', 'spreadsheet', 'grid', '多维表格', '数据库', '表格视图'],
      icon: <Database size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        runSlashAction(actions?.onRequestCreateDatabase, 'createDatabase')
      },
    },
    {
      title: t('slash.embedTable', { defaultValue: 'Embed Table' }),
      description: t('slash.embedTableDesc', { defaultValue: 'Embed an existing table.' }),
      searchTerms: ['embed', 'tabdata', 'link', 'reference', '嵌入表格', '引用表格', '关联表格'],
      icon: <Table2 size={18} />,
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        runSlashAction(actions?.onRequestSelectTable, 'selectTable')
      },
    },
  ])

  if (!options?.exclude?.length) return items
  // 标题即 t(`slash.<key>`)，按标题集合过滤掉受限项（zh-CN / en-US 均已定义这些 key）。
  const excludeTitles = new Set(options.exclude.map((key) => t(`slash.${key}`)))
  return items.filter((item) => !excludeTitles.has(item.title))
}

/**
 * 创建带自定义图片上传函数的 slash command 扩展。
 * 用于传入 createUploadFn(docId) 以关联文档 FileUsage。
 *
 * 协作模式下会屏蔽 Yjs 远端同步触发的菜单新开，
 * 文档正文仍正常同步 `/` 字符。
 *
 * @param t 翻译函数，由宿主注入
 */
export function createSlashCommand(
  t: TranslateFn,
  imageUploadFn?: ImageUploadFn,
  actions?: SlashCommandActions,
  options?: SlashCommandOptions,
  htmlUploadFn?: HtmlUploadFn,
) {
  const { gate, plugin: remoteOriginPlugin } = createSlashRemoteOriginGate()

  return Command.extend({
    addProseMirrorPlugins() {
      const parentPlugins = this.parent?.() ?? []
      // origin gate 必须先于 suggestion.apply，供 allow 读取本轮 isChangeOrigin
      return [remoteOriginPlugin, ...parentPlugins]
    },
  }).configure({
    suggestion: {
      items: () => getSuggestionItems(t, imageUploadFn, actions, options, htmlUploadFn),
      render: options?.render ?? renderItems,
      allow: ({ isActive }: { isActive?: boolean }) =>
        shouldAllowSlashSuggestion({
          isRemoteOrigin: gate.isRemoteOrigin,
          isActive,
        }),
    },
  })
}
