/**
 * 文件图标匹配引擎 — 基于 material-icon-theme manifest 做四级优先级查找
 *
 * TabCode / TabFolder 等文件树共用；静态资源在 static/file-icons/。
 */

interface FileIconManifest {
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  defaultIcon: string
  defaultFolderIcon: string
  defaultFolderOpenIcon: string
}

let _manifest: FileIconManifest | null = null
let _version = 0
const _listeners = new Set<() => void>()

async function loadManifest(): Promise<void> {
  try {
    const resp = await fetch('/file-icons/manifest.json')
    _manifest = (await resp.json()) as FileIconManifest
  } catch {
    _manifest = {
      fileNames: {},
      fileExtensions: {},
      folderNames: {},
      folderNamesExpanded: {},
      defaultIcon: 'file',
      defaultFolderIcon: 'folder',
      defaultFolderOpenIcon: 'folder-open',
    }
  }
  _version++
  for (const fn of _listeners) fn()
}

const _preloadPromise = loadManifest()

export function subscribeManifest(cb: () => void): () => void {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

export function getManifestVersion(): number {
  return _version
}

export { _preloadPromise as preloadFileIcons }

function resolveIconUrl(iconName: string): string {
  return `/file-icons/${iconName}.svg`
}

export interface FileIconResult {
  src: string
}

export function getFileIcon(
  fileName: string,
  isDirectory: boolean,
  isOpen = false,
): FileIconResult {
  const m = _manifest
  if (!m) {
    return { src: resolveIconUrl(isDirectory ? 'folder' : 'file') }
  }

  if (isDirectory) {
    const baseName = fileName.toLowerCase()
    if (isOpen && m.folderNamesExpanded[baseName]) {
      return { src: resolveIconUrl(m.folderNamesExpanded[baseName]) }
    }
    if (m.folderNames[baseName]) {
      const iconName = isOpen
        ? (m.folderNamesExpanded[baseName] ?? m.folderNames[baseName])
        : m.folderNames[baseName]
      return { src: resolveIconUrl(iconName) }
    }
    return {
      src: resolveIconUrl(isOpen ? m.defaultFolderOpenIcon : m.defaultFolderIcon),
    }
  }

  const fileNameLower = fileName.toLowerCase()
  if (m.fileNames[fileNameLower]) {
    return { src: resolveIconUrl(m.fileNames[fileNameLower]) }
  }

  const dotIndex = fileName.indexOf('.')
  if (dotIndex !== -1) {
    const afterFirstDot = fileName.slice(dotIndex + 1).toLowerCase()
    const segments = afterFirstDot.split('.')
    for (let i = 0; i < segments.length; i++) {
      const ext = segments.slice(i).join('.')
      if (m.fileExtensions[ext]) {
        return { src: resolveIconUrl(m.fileExtensions[ext]) }
      }
    }
  }

  return { src: resolveIconUrl(m.defaultIcon) }
}
