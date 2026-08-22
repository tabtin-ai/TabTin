/**
 * 文件路径 / 类型判断 / 预览 URL 等跨场景工具
 *
 * 供 TabFolder、TabCode、shared/file-preview 等共用。
 */

import { formatFileSize as _formatFileSize } from '@/constants/upload'

export { formatFileSize } from '@/constants/upload'

/**
 * 格式化文件大小；bytes 缺失时返回 unknown 文案（Folder meta 等场景用 i18n wrapper）
 */
export function formatFileSizeOptional(
  bytes?: number | null,
  unknownLabel = '—',
): string {
  if (bytes === undefined || bytes === null) return unknownLabel
  return _formatFileSize(bytes)
}

/**
 * 获取路径的最后一段（文件/文件夹名）
 */
export {
  isPathInside,
  joinPath,
  getParentPath,
  normalizePathSeparators,
  canMoveEntryToDir,
  dirsAffectedByFsChange,
} from './path-ops'

export const getBaseName = (value: string): string => {
  if (!value) return ''
  const trimmed = value.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || value
}

/**
 * 获取文件扩展名（含点，小写）
 */
export const getExtension = (filename: string): string => {
  const idx = filename.lastIndexOf('.')
  if (idx <= 0) return ''
  return filename.slice(idx).toLowerCase()
}

export const isImageFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext)
}

export const isVideoFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.mp4', '.webm', '.mkv', '.avi', '.mov'].includes(ext)
}

export const isAudioFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'].includes(ext)
}

export const isCodeFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.java', '.c', '.cpp', '.h',
    '.cs', '.rb', '.php', '.swift', '.kt', '.rs', '.vue', '.svelte',
  ].includes(ext)
}

export const isTextFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return [
    '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.xml', '.html',
    '.css', '.scss', '.less', '.log', '.ini', '.env', '.csv', '.toml',
  ].includes(ext)
}

export const isPdfFile = (filename: string): boolean => getExtension(filename) === '.pdf'

export const isCsvFile = (filename: string): boolean => getExtension(filename) === '.csv'

export const isWordFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.doc', '.docx'].includes(ext)
}

export const isDocxFile = (filename: string): boolean => getExtension(filename) === '.docx'

export const isXlsxFile = (filename: string): boolean => getExtension(filename) === '.xlsx'

export const isPptxFile = (filename: string): boolean => getExtension(filename) === '.pptx'

export const isMarkdownFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.md', '.markdown', '.mark'].includes(ext)
}

export const isOfficeFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.docx', '.xlsx', '.pptx'].includes(ext)
}

export const isArchiveFile = (filename: string): boolean => {
  const ext = getExtension(filename)
  return ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2'].includes(ext)
}

const MONACO_LANGUAGE_BY_BASENAME: Record<string, string> = {
  Makefile: 'makefile',
  Dockerfile: 'dockerfile',
  Vagrantfile: 'ruby',
  Gemfile: 'ruby',
  Rakefile: 'ruby',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.babelrc': 'json',
  '.npmrc': 'ini',
}

/**
 * 获取 Monaco 语言标识（Folder / TabCode / TextFileEditor 共用）
 */
export const getMonacoLanguage = (filename: string): string => {
  const baseName = getBaseName(filename)

  const byName = MONACO_LANGUAGE_BY_BASENAME[baseName]
  if (byName) return byName

  if (baseName.startsWith('.env')) return 'ini'

  const ext = getExtension(filename)
  switch (ext) {
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.json':
    case '.jsonc':
    case '.json5':
      return 'json'
    case '.css':
      return 'css'
    case '.scss':
    case '.sass':
      return 'scss'
    case '.less':
      return 'less'
    case '.html':
    case '.htm':
    case '.vue':
    case '.svelte':
      return 'html'
    case '.xml':
    case '.plist':
    case '.svg':
      return 'xml'
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.rst':
      return 'restructuredtext'
    case '.py':
    case '.pyi':
      return 'python'
    case '.go':
      return 'go'
    case '.java':
      return 'java'
    case '.c':
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.h':
    case '.hpp':
      return 'cpp'
    case '.cs':
      return 'csharp'
    case '.fs':
      return 'fsharp'
    case '.rb':
      return 'ruby'
    case '.php':
      return 'php'
    case '.rs':
      return 'rust'
    case '.kt':
    case '.kts':
      return 'kotlin'
    case '.scala':
      return 'scala'
    case '.swift':
      return 'swift'
    case '.m':
      return 'objective-c'
    case '.lua':
      return 'lua'
    case '.r':
      return 'r'
    case '.jl':
      return 'julia'
    case '.ex':
    case '.exs':
      return 'elixir'
    case '.erl':
      return 'erlang'
    case '.yaml':
    case '.yml':
      return 'yaml'
    case '.toml':
    case '.ini':
    case '.cfg':
    case '.conf':
      return 'ini'
    case '.sql':
      return 'sql'
    case '.graphql':
    case '.gql':
      return 'graphql'
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.fish':
      return 'shell'
    case '.bat':
    case '.cmd':
      return 'bat'
    case '.ps1':
      return 'powershell'
    case '.proto':
      return 'protobuf'
    case '.tf':
    case '.hcl':
      return 'hcl'
    case '.dockerfile':
      return 'dockerfile'
    case '.log':
    case '.txt':
    default:
      return 'plaintext'
  }
}

export const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024 // 50MB
export const LOCAL_TEXT_PREVIEW_BYTES = 512 * 1024 // 512KB

export async function checkFileSize(filePath: string): Promise<{ ok: boolean; size: number }> {
  const res = await window.tabtin.fileSystem.readFilePreview(filePath, { maxBytes: 0 })
  if (!res.success) {
    throw new Error(res.error ?? `Cannot read file: ${filePath}`)
  }
  const size = typeof res.data?.size === 'number' ? res.data.size : -1
  if (size < 0) throw new Error(`Cannot determine file size: ${filePath}`)
  return { ok: size <= MAX_OFFICE_FILE_BYTES, size }
}

/**
 * 把绝对文件路径编码成 `tabtin-file://` 协议 URL，供 <img>/<video>/PdfViewer
 * 等直接按路径加载（绕开 base64 / maxBytes 限制）。各段单独 encode 以兼容空格
 * 与中文路径。
 */
export function buildTabtinFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encodedPath = normalized
    .split('/')
    .map(seg => (seg ? encodeURIComponent(seg) : ''))
    .join('/')

  if (/^[A-Za-z]:\//.test(normalized)) {
    // Chromium fetch() rejects `tabtin-file:///C%3A/...`; keep the drive
    // letter in the path under a stable host that the main protocol unwraps.
    return `tabtin-file://local/${encodedPath}`
  }

  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = withLeadingSlash
    .split('/')
    .map(seg => (seg ? encodeURIComponent(seg) : ''))
    .join('/')
  return `tabtin-file://${encoded}`
}
