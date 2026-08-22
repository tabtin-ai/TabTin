/**
 * MPDParser — DASH 流媒体 MPD 解析
 *
 * 解析 DASH MPD (Media Presentation Description) XML，提取：
 * - 多质量流：AdaptationSet / Representation 的 bandwidth、resolution、codecs
 * - 分片地址：SegmentTemplate（$Number$ / $Time$ 模板）、SegmentList
 * - 直播 vs 点播 判断
 *
 * 支持特性：
 * - Period / AdaptationSet / Representation 三级结构
 * - SegmentTemplate（$Number$ / $Time$ 模板替换，含 %0Nd 零填充）
 * - SegmentTimeline（<S> 元素，含 r 重复计数，包括 r=-1）
 * - SegmentList（SegmentURL 列表 + Initialization）
 * - 多层 BaseURL 拼接（MPD → Period → AdaptationSet → Representation）
 * - ISO 8601 Duration 解析（PT1H2M3.4S）
 * - ContentProtection DRM 加密检测
 * - type="dynamic" 直播流检测
 * - initialization segment URL
 * - 独立音频轨解析
 */

import { net } from 'electron'
import type { StreamVariant, M3U8Segment, StreamInfo } from '@tabtin/action-tools/types'
import { buildNetRequestOptions } from './resourceRequestContext'

const MANIFEST_MAX_SIZE = 5 * 1024 * 1024
const MANIFEST_FETCH_TIMEOUT_MS = 10_000

export class MPDParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MPDParseError'
  }
}

export interface MPDParseResult {
  isMasterPlaylist: boolean
  variants: StreamVariant[]
  segments: M3U8Segment[]
  duration: number
  isLive: boolean
  isEncrypted: boolean
  initSegmentUrl?: string
  audioSegments?: { initUrl?: string; segments: M3U8Segment[] }
  /** 每个 variant 对应的 segments 和 init URL，key 为 variants 数组的索引 */
  variantSegmentMap?: Map<number, { segments: M3U8Segment[]; initUrl?: string }>
}

// ========== 轻量 XML 解析器（纯 TS，零依赖） ==========

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

function stripNs(name: string): string {
  const i = name.indexOf(':')
  return i >= 0 ? name.substring(i + 1) : name
}

function parseXmlAttrs(str: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '')
  }
  return attrs
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * 将 MPD XML 字符串解析为 XmlNode 树。
 * 不求完备——仅覆盖 MPD 中实际出现的 XML 子集，
 * 命名空间前缀在标签名上自动去除，属性名保留原样。
 */
function parseXml(xml: string): XmlNode {
  xml = xml.replace(/<\?[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim()

  const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]

  const re = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*)>/g
  let lastIdx = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(xml)) !== null) {
    const isClose = m[1] === '/'
    const tag = stripNs(m[2])
    let rest = m[3].trim()
    const isSelfClose = !isClose && rest.endsWith('/')
    if (isSelfClose) rest = rest.slice(0, -1).trim()

    if (m.index > lastIdx) {
      const txt = decodeXmlEntities(xml.substring(lastIdx, m.index).trim())
      if (txt) {
        const parent = stack[stack.length - 1]
        parent.text = parent.text ? parent.text + ' ' + txt : txt
      }
    }
    lastIdx = m.index + m[0].length

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
    } else {
      const node: XmlNode = { tag, attrs: parseXmlAttrs(rest), children: [], text: '' }
      stack[stack.length - 1].children.push(node)
      if (!isSelfClose) stack.push(node)
    }
  }

  if (root.children.length === 0) {
    throw new MPDParseError('Invalid MPD XML: no root element found')
  }
  return root.children[0]
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter(c => c.tag === tag)
}

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find(c => c.tag === tag)
}

function hasDescendant(node: XmlNode, tag: string): boolean {
  for (const child of node.children) {
    if (child.tag === tag || hasDescendant(child, tag)) return true
  }
  return false
}

// ========== ISO 8601 Duration ==========

