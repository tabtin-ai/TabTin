/**
 * 前端本地文件「预览能力」registry —— 展示端的唯一可配置/注册入口。
 *
 * 一处定义一种类型的全部预览信息：扩展名、卡片图标/副标题、以及**用什么组件
 * 渲染**（renderPreview 直接返回对应 viewer）。新增一种可预览类型 = 在
 * `localFilePreviewFormats` 注册一项，TabFilesPaneRenderer / localFileResourceResolver
 * 自动生效，不需要再去别处加 kind→组件 的映射。
 *
 * 与后端生成端（agent-runtime ArtifactFormatRegistry）相互独立：后端决定能生成
 * 哪些类型，这里决定能预览哪些类型。
 */

import React, { lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import {
  AlertCircle,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Film,
  Image as ImageIcon,
  Music,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { ImagePreview } from '@components/shared/image-preview/ImagePreview'
import {
  buildTabtinFileUrl,
  LOCAL_TEXT_PREVIEW_BYTES,
  MAX_OFFICE_FILE_BYTES,
} from '@components/shared/file-utils'
import { OSS_PRESIGNED_DOWNLOAD_MAX_BYTES } from '@shared/oss-presigned-upload-ipc'
import { TEXT_PREVIEW_FILENAMES } from '@shared/text-preview-contract'
import { TextFileEditor } from './TextFileEditor'
import type { FilePreviewData } from './types'

/**
 * 惰性创建并缓存 lazy viewer：lazy() 不在模块加载时执行，而是在对应
 * renderPreview 首次被调用（实际要渲染该类型）时才创建；缓存保证返回的 lazy
 * 组件引用稳定（否则每次渲染都会卸载/重挂载）。Suspense 边界由消费方统一提供。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewer = ComponentType<any>

const lazyViewerCache = new Map<string, AnyViewer>()

type LocalTextPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: FilePreviewData }
  | { status: 'error'; message: string }

function lazyViewer(key: string, loader: () => Promise<{ default: AnyViewer }>): AnyViewer {
  let cached = lazyViewerCache.get(key)
  if (!cached) {
    cached = lazy(loader)
    lazyViewerCache.set(key, cached)
  }
  return cached
}

const LocalTextFilePreview: React.FC<LocalFilePreviewRenderProps> = ({
  filePath,
  fileName,
  className,
}) => {
  const [state, setState] = useState<LocalTextPreviewState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const readFilePreview = window.tabtin?.fileSystem?.readFilePreview

    setState({ status: 'loading' })

    if (!readFilePreview) {
      setState({ status: 'error', message: '文件预览服务不可用' })
      return () => {
        cancelled = true
      }
    }

    readFilePreview(filePath, { maxBytes: LOCAL_TEXT_PREVIEW_BYTES })
      .then((result) => {
        if (cancelled) return
        if (result?.success === false) {
          throw new Error(result.error || '文件预览失败')
        }

        const preview = result?.data
        if (preview?.kind !== 'text') {
          throw new Error('此文件无法作为文本预览')
        }

        setState({ status: 'ready', preview })
      })
      .catch((err) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : '文件预览失败',
        })
      })

    return () => {
      cancelled = true
    }
  }, [filePath])

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center text-center', className)}>
        <AlertCircle className="mb-2 h-6 w-6 text-destructive/45" strokeWidth={1} />
        <p className="text-body text-destructive/65">{state.message}</p>
      </div>
    )
  }

  return (
    <TextFileEditor
      filePath={filePath}
      fileName={fileName}
      content={state.preview.content ?? ''}
      readOnly
      truncated={state.preview.truncated}
      labels={{
        truncatedPreview: '文件较大，仅展示前半部分内容',
        largePreviewHint: '预览已截断',
        saveFailed: '保存失败',
      }}
      className={cn('h-full w-full', className)}
    />
  )
}

/**
 * ：渲染前剥掉元数据块，避免机器元数据出现在预览里：
 *   - `<!-- tabtin:plan ... -->` HTML 注释（plan 新格式；react-markdown 本不渲染注释，
 *     这里保险再剥一次）；
 *   - 起始的 YAML frontmatter `--- ... ---`（plan 旧格式 / 通用 markdown 元数据）。
 */
/** 剥 plan HTML 注释与 YAML frontmatter；TabCode MD 渲染与 Folder 预览共用。 */
export function stripPlanMetadata(md: string): string {
  let s = md.replace(/^\s*<!--\s*tabtin:plan[\s\S]*?-->\s*/, '')
  s = s.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  return s.replace(/^\s*\n/, '')
}

/** 远端文本严格按 UTF-8 解码；拒绝替换非法字节，避免悄悄展示损坏内容。 */
export function decodeUtf8Preview(data: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data)
}

function renderBinaryTextPreview({
  data,
  fileName,
  className,
}: BinaryFilePreviewRenderProps): ReactNode {
  return (
    <TextFileEditor
      fileName={fileName}
      content={decodeUtf8Preview(data)}
      readOnly
      labels={{
        truncatedPreview: '文件较大，仅展示前半部分内容',
        largePreviewHint: '预览已截断',
        saveFailed: '保存失败',
      }}
      className={cn('h-full w-full', className)}
    />
  )
}

function renderBinaryMarkdownPreview({
  data,
  className,
}: BinaryFilePreviewRenderProps): ReactNode {
  const MarkdownViewer = lazyViewer(
    'markdown',
    () => import('./MarkdownViewer').then((m) => ({ default: m.MarkdownViewer })),
  )
  return (
    <MarkdownViewer
      content={stripPlanMetadata(decodeUtf8Preview(data))}
      className={cn('h-full w-full', className)}
    />
  )
}

/**
 * ：Markdown 本地文件预览——读文件文本后用 MarkdownViewer 渲染。
 * plan 卡片「打开文档」对 file 载体（`.tabtin/plans/*.plan.md`）走本路径在 TabFiles 里预览。
 * 与 LocalTextFilePreview 同款读文件逻辑，仅渲染组件不同。
 */
const LocalMarkdownPreview: React.FC<LocalFilePreviewRenderProps> = ({
  filePath,
  className,
}) => {
  const [state, setState] = useState<LocalTextPreviewState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const readFilePreview = window.tabtin?.fileSystem?.readFilePreview
    setState({ status: 'loading' })
    if (!readFilePreview) {
      setState({ status: 'error', message: '文件预览服务不可用' })
      return () => {
        cancelled = true
      }
    }
    readFilePreview(filePath, { maxBytes: LOCAL_TEXT_PREVIEW_BYTES })
      .then((result) => {
        if (cancelled) return
        if (result?.success === false) {
          throw new Error(result.error || '文件预览失败')
        }
        const preview = result?.data
        if (preview?.kind !== 'text') {
          throw new Error('此文件无法作为文本预览')
        }
        setState({ status: 'ready', preview })
      })
      .catch((err) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : '文件预览失败',
        })
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center text-center', className)}>
        <AlertCircle className="mb-2 h-6 w-6 text-destructive/45" strokeWidth={1} />
        <p className="text-body text-destructive/65">{state.message}</p>
      </div>
    )
  }
  const MarkdownViewer = lazyViewer(
    'markdown',
    () => import('./MarkdownViewer').then((m) => ({ default: m.MarkdownViewer })),
  )
  return (
    <MarkdownViewer
      content={stripPlanMetadata(state.preview.content ?? '')}
      filePath={filePath}
      className={cn('h-full w-full', className)}
    />
  )
}

