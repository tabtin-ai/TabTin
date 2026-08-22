import { app, session } from 'electron'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { resolveSpacesRoot, resolvePlatformDataRoot } from '@tabtin/terminal-core'

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
}

/**
 * 允许 tabtin-file 协议访问的根目录列表（用户文件用途）。
 * 路径遍历攻击防护：解析后的路径必须落在白名单目录内。
 */
const getAllowedRoots = (): string[] => {
  const roots: string[] = []
  try { roots.push(resolveSpacesRoot()) } catch { /* ignore */ }
  try { roots.push(resolvePlatformDataRoot()) } catch { /* ignore */ }
  try { roots.push(app.getPath('userData')) } catch { /* ignore */ }
  try { roots.push(app.getPath('temp')) } catch { /* ignore */ }
  try { roots.push(app.getPath('downloads')) } catch { /* ignore */ }
  try { roots.push(app.getPath('home')) } catch { /* ignore */ }
  return roots.map(r => path.resolve(r))
}

/**
 * Packaged renderer 静态资源根目录（app://）。
 *
 * - dev / preview --skipBuild：main 进程从 `apps/tabtin-electron/out/main/index.mjs` 启动，
 *   `import.meta.dirname` = `<repo>/apps/tabtin-electron/out/main`，则 renderer 资源
 *   位于 `../renderer` = `<repo>/apps/tabtin-electron/out/renderer`。
 * - packaged：main 在 `Resources/app.asar/out/main`，renderer 同样在 `../renderer`
 *   （asar 内）。Electron 的 fs 兼容层支持读 asar 内文件，无需特殊处理。
 *
 * 这里只解析一次并缓存，避免每次请求都做一次路径运算。
 */
let cachedAppResourceRoot: string | null = null
const getAppResourceRoot = (): string => {
  if (cachedAppResourceRoot) return cachedAppResourceRoot
  cachedAppResourceRoot = path.resolve(import.meta.dirname, '../renderer')
  return cachedAppResourceRoot
}

/**
 * 解析 `tabtin-file://app/<resource>` 形式的 URL，映射到 packaged renderer 输出目录。
 *
 * 安全性：
 *   - hostname 必须等于 'app'（其他 hostname 走用户文件分支）
 *   - pathname 解码后绝对解析，必须落在 renderer 输出根目录之内（防 `..` 越出）
 *
 * 返回值：
 *   - string：合法的 packaged 资源绝对路径
 *   - null：路径越出根目录或解析失败
 */
const resolveAppResourcePath = (rawUrl: string): string | null => {
  const url = new URL(rawUrl)
  // hostname 已由调用方校验为 'app'；这里再防御一次，避免被误用
  if (url.hostname !== 'app') return null

  // tabtin-file://app/index.html → pathname = '/index.html'
  // tabtin-file://app/             → pathname = '/'，回退到 index.html
  let pathname = decodeURIComponent(url.pathname || '/')
  if (pathname === '' || pathname === '/') {
    pathname = '/index.html'
  }
  if (pathname.startsWith('/')) {
    pathname = pathname.slice(1)
  }

  const root = getAppResourceRoot()
  const resolved = path.resolve(root, pathname)

  // 路径遍历攻击防护：必须仍在 root 之内
  const rootWithSep = root + path.sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return null
  }
  return resolved
}

const resolveFilePath = (rawUrl: string): string | null => {
  const url = new URL(rawUrl)
  const host = url.hostname
  let filePath = decodeURIComponent(url.pathname)

  if (host && host !== 'local') {
    filePath = `/${host}${filePath}`
  }

  if (process.platform === 'win32') {
    if (filePath.startsWith('/')) {
      filePath = filePath.slice(1)
    }
  } else {
    if (!filePath.startsWith('/')) {
      filePath = `/${filePath}`
    }
    if (filePath.startsWith('//')) {
      filePath = `/${filePath.replace(/^\/+/, '')}`
    }
  }

  let resolved = path.resolve(filePath)

  // URL 规范要求 hostname 强制小写化（如 /Users → /users），
  // 导致重组后的路径大小写与实际文件系统不一致。
  // macOS APFS 默认 case-insensitive，realpathSync 可还原为规范大小写。
  try {
    resolved = fs.realpathSync(resolved)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  const allowedRoots = getAllowedRoots()
  const isAllowed = allowedRoots.some(root => {
    if (process.platform === 'darwin') {
      return resolved.toLowerCase().startsWith((root + path.sep).toLowerCase())
        || resolved.toLowerCase() === root.toLowerCase()
    }
    return resolved.startsWith(root + path.sep) || resolved === root
  })
  if (!isAllowed) {
    return null
  }

  return resolved
}

const parseRange = (rangeHeader: string, size: number) => {
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!match) return null

  const startText = match[1]
  const endText = match[2]
  let start = startText ? Number.parseInt(startText, 10) : Number.NaN
  let end = endText ? Number.parseInt(endText, 10) : Number.NaN

  if (Number.isNaN(start)) {
    // suffix range: bytes=-500
    if (Number.isNaN(end)) return null
    start = Math.max(size - end, 0)
    end = size - 1
  } else {
    if (Number.isNaN(end) || end >= size) {
      end = size - 1
    }
  }

  if (start < 0 || end < 0 || start > end) return null
  return { start, end }
}