export function parseISO8601Duration(str: string | undefined): number {
  if (!str) return 0
  const m = str.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/
  )
  if (!m) return 0
  const days = parseInt(m[3] || '0', 10)
  const hours = parseInt(m[4] || '0', 10)
  const minutes = parseInt(m[5] || '0', 10)
  const seconds = parseFloat(m[6] || '0')
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

// ========== URL 工具 ==========

function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  try {
    return new URL(url, baseUrl).href
  } catch {
    return url
  }
}

function resolveBaseUrl(node: XmlNode, parentBaseUrl: string): string {
  const bu = findChild(node, 'BaseURL')
  return bu?.text ? resolveUrl(bu.text, parentBaseUrl) : parentBaseUrl
}

// ========== SegmentTemplate 模板变量替换 ==========

function expandTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (full, name, pad) => {
    const val = vars[name]
    if (val === undefined) return full
    const str = String(val)
    return pad ? str.padStart(parseInt(pad, 10), '0') : str
  })
}

// ========== MPDParser ==========

export class MPDParser {
  async fetchAndParse(
    url: string,
    headers?: Record<string, string>,
    options?: { requestSession?: Electron.Session; signal?: AbortSignal }
  ): Promise<MPDParseResult> {
    const content = await this.fetchContent(url, headers, options)
    return this.parse(content, url)
  }

  parse(content: string, baseUrl: string): MPDParseResult {
    const root = parseXml(content)
    if (root.tag !== 'MPD') {
      throw new MPDParseError(`Invalid MPD: root element is <${root.tag}>, expected <MPD>`)
    }

    const isLive = root.attrs.type === 'dynamic'
    const mpdDuration = parseISO8601Duration(root.attrs.mediaPresentationDuration)
    const mpdBaseUrl = resolveBaseUrl(root, baseUrl)
    const isEncrypted = hasDescendant(root, 'ContentProtection')

    const periods = findChildren(root, 'Period')
    if (periods.length === 0) {
      throw new MPDParseError('Invalid MPD: no <Period> element found')
    }

    const periodDurations = this.resolvePeriodDurations(periods, mpdDuration)

    let allVariants: StreamVariant[] = []
    const allSegments: M3U8Segment[] = []
    let firstInitUrl: string | undefined
    let audioResult: MPDParseResult['audioSegments']
    const variantSegmentMap = new Map<number, { segments: M3U8Segment[]; initUrl?: string }>()

    for (let pIdx = 0; pIdx < periods.length; pIdx++) {
      const period = periods[pIdx]
      const periodBaseUrl = resolveBaseUrl(period, mpdBaseUrl)
      const periodDuration = periodDurations[pIdx]

      const adaptationSets = findChildren(period, 'AdaptationSet')
      const videoSets = adaptationSets.filter(as => this.isMediaType(as, 'video'))
      const audioSets = adaptationSets.filter(as => this.isMediaType(as, 'audio'))

      const variantsWithSegs: Array<{
        variant: StreamVariant
        segments: M3U8Segment[]
        initUrl?: string
      }> = []

      for (const vs of videoSets) {
        const asBase = resolveBaseUrl(vs, periodBaseUrl)
        const asTpl = findChild(vs, 'SegmentTemplate')
        const asList = findChild(vs, 'SegmentList')
        const asSegBase = findChild(vs, 'SegmentBase')

        for (const rep of findChildren(vs, 'Representation')) {
          const repBase = resolveBaseUrl(rep, asBase)
          const bw = parseInt(rep.attrs.bandwidth || '0', 10)
          const w = rep.attrs.width || vs.attrs.width
          const h = rep.attrs.height || vs.attrs.height
          const resolution = w && h ? `${w}x${h}` : undefined
          const codecs = rep.attrs.codecs || vs.attrs.codecs

          const tpl = findChild(rep, 'SegmentTemplate') || asTpl
          const list = findChild(rep, 'SegmentList') || asList
          const parsed = this.parseSegments(tpl, list, rep, repBase, periodDuration, asSegBase)

          variantsWithSegs.push({
            variant: { bandwidth: bw, resolution, url: repBase, codecs },
            segments: parsed.segments,
            initUrl: parsed.initUrl
          })
        }
      }

      variantsWithSegs.sort((a, b) => b.variant.bandwidth - a.variant.bandwidth)

      if (pIdx === 0) {
        allVariants = variantsWithSegs.map(v => v.variant)
        firstInitUrl = variantsWithSegs.length > 0 ? variantsWithSegs[0].initUrl : undefined
        for (let i = 0; i < variantsWithSegs.length; i++) {
          variantSegmentMap.set(i, {
            segments: [...variantsWithSegs[i].segments],
            initUrl: variantsWithSegs[i].initUrl
          })
        }
      } else {
        for (let i = 0; i < variantsWithSegs.length && i < allVariants.length; i++) {
          const existing = variantSegmentMap.get(i)
          if (existing) {
            existing.segments.push(...variantsWithSegs[i].segments)
          }
        }
      }

      if (variantsWithSegs.length > 0) {
        allSegments.push(...variantsWithSegs[0].segments)
      }

      if (pIdx === 0 && audioSets.length > 0) {
        audioResult = this.parseBestAudioTrack(audioSets[0], periodBaseUrl, periodDuration)
      }
    }

    let duration = mpdDuration
    if (!duration) {
      duration = periodDurations.reduce((sum, d) => sum + d, 0)
    }
    if (!duration && allSegments.length > 0) {
      duration = allSegments.reduce((sum, s) => sum + s.duration, 0)
    }

    return {
      isMasterPlaylist: allVariants.length > 1,
      variants: allVariants,
      segments: allSegments,
      duration,
      isLive,
      isEncrypted,
      initSegmentUrl: firstInitUrl,
      audioSegments: audioResult,
      variantSegmentMap: variantSegmentMap.size > 0 ? variantSegmentMap : undefined
    }
  }