/**
 * ：本地图片预览（含 SVG）。走 tabtin-file:// + `<img>`，
 * SVG 不当 HTML 文档执行，避免脚本面。
 */
const LocalImagePreview: React.FC<LocalFilePreviewRenderProps> = ({
  filePath,
  fileName,
  className,
}) => {
  const src = buildTabtinFileUrl(filePath)
  // 面板高度链上 max-h-full 对竖图常失效；外层可滚 + 宽度优先，
  // 避免 9:16 被父级 overflow-hidden 裁切（对齐 TabDoc / Folder ScrollArea）。
  return (
    <div className={cn('h-full min-h-0 w-full overflow-auto p-4', className)}>
      <div className="flex min-h-full w-full items-center justify-center">
        <ImagePreview
          source={{ displayUrl: src }}
          alt={fileName}
          viewport="scrollable"
          className="h-full w-full"
          imageClassName="max-h-[88vh] max-w-full rounded-lg object-contain"
        />
      </div>
    </div>
  )
}

/**  / ：本地音视频预览——与 FileKindPreview 同款 tabtin-file:// + 原生控件。 */
const LocalVideoPreview: React.FC<LocalFilePreviewRenderProps> = ({
  filePath,
  className,
}) => {
  const src = buildTabtinFileUrl(filePath)
  return (
    <div className={cn('flex h-full w-full items-center justify-center p-4', className)}>
      <video controls className="max-h-full max-w-full" src={src} />
    </div>
  )
}

