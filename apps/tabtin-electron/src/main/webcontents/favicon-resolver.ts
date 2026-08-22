import { nativeImage, net, type WebContents } from 'electron'

type ResolveFaviconOptions = {
  webContents: WebContents
  pageUrl?: string
  favicons?: string[]
  allowDom?: boolean
  viewId?: string
}

type FetchResult = {
  buffer: Buffer
  contentType: string
}

const CACHE_MAX_ENTRIES = 200
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ICON_BYTES = 1024 * 1024

const isDataUrl = (value: string) => value.startsWith('data:')
const isHttpUrl = (value: string) => value.startsWith('http://') || value.startsWith('https://')
const isBlobUrl = (value: string) => value.startsWith('blob:')

const normalizeCandidate = (value: string, pageUrl?: string): string | null => {
  if (!value || typeof value !== 'string') return null
  if (isDataUrl(value)) return value
  if (isBlobUrl(value)) return null
  if (value.startsWith('//')) return `https:${value}`
  if (isHttpUrl(value)) return value
  if (!pageUrl) return null
  try {
    return new URL(value, pageUrl).toString()
  } catch {
    return null
  }
}

const buildFallbackFromPageUrl = (pageUrl?: string): string[] => {
  if (!pageUrl) return []
  try {
    const parsed = new URL(pageUrl)
    const candidates = new Set<string>()
    candidates.add(`${parsed.origin}/favicon.ico`)
    if (parsed.protocol === 'http:') {
      candidates.add(`https://${parsed.host}/favicon.ico`)
    }
    return Array.from(candidates)
  } catch {
    return []
  }
}

const getContentType = (raw?: string | null) => {
  if (!raw) return ''
  return raw.split(';')[0]?.trim().toLowerCase() || ''
}

const toDataUrl = (buffer: Buffer, contentType: string): string | null => {
  const normalized = getContentType(contentType)
  if (normalized.includes('svg')) {
    return `data:${normalized};base64,${buffer.toString('base64')}`
  }
  const image = nativeImage.createFromBuffer(buffer)
  if (!image.isEmpty()) {
    return image.toDataURL()
  }
  if (normalized.startsWith('image/')) {
    return `data:${normalized};base64,${buffer.toString('base64')}`
  }
  return null
}

const fetchWithSession = async (
  webContents: WebContents,
  url: string,
  referer?: string
): Promise<FetchResult | null> => {
  const session = webContents.session
  const userAgent = webContents.getUserAgent?.() || undefined
  const safeReferer = referer && isHttpUrl(referer) ? referer : undefined

  if (session && typeof session.fetch === 'function') {
    const response = await session.fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'image/*',
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
        ...(safeReferer ? { Referer: safeReferer } : {})
      }
    })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || ''
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) return null
    return { buffer, contentType }
  }

  return new Promise((resolve) => {
    let settled = false
    const safeResolve = (value: FetchResult | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const request = net.request({ url, session })
      request.setHeader('Accept', 'image/*')
      if (userAgent) {
        request.setHeader('User-Agent', userAgent)
      }
      if (safeReferer) {
        request.setHeader('Referer', safeReferer)
      }
      request.on('response', (response) => {
        const responseControl = response as unknown as {
          resume?: () => void
          destroy?: () => void
        }
        if (!response.statusCode || response.statusCode >= 400) {
          responseControl.resume?.()
          safeResolve(null)
          return
        }
        const contentType = response.headers['content-type'] || ''
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_ICON_BYTES) {
            responseControl.destroy?.()
            safeResolve(null)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (chunks.length === 0) {
            safeResolve(null)
            return
          }
          safeResolve({ buffer: Buffer.concat(chunks), contentType: Array.isArray(contentType) ? contentType[0] : contentType })
        })
      })
      request.on('error', () => safeResolve(null))
      request.end()
    } catch {
      safeResolve(null)
    }
  })
}

const extractDomIcons = async (webContents: WebContents): Promise<string[]> => {
  if (webContents.isDestroyed()) return []
  const script = `(() => {
    const selectors = [
      'link[rel~="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
      'link[rel="apple-touch-icon-precomposed"]'
    ]
    const nodes = document.querySelectorAll(selectors.join(','))
    return Array.from(nodes)
      .map(node => node && node.href ? String(node.href) : '')
      .filter(Boolean)
  })()`
  try {
    const result = await webContents.executeJavaScript(script, true)
    if (!Array.isArray(result)) return []
    return result.filter(item => typeof item === 'string')
  } catch {
    return []
  }
}

export class FaviconResolver {
  private cache = new Map<string, { dataUrl: string; ts: number }>()
  private inflight = new Map<string, Promise<string | null>>()

  private getCached(key: string): string | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.cache.delete(key)
      return null
    }
    return entry.dataUrl
  }

  private setCache(key: string, dataUrl: string): void {
    this.cache.set(key, { dataUrl, ts: Date.now() })
    if (this.cache.size <= CACHE_MAX_ENTRIES) return
    const oldestKey = this.cache.keys().next().value as string | undefined
    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  private async resolveCandidate(
    webContents: WebContents,
    candidate: string,
    referer?: string
  ): Promise<string | null> {
    if (isDataUrl(candidate)) {
      return candidate
    }
    const cached = this.getCached(candidate)
    if (cached) return cached
    const inflight = this.inflight.get(candidate)
    if (inflight) return inflight

    const task = (async () => {
      const fetched = await fetchWithSession(webContents, candidate, referer)
      if (!fetched) return null
      const dataUrl = toDataUrl(fetched.buffer, fetched.contentType)
      if (dataUrl) {
        this.setCache(candidate, dataUrl)
      }
      return dataUrl
    })()

    this.inflight.set(candidate, task)
    try {
      return await task
    } finally {
      this.inflight.delete(candidate)
    }
  }

  async resolve(options: ResolveFaviconOptions): Promise<string | null> {
    const { webContents } = options
    if (!webContents || webContents.isDestroyed()) return null
    const pageUrl = options.pageUrl || webContents.getURL()

    const candidates = new Set<string>()
    const add = (value?: string) => {
      const normalized = value ? normalizeCandidate(value, pageUrl) : null
      if (normalized) candidates.add(normalized)
    }

    options.favicons?.forEach(add)

    if (options.allowDom) {
      const domIcons = await extractDomIcons(webContents)
      domIcons.forEach(add)
    }

    buildFallbackFromPageUrl(pageUrl).forEach(add)

    for (const candidate of candidates) {
      const dataUrl = await this.resolveCandidate(webContents, candidate, pageUrl)
      if (dataUrl) return dataUrl
    }

    return null
  }
}

let resolverInstance: FaviconResolver | null = null

export const getFaviconResolver = (): FaviconResolver => {
  if (!resolverInstance) {
    resolverInstance = new FaviconResolver()
  }
  return resolverInstance
}