  toStreamInfo(result: MPDParseResult): StreamInfo {
    return {
      isMasterPlaylist: result.isMasterPlaylist,
      variants: result.variants.length > 0 ? result.variants : undefined,
      duration: result.duration > 0 ? result.duration : undefined,
      segmentCount: result.segments.length || undefined,
      isLive: result.isLive,
      isEncrypted: result.isEncrypted || undefined
    }
  }

  // ---------- 内部辅助 ----------

  private isMediaType(as: XmlNode, type: 'video' | 'audio'): boolean {
    const mime = as.attrs.mimeType || ''
    const ct = as.attrs.contentType || ''
    if (mime.startsWith(`${type}/`) || ct === type) return true
    if (!mime && !ct) {
      return findChildren(as, 'Representation').some(r =>
        (r.attrs.mimeType || '').startsWith(`${type}/`)
      )
    }
    return false
  }

  private resolvePeriodDurations(periods: XmlNode[], mpdDuration: number): number[] {
    const result: number[] = []
    for (let i = 0; i < periods.length; i++) {
      const start = parseISO8601Duration(periods[i].attrs.start)
      let duration = parseISO8601Duration(periods[i].attrs.duration)

      if (!duration) {
        if (i + 1 < periods.length && periods[i + 1].attrs.start) {
          duration = parseISO8601Duration(periods[i + 1].attrs.start) - start
        } else if (mpdDuration > 0) {
          duration = mpdDuration - start
        }
      }

      result.push(duration)
    }
    return result
  }