const LocalAudioPreview: React.FC<LocalFilePreviewRenderProps> = ({
  filePath,
  fileName,
  className,
}) => {
  const src = buildTabtinFileUrl(filePath)
  return (
    <div className={cn('flex h-full w-full flex-col items-center justify-center gap-3 p-8', className)}>
      <p className="max-w-full truncate text-body text-muted-foreground/60">{fileName}</p>
      <audio controls className="w-full max-w-md" src={src} />
    </div>
  )
}

export interface LocalFilePreviewRenderProps {
  filePath: string
  fileName: string
  className?: string
}

export interface BinaryFilePreviewRenderProps {
  data: ArrayBuffer
  fileName: string
  className?: string
}

export interface LocalFilePreviewFormat {
  /** 逻辑类型标识，写进 tab meta.file_type，例如 'xlsx'。registry 内唯一。 */
  fileType: string
  /** 关联扩展名（含点、小写），可多别名；registry 内全局唯一。 */
  extensions: readonly [string, ...string[]]
  /** 无扩展名或 dotfile 的精确文件名，与主进程本地文本识别契约共用。 */
  fileNames?: readonly string[]
  /** 预览面板/卡片副标题，例如 'Spreadsheet · XLSX'。 */
  label: string
  /** 图标 Tailwind class。 */
  iconClassName: string
  /** 头部 / 菜单图标。 */
  Icon: LucideIcon
  /** 用什么组件渲染该类型的预览（一处配置，无需中间 kind 映射）。 */
  renderPreview: (props: LocalFilePreviewRenderProps) => ReactNode
  /** 可选：同一只读 viewer 的远端二进制入口。未提供时云端文件保留下载兜底。 */
  renderBinaryPreview?: (props: BinaryFilePreviewRenderProps) => ReactNode
  /** 远端二进制进入 viewer 前的硬上限；无值表示由 viewer/下载通道自身限制。 */
  maxBinaryPreviewBytes?: number
}

class LocalFilePreviewRegistry {
  private readonly byFileType = new Map<string, LocalFilePreviewFormat>()
  private readonly byExtension = new Map<string, LocalFilePreviewFormat>()
  private readonly byFileName = new Map<string, LocalFilePreviewFormat>()

  constructor(formats: readonly LocalFilePreviewFormat[]) {
    for (const format of formats) this.register(format)
  }