/**
 * 流式返回一个已解析为绝对路径的本地文件。
 *
 * - 支持 HTTP Range 请求（用户视频/音频拖动时间轴）
 * - 始终带 `Access-Control-Allow-Origin: *`，因为 packaged renderer origin
 *   是 `tabtin-file://app`，加载用户文件 `tabtin-file:///path` 是跨 origin
 *
 * 所有错误（含 ENOENT / EACCES）都映射为 404 而非 500，避免泄露文件系统信息。
 */
const respondWithLocalFile = async (
  request: Electron.ProtocolRequest,
  filePath: string,
  callback: (response: Electron.ProtocolResponse) => void,
): Promise<void> => {
  const stat = await fsPromises.stat(filePath)
  if (!stat.isFile()) {
    callback({ statusCode: 404, data: Readable.from('Not found') })
    return
  }

  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  const size = stat.size

  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Range,Content-Length',
  }

  const rangeHeader =
    (request.headers?.Range as string | undefined) ||
    (request.headers?.range as string | undefined)

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size)
    if (!range) {
      callback({
        statusCode: 416,
        headers: { 'Content-Range': `bytes */${size}` },
        data: Readable.from([]),
      })
      return
    }

    const { start, end } = range
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(end - start + 1)
    callback({
      statusCode: 206,
      headers,
      data: fs.createReadStream(filePath, { start, end }),
    })
    return
  }

  headers['Content-Length'] = String(size)
  callback({
    statusCode: 200,
    headers,
    data: fs.createReadStream(filePath),
  })
}

let hasRegistered = false

/**
 * 注册 `tabtin-file://` 协议，承担两种用途：
 *
 * 1. **Packaged renderer 入口与静态资源**（hostname == 'app'）
 *    - `tabtin-file://app/index.html` → packaged 出口 `out/renderer/index.html`
 *    - `tabtin-file://app/assets/xxx.js` → `out/renderer/assets/xxx.js`
 *    - 让 renderer origin 稳定为 `tabtin-file://app`，Centrifugo / 其他后端可以
 *      把这个 origin 加进 `allowed_origins` 白名单（参见 scripts/backend/centrifugo-dev.json）
 *    - dev 模式下不会走到这里——dev rendererUrl 是 vite dev server，main-window.ts
 *      根据 `isDev` 分流走 `loadURL(http://localhost:5173)`
 *
 * 2. **用户文件（图片预览 / 视频播放 / TabMemo 附件 / 沙箱内文件等）**（其他 hostname）
 *    - 路径白名单：spaces / platformData / userData / temp / downloads / home
 *    - 防路径遍历：解析后的真实路径必须命中白名单
 */
export const registerTabtinFileProtocol = () => {
  if (hasRegistered) return
  hasRegistered = true

  const protocol = session.defaultSession.protocol
  protocol.registerStreamProtocol('tabtin-file', async (request, callback) => {
    try {
      const url = new URL(request.url)

      if (url.hostname === 'app') {
        const filePath = resolveAppResourcePath(request.url)
        if (!filePath) {
          callback({
            statusCode: 403,
            data: Readable.from('Access denied: path outside renderer resource root'),
          })
          return
        }
        await respondWithLocalFile(request, filePath, callback)
        return
      }

      const filePath = resolveFilePath(request.url)
      if (!filePath) {
        callback({
          statusCode: 403,
          data: Readable.from('Access denied: path outside allowed directories'),
        })
        return
      }
      await respondWithLocalFile(request, filePath, callback)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      callback({
        statusCode: 404,
        data: Readable.from(message),
      })
    }
  })
}