  private parseBestAudioTrack(
    audioSet: XmlNode,
    periodBaseUrl: string,
    periodDuration: number
  ): MPDParseResult['audioSegments'] {
    const asBase = resolveBaseUrl(audioSet, periodBaseUrl)
    const asTpl = findChild(audioSet, 'SegmentTemplate')
    const asList = findChild(audioSet, 'SegmentList')
    const asSegBase = findChild(audioSet, 'SegmentBase')

    const reps = findChildren(audioSet, 'Representation')
    let best: XmlNode | undefined
    let bestBw = -1
    for (const rep of reps) {
      const bw = parseInt(rep.attrs.bandwidth || '0', 10)
      if (bw > bestBw) { bestBw = bw; best = rep }
    }
    if (!best) return undefined

    const repBase = resolveBaseUrl(best, asBase)
    const tpl = findChild(best, 'SegmentTemplate') || asTpl
    const list = findChild(best, 'SegmentList') || asList
    const parsed = this.parseSegments(tpl, list, best, repBase, periodDuration, asSegBase)
    return { initUrl: parsed.initUrl, segments: parsed.segments }
  }

  private parseSegments(
    tpl: XmlNode | undefined,
    list: XmlNode | undefined,
    rep: XmlNode,
    baseUrl: string,
    totalDuration: number,
    asSegBase?: XmlNode
  ): { segments: M3U8Segment[]; initUrl?: string } {
    const segBase = findChild(rep, 'SegmentBase') || asSegBase
    if (segBase) {
      return {
        segments: [{ url: baseUrl, duration: totalDuration, sequence: 0 }],
        initUrl: undefined
      }
    }
    if (tpl) return this.parseSegmentTemplate(tpl, rep, baseUrl, totalDuration)
    if (list) return this.parseSegmentList(list, baseUrl)
    return { segments: [] }
  }

  private parseSegmentTemplate(
    tpl: XmlNode,
    rep: XmlNode,
    baseUrl: string,
    totalDuration: number
  ): { segments: M3U8Segment[]; initUrl?: string } {
    const mediaTpl = tpl.attrs.media || ''
    const initTpl = tpl.attrs.initialization || ''
    const timescale = parseInt(tpl.attrs.timescale || '1', 10)
    const startNumber = parseInt(tpl.attrs.startNumber || '1', 10)
    const segDur = parseInt(tpl.attrs.duration || '0', 10)

    const repId = rep.attrs.id || ''
    const repBw = rep.attrs.bandwidth || ''
    const tplVars: Record<string, string | number> = {
      RepresentationID: repId,
      Bandwidth: repBw
    }

    let initUrl: string | undefined
    if (initTpl) {
      initUrl = resolveUrl(expandTemplate(initTpl, tplVars), baseUrl)
    }

    const segments: M3U8Segment[] = []

    const timeline = findChild(tpl, 'SegmentTimeline')
    if (timeline) {
      this.parseTimeline(timeline, mediaTpl, tplVars, timescale, startNumber, totalDuration, baseUrl, segments)
    } else if (segDur > 0 && totalDuration > 0) {
      const segSec = segDur / timescale
      const segCount = Math.ceil(totalDuration / segSec)
      for (let i = 0; i < segCount; i++) {
        const seq = startNumber + i
        const remaining = totalDuration - i * segSec
        segments.push({
          url: resolveUrl(expandTemplate(mediaTpl, { ...tplVars, Number: seq }), baseUrl),
          duration: remaining < segSec ? remaining : segSec,
          sequence: seq
        })
      }
    }

    return { segments, initUrl }
  }

  private parseTimeline(
    timeline: XmlNode,
    mediaTpl: string,
    tplVars: Record<string, string | number>,
    timescale: number,
    startNumber: number,
    totalDuration: number,
    baseUrl: string,
    segments: M3U8Segment[]
  ): void {
    const entries = findChildren(timeline, 'S')
    let time = 0
    let seq = startNumber

    for (let j = 0; j < entries.length; j++) {
      const s = entries[j]
      const t = s.attrs.t !== undefined ? parseInt(s.attrs.t, 10) : undefined
      const d = parseInt(s.attrs.d || '0', 10)
      const r = parseInt(s.attrs.r || '0', 10)

      if (t !== undefined) time = t

      let count: number
      if (r >= 0) {
        count = r + 1
      } else {
        // r=-1: 重复到下一个 S 的 t，或 Period 结束
        const nextT = entries[j + 1]?.attrs.t !== undefined
          ? parseInt(entries[j + 1].attrs.t, 10)
          : undefined
        if (nextT !== undefined && d > 0) {
          count = Math.ceil((nextT - time) / d)
        } else if (totalDuration > 0 && d > 0) {
          count = Math.ceil((totalDuration * timescale - time) / d)
        } else {
          count = 1
        }
      }

      for (let i = 0; i < count; i++) {
        segments.push({
          url: resolveUrl(
            expandTemplate(mediaTpl, { ...tplVars, Number: seq, Time: time }),
            baseUrl
          ),
          duration: d / timescale,
          sequence: seq
        })
        time += d
        seq++
      }
    }
  }