  private register(format: LocalFilePreviewFormat): void {
    if (this.byFileType.has(format.fileType)) {
      throw new Error(`LocalFilePreviewFormat fileType 重复注册：${format.fileType}`)
    }
    const normalized = format.extensions.map((ext) => {
      const lower = ext.toLowerCase()
      if (!lower.startsWith('.')) {
        throw new Error(`LocalFilePreviewFormat.extensions 必须以 "." 开头：${ext}`)
      }
      if (this.byExtension.has(lower)) {
        throw new Error(`LocalFilePreviewFormat extension 重复注册：${lower}`)
      }
      return lower
    }) as [string, ...string[]]
    for (const fileName of format.fileNames ?? []) {
      if (this.byFileName.has(fileName)) {
        throw new Error(`LocalFilePreviewFormat fileName 重复注册：${fileName}`)
      }
    }
    const stored: LocalFilePreviewFormat = {
      ...format,
      extensions: normalized,
      fileNames: format.fileNames ? [...format.fileNames] : undefined,
    }
    this.byFileType.set(format.fileType, stored)
    for (const ext of normalized) this.byExtension.set(ext, stored)
    for (const fileName of stored.fileNames ?? []) this.byFileName.set(fileName, stored)
  }

  getByFileType(fileType: string): LocalFilePreviewFormat | undefined {
    return this.byFileType.get(fileType.toLowerCase())
  }

  /**
   * 按相对路径扩展名推断（匹配任一别名）。
   * 取最长命中，避免 `.mts` 被 `.ts`、`.mm` 被 `.m` 误匹配。
   */
  getByPath(relativePath: string): LocalFilePreviewFormat | undefined {
    const fileName = relativePath.split(/[\\/]/).pop() ?? relativePath
    const byFileName = this.byFileName.get(fileName)
    if (byFileName) return byFileName
    const lower = relativePath.toLowerCase()
    let best: LocalFilePreviewFormat | undefined
    let bestLen = -1
    for (const [ext, format] of this.byExtension) {
      if (lower.endsWith(ext) && ext.length > bestLen) {
        best = format
        bestLen = ext.length
      }
    }
    return best
  }

  /** 所有已注册扩展名（含别名），扁平列表。 */
  extensions(): string[] {
    return [...this.byExtension.keys()]
  }

  /** 注册格式快照，用于能力矩阵审计；调用方不得修改 registry。 */
  formats(): readonly LocalFilePreviewFormat[] {
    return [...this.byFileType.values()]
  }
}

const localFilePreviewFormats: LocalFilePreviewFormat[] = [
  {
    fileType: 'xlsx',
    extensions: ['.xlsx', '.xls'],
    label: 'Spreadsheet · Excel',
    iconClassName: 'text-emerald-600',
    Icon: FileSpreadsheet,
    renderPreview: ({ filePath, className }) => {
      const XlsxViewer = lazyViewer('xlsx', () => import('./XlsxViewer').then(m => ({ default: m.XlsxViewer })))
      return <XlsxViewer filePath={filePath} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, className }) => {
      const XlsxViewer = lazyViewer('xlsx', () => import('./XlsxViewer').then(m => ({ default: m.XlsxViewer })))
      return <XlsxViewer data={data} className={cn('h-full', className)} />
    },
    maxBinaryPreviewBytes: MAX_OFFICE_FILE_BYTES,
  },
  {
    fileType: 'csv',
    extensions: ['.csv', '.tsv'],
    label: 'Data · CSV',
    iconClassName: 'text-emerald-600',
    Icon: FileSpreadsheet,
    renderPreview: ({ filePath, fileName, className }) => {
      const CsvViewer = lazyViewer('csv', () => import('./CsvViewer').then(m => ({ default: m.CsvViewer })))
      return <CsvViewer filePath={filePath} fileName={fileName} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, fileName, className }) => {
      const CsvViewer = lazyViewer('csv', () => import('./CsvViewer').then(m => ({ default: m.CsvViewer })))
      return (
        <CsvViewer
          fileName={fileName}
          content={decodeUtf8Preview(data)}
          className={cn('h-full', className)}
        />
      )
    },
    maxBinaryPreviewBytes: LOCAL_TEXT_PREVIEW_BYTES,
  },
  {
    fileType: 'docx',
    extensions: ['.docx'],
    label: 'Document · DOCX',
    iconClassName: 'text-blue-600',
    Icon: FileText,
    renderPreview: ({ filePath, fileName, className }) => {
      const DocxViewer = lazyViewer('docx', () => import('./DocxViewer').then(m => ({ default: m.DocxViewer })))
      return <DocxViewer filePath={filePath} fileName={fileName} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, fileName, className }) => {
      const DocxViewer = lazyViewer('docx', () => import('./DocxViewer').then(m => ({ default: m.DocxViewer })))
      return <DocxViewer data={data} fileName={fileName} className={cn('h-full', className)} />
    },
    maxBinaryPreviewBytes: MAX_OFFICE_FILE_BYTES,
  },
  {
    fileType: 'doc',
    extensions: ['.doc'],
    label: 'Document · DOC',
    iconClassName: 'text-blue-600',
    Icon: FileText,
    renderPreview: ({ filePath, fileName, className }) => {
      const DocxViewer = lazyViewer('docx', () => import('./DocxViewer').then(m => ({ default: m.DocxViewer })))
      return <DocxViewer filePath={filePath} fileName={fileName} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, fileName, className }) => {
      const DocxViewer = lazyViewer('docx', () => import('./DocxViewer').then(m => ({ default: m.DocxViewer })))
      return <DocxViewer data={data} fileName={fileName} className={cn('h-full', className)} />
    },
    maxBinaryPreviewBytes: MAX_OFFICE_FILE_BYTES,
  },
  {
    fileType: 'pdf',
    extensions: ['.pdf'],
    label: 'Document · PDF',
    iconClassName: 'text-rose-600',
    Icon: FileType,
    renderPreview: ({ filePath, fileName, className }) => {
      const PdfViewer = lazyViewer('pdf', () => import('./PdfViewer').then(m => ({ default: m.PdfViewer })))
      return <PdfViewer fileUrl={buildTabtinFileUrl(filePath)} filename={fileName} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, fileName, className }) => {
      const PdfViewer = lazyViewer('pdf', () => import('./PdfViewer').then(m => ({ default: m.PdfViewer })))
      // 云盘二进制预览由 TabFiles 顶栏统一提供下载，避免双入口
      return (
        <PdfViewer
          data={data}
          filename={fileName}
          showDownload={false}
          className={cn('h-full', className)}
        />
      )
    },
    maxBinaryPreviewBytes: OSS_PRESIGNED_DOWNLOAD_MAX_BYTES,
  },
  {
    fileType: 'json',
    extensions: ['.json', '.jsonc', '.json5', '.jsonl'],
    label: 'Data · JSON',
    iconClassName: 'text-amber-600',
    Icon: FileText,
    renderPreview: (props) => <LocalTextFilePreview {...props} />,
    renderBinaryPreview: renderBinaryTextPreview,
    maxBinaryPreviewBytes: LOCAL_TEXT_PREVIEW_BYTES,
  },
  {
    // 聊天 Lightbox（inferPreviewableKind）已认 txt；产物卡 / Space 预览此前漏注册。
    fileType: 'txt',
    extensions: ['.txt'],
    label: 'Document · TXT',
    iconClassName: 'text-slate-500',
    Icon: FileText,
    renderPreview: (props) => <LocalTextFilePreview {...props} />,
    renderBinaryPreview: renderBinaryTextPreview,
    maxBinaryPreviewBytes: LOCAL_TEXT_PREVIEW_BYTES,
  },
  {
    fileType: 'pptx',
    extensions: ['.pptx'],
    label: 'Presentation · PPTX',
    iconClassName: 'text-amber-600',
    Icon: Presentation,
    renderPreview: ({ filePath, fileName, className }) => {
      const PptxViewer = lazyViewer('pptx', () => import('./PptxViewer').then(m => ({ default: m.PptxViewer })))
      return <PptxViewer filePath={filePath} filename={fileName} className={cn('h-full', className)} />
    },
    renderBinaryPreview: ({ data, fileName, className }) => {
      // 仅调用现有 PPTX 只读解析 viewer；不会创建或持久化 TabSlide 资源。
      const PptxViewer = lazyViewer('pptx', () => import('./PptxViewer').then(m => ({ default: m.PptxViewer })))
      return <PptxViewer data={data} filename={fileName} className={cn('h-full', className)} />
    },
    maxBinaryPreviewBytes: MAX_OFFICE_FILE_BYTES,
  },
  {
    // ：Markdown 预览——plan 文件（.plan.md）「打开文档」走本项在 TabFiles 里渲染。
    // getByPath 用最长后缀匹配，`.plan.md` 命中 `.md`。
    fileType: 'markdown',
    extensions: ['.md', '.markdown', '.mark'],
    label: 'Document · Markdown',
    iconClassName: 'text-slate-500',
    Icon: FileText,
    renderPreview: (props) => <LocalMarkdownPreview {...props} />,
    renderBinaryPreview: renderBinaryMarkdownPreview,
    maxBinaryPreviewBytes: LOCAL_TEXT_PREVIEW_BYTES,
  },
  {
    // ：图片预览（含 SVG）——Agent 常产出示意图；底层 tabtin-file:// 已认 image/svg+xml。
    fileType: 'image',
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    label: 'Image',
    iconClassName: 'text-sky-600',
    Icon: ImageIcon,
    renderPreview: (props) => <LocalImagePreview {...props} />,
  },
  {
    //  / ：音视频——与主进程 AUDIO/VIDEO_EXTENSIONS + 聊天 Lightbox 对齐。
    fileType: 'video',
    extensions: ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv'],
    label: 'Video',
    iconClassName: 'text-violet-600',
    Icon: Film,
    renderPreview: (props) => <LocalVideoPreview {...props} />,
  },
  {
    fileType: 'audio',
    extensions: ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'],
    label: 'Audio',
    iconClassName: 'text-violet-600',
    Icon: Music,
    renderPreview: (props) => <LocalAudioPreview {...props} />,
  },
  {
    /**
     * ：主进程 `TEXT_EXTENSIONS` 里其余可文本预览格式（已单独注册的
     * json/txt/md/csv/svg 除外）。HTML 只读源码，不当文档执行。
     */
    fileType: 'text',
    extensions: [
      '.rst', '.adoc',
      '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.xml', '.plist',
      '.env', '.env.local', '.env.development', '.env.production', '.env.test',
      '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
      '.js', '.jsx', '.mjs', '.cjs',
      '.ts', '.tsx', '.mts', '.cts',
      '.vue', '.svelte', '.astro',
      '.py', '.pyi', '.pyw',
      '.go', '.rs', '.java', '.kt', '.kts', '.scala',
      '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
      '.cs', '.fs', '.fsx',
      '.rb', '.php', '.lua', '.perl', '.pl', '.pm',
      '.swift', '.m', '.mm',
      '.r', '.jl',
      '.ex', '.exs', '.erl', '.hrl',
      '.zig', '.nim', '.v', '.d',
      '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1',
      '.dockerfile',
      '.lock', '.log', '.diff', '.patch',
      '.gitignore', '.gitattributes', '.gitmodules',
      '.editorconfig', '.prettierrc', '.eslintrc',
      '.npmrc', '.nvmrc', '.babelrc',
      '.graphql', '.gql', '.proto', '.sql',
      '.tf', '.hcl',
    ],
    fileNames: TEXT_PREVIEW_FILENAMES,
    label: 'Text',
    iconClassName: 'text-slate-500',
    Icon: FileCode,
    renderPreview: (props) => <LocalTextFilePreview {...props} />,
    renderBinaryPreview: renderBinaryTextPreview,
    maxBinaryPreviewBytes: LOCAL_TEXT_PREVIEW_BYTES,
  },
]

export const localFilePreviewRegistry = new LocalFilePreviewRegistry(localFilePreviewFormats)