  private parseSegmentList(
    list: XmlNode,
    baseUrl: string
  ): { segments: M3U8Segment[]; initUrl?: string } {
    const dur = parseInt(list.attrs.duration || '0', 10)
    const ts = parseInt(list.attrs.timescale || '1', 10)
    const segSec = ts > 0 ? dur / ts : 0

    let initUrl: string | undefined
    const initNode = findChild(list, 'Initialization')
    if (initNode?.attrs.sourceURL) {
      initUrl = resolveUrl(initNode.attrs.sourceURL, baseUrl)
    }

    const segments: M3U8Segment[] = []
    for (const [i, su] of findChildren(list, 'SegmentURL').entries()) {
      const media = su.attrs.media || su.attrs.mediaURL || ''
      if (media) {
        segments.push({
          url: resolveUrl(media, baseUrl),
          duration: segSec,
          sequence: i
        })
      }
    }

    return { segments, initUrl }
  }

  // ---------- 网络请求（对标 M3U8Parser.fetchContent） ----------

  private fetchContent(
    url: string,
    headers?: Record<string, string>,
    options?: { requestSession?: Electron.Session; signal?: AbortSignal }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request(buildNetRequestOptions(url, options?.requestSession))
        let timeoutId: ReturnType<typeof setTimeout>
        let settled = false
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          options?.signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const onAbort = () => {
          clearTimeout(timeoutId)
          try { request.abort() } catch {}
          finish(() => reject(new Error('MPD fetch aborted')))
        }

        if (headers) {
          for (const [key, value] of Object.entries(headers)) {
            request.setHeader(key, value)
          }
        }

        const chunks: Buffer[] = []
        let totalSize = 0

        timeoutId = setTimeout(() => {
          try { request.abort() } catch {}
          finish(() => reject(new Error(`MPD fetch timeout (${MANIFEST_FETCH_TIMEOUT_MS}ms)`)))
        }, MANIFEST_FETCH_TIMEOUT_MS)

        if (options?.signal?.aborted) {
          onAbort()
          return
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true })

        request.on('response', (response) => {
          const statusCode: number = (response as any).statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300) {
            clearTimeout(timeoutId)
            try { request.abort() } catch {}
            finish(() => reject(new Error(`MPD fetch failed: HTTP ${statusCode} for ${url}`)))
            return
          }

          response.on('data', (chunk) => {
            if (settled) return
            totalSize += chunk.length
            if (totalSize > MANIFEST_MAX_SIZE) {
              clearTimeout(timeoutId)
              try { request.abort() } catch {}
              finish(() => reject(new Error(`MPD too large: ${totalSize} bytes`)))
              return
            }
            chunks.push(chunk)
          })

          response.on('end', () => {
            clearTimeout(timeoutId)
            finish(() => resolve(Buffer.concat(chunks).toString('utf8')))
          })

          response.on('error', (err) => {
            clearTimeout(timeoutId)
            finish(() => reject(err))
          })
        })

        request.on('error', (err) => {
          clearTimeout(timeoutId)
          finish(() => reject(err))
        })

        request.end()
      } catch (err) {
        reject(err)
      }
    })
  }
}

let instance: MPDParser | null = null

export function getMPDParser(): MPDParser {
  if (!instance) {
    instance = new MPDParser()
  }
  return instance
}
