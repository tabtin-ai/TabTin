/**
 * imageCompressor — 聊天附件图片压缩 / 缩放 / 跳过决策。
 *
 * 调用方：`chatAttachmentApi.uploadChatAttachment` 在走 OSS 直传前先过本模块，
 * 把"过大 / 过宽 / 上游不支持"的图片在浏览器里就地处理掉，避免：
 *   - 客户端把 30MB 截图直接灌到 OSS 触发 5MB 上游 image fetch 上限；
 *   - 上游 LLM 把 4096px 图片缩放成 256x256 丢失细节；
 *   - GIF / 动 PNG / 动 WebP 被 canvas drawImage 压成"静态首帧"用户莫名其妙。
 *
 * 设计取向：
 *   - **决策语义化**：返回的 `reason` 枚举要让调用方一眼看出"为什么没压 / 压了"
 *     （`large-file` ≠ `resize-required` ≠ `png-preserved`），而不是统统标
 *     `'size-required'` 把语义压扁成一坨——后者会让日志排查 + 产品 dashboard 失
 *     去信号。
 *   - **动图安全**：用真 chunk 扫描（WebP VP8X ANIM 标志位 / 动 PNG acTL chunk）
 *     而非"字节数组里包含 ANIM 字符串"——后者会被合法静态图的 metadata 误命中。
 *   - **失败优雅**：解码失败 / canvas 不可用时回退原图（reason='compression-failed'），
 *     不阻断上传链路。让 chatAttachmentApi 把错误日志记下，用户感知不到。
 */

const MB = 1024 * 1024

export const CHAT_IMAGE_MAX_EDGE = 2048
export const CHAT_IMAGE_JPEG_QUALITY = 0.85
export const CHAT_IMAGE_FORCE_COMPRESS_BYTES = 5 * MB
export const CHAT_IMAGE_SKIP_SMALL_BYTES = 1 * MB

type CanvasLike =
  | OffscreenCanvas
  | HTMLCanvasElement

type BitmapLike = ImageBitmap & {
  close?: () => void
}

/** 公开类型：让宿主单元测试 / 集成测试可以 mock canvas / bitmap 工厂。 */
export type CanvasFactory = (width: number, height: number) => CanvasLike
export type ImageBitmapFactory = (file: File) => Promise<BitmapLike>

export interface ChatImageCompressionDeps {
  createBitmap?: ImageBitmapFactory
  createCanvas?: CanvasFactory
}

/** 公开类型：图片尺寸 (width, height)。被 log + 上层缓存共用。 */
export interface ChatImageDimension {
  width: number
  height: number
}

/**
 * 公开类型：原文件 / 输出文件的快照——日志、preview cache、UI 预览图都依赖
 * 这套字段。改字段名要同步 `chatAttachmentApi.logImageCompressionResult`。
 */
export interface ChatImageFileSnapshot extends ChatImageDimension {
  size: number
  mimeType: string
  filename: string
}

export interface ChatImageCompressionLog {
  original: ChatImageFileSnapshot
  output: ChatImageFileSnapshot
  reason: ChatImageCompressionReason
}

/**
 * 决策原因枚举——9 类语义清晰的状态。**禁止压扁**为 `size-required` 这类
 * 模糊统称：调用方按 reason 决定日志级别（compressed=info / fail=warn /
 * kept=debug）+ 产品 dashboard 信号（e.g. "本周 PNG 透明保留率 vs JPEG 压缩率"）。
 *
 * - `resize-required`：图片长边 > 2048，被 resize（仍可能跨 mime 转 JPEG）；
 * - `large-file`：图片长边 ≤ 2048，但文件 ≥ 5MB（强制 lossy 压缩，主要是高码率 PNG）；
 * - `png-preserved`：PNG 输入触发压缩——保留 PNG 格式（lossless），不转 JPEG；
 * - `below-threshold`：< 1MB 小图 + 长边 ≤ 2048 → 直接跳过；
 * - `unsupported-mime`：上游不接受的 image/* 子类型（GIF / SVG / HEIC / HEIF）；
 * - `animated-image`：动图（GIF / animated WebP / animated PNG）——drawImage 会
 *   压成静态首帧，必须跳过；
 * - `not-image`：MIME 不是 image/*，不该走压缩路径；
 * - `not-beneficial`：压完反而比原文件大（小尺寸高质量 JPEG 转编码常见）；
 * - `compression-failed`：解码 / canvas 异常——回退原图，不阻断上传。
 */
export type ChatImageCompressionReason =
  | 'resize-required'
  | 'large-file'
  | 'png-preserved'
  | 'below-threshold'
  | 'unsupported-mime'
  | 'animated-image'
  | 'not-image'
  | 'not-beneficial'
  | 'compression-failed'

export interface ChatImageCompressionResult {
  file: File
  compressed: boolean
  log?: ChatImageCompressionLog
  reason: ChatImageCompressionReason
  error?: unknown
}

/**
 * 上游 LLM / OSS 不接受的 image/* 子类型。命中即跳过压缩并标
 * `unsupported-mime`，让调用方决定是否拒绝整次上传或原样直传。
 *
 * - GIF / SVG：上游模型多半不处理（GIF 只取首帧，SVG 当成 XML）。
 * - HEIC / HEIF：iOS 17+ 默认相册格式，浏览器 createImageBitmap
 *   解码失败率高，统一跳过让用户先转 JPG。
 */
const SKIP_MIMES = new Set([
  'image/gif',
  'image/svg+xml',
  'image/heic',
  'image/heif',
])

/**
 * 命中即被转成 lossy 输出（output mime = image/jpeg）。包含 webp / bmp /
 * tiff / avif 等"上游可能不支持原格式但能接受 JPEG"的格式。
 */
const LOSSY_OUTPUT_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/bmp',
  'image/x-ms-bmp',
  'image/avif',
  'image/tiff',
])

function normalizeMime(mimeType: string): string {
  return mimeType.trim().toLowerCase()
}

function isChatCompressibleImage(mimeType: string): boolean {
  const normalized = normalizeMime(mimeType)
  return normalized.startsWith('image/') && !SKIP_MIMES.has(normalized)
}

function resolveTargetSize(width: number, height: number): ChatImageDimension {
  const longEdge = Math.max(width, height)
  if (longEdge <= CHAT_IMAGE_MAX_EDGE) {
    return { width, height }
  }

  const scale = CHAT_IMAGE_MAX_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function shouldCompress(file: File, source: ChatImageDimension): boolean {
  const longEdge = Math.max(source.width, source.height)
  if (longEdge > CHAT_IMAGE_MAX_EDGE) return true
  if (file.size >= CHAT_IMAGE_FORCE_COMPRESS_BYTES) return true
  return false
}

function resolveSkipReason(file: File, source?: ChatImageDimension): ChatImageCompressionReason {
  const mimeType = normalizeMime(file.type)
  if (!mimeType.startsWith('image/')) return 'not-image'
  if (!isChatCompressibleImage(mimeType)) return 'unsupported-mime'
  if (source && file.size < CHAT_IMAGE_SKIP_SMALL_BYTES && Math.max(source.width, source.height) <= CHAT_IMAGE_MAX_EDGE) {
    return 'below-threshold'
  }
  return 'not-beneficial'
}

function resolveOutputMime(inputMime: string): string {
  const normalized = normalizeMime(inputMime)
  if (normalized === 'image/png') return 'image/png'
  if (LOSSY_OUTPUT_MIMES.has(normalized)) return 'image/jpeg'
  return normalized
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  let value = ''
  for (let i = offset; i < offset + length; i++) {
    value += String.fromCharCode(bytes[i])
  }
  return value
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0
  return (
    ((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0
}

/**
 * 真 WebP chunk 扫描判定动图——按 RIFF/WEBP/VP8X 规范读 ANIM chunk
 * 或 VP8X 帧 flag 第 2 位（B-bit）。
 *
 * 不用 `bytes.includes('ANIM')` 这类朴素匹配：合法静态 WebP 元数据里如果
 * 含 ICCP / EXIF 段恰好包含 'ANIM' 字符串会误判。
 */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') return false

  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkType = readAscii(bytes, offset, 4)
    const chunkSize = readUint32LE(bytes, offset + 4)
    const dataOffset = offset + 8
    if (chunkType === 'ANIM') return true
    if (chunkType === 'VP8X' && dataOffset < bytes.length && (bytes[dataOffset] & 0x02) !== 0) return true
    if (chunkSize <= 0) break
    offset = dataOffset + chunkSize + (chunkSize % 2)
  }

  return false
}

/**
 * 真 PNG chunk 扫描判定动图——找 acTL chunk（必须出现在 IDAT 之前）。
 *
 * 与 WebP 同理：不能用 `headerIncludesAscii('acTL')`，PNG tEXt chunk 里的元
 * 信息可能恰好含 "acTL" 字符串。这里严格按 chunk 长度跳跃，遇到 IDAT / IEND
 * 即停止扫描。
 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  const hasPngSignature =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    readAscii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  if (!hasPngSignature) return false

  let offset = 8
  while (offset + 12 <= bytes.length) {
    const chunkSize = readUint32BE(bytes, offset)
    const chunkType = readAscii(bytes, offset + 4, 4)
    if (chunkType === 'acTL') return true
    if (chunkType === 'IDAT' || chunkType === 'IEND') return false
    offset += 12 + chunkSize
  }

  return false
}

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('Blob arrayBuffer is not available'))
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(new Error('Blob read result is not ArrayBuffer'))
      }
    }
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * 已知的"按字节序列判定"动图入口：
 *   - GIF / APNG MIME → 直接 true（GIF 永远是动图，APNG MIME 已是规范信号）；
 *   - WebP / PNG → 读前 512KB chunk 扫描；
 *   - 其他格式（JPEG / BMP / TIFF / AVIF 等）当前不识别动 AVIF / TIFF——
 *     这些产线占比极低，命中率不足以为它们写专门的扫描器。如未来踩到坑，
 *     在此扩展新分支即可，不要污染上层。
 */
async function isKnownAnimatedRaster(file: File, mimeType: string): Promise<boolean> {
  const normalized = normalizeMime(mimeType)
  if (normalized === 'image/gif' || normalized === 'image/apng') return true
  if (normalized !== 'image/webp' && normalized !== 'image/png') return false

  try {
    const bytes = new Uint8Array(await readBlobArrayBuffer(file.slice(0, 512 * 1024)))
    if (normalized === 'image/webp') return isAnimatedWebp(bytes)
    return isAnimatedPng(bytes)
  } catch {
    return false
  }
}

function replaceExtension(filename: string, mimeType: string): string {
  if (mimeType !== 'image/jpeg') return filename
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  return `${base}.jpg`
}

/**
 * 触发压缩后的 reason 决策：
 *   - 长边超 2048 → `resize-required`（这是主要驱动力）
 *   - PNG 输入 → `png-preserved`（保 PNG 输出 lossless，区别于 lossy 的 JPEG）
 *   - 其他（高码率 JPEG / WebP）→ `large-file`（纯 size-driven，非 resize-driven）
 *
 * 这三个 reason 的语义对调用方不可替代——`resize-required` 触发尺寸缩放、
 * `png-preserved` 走 lossless 路径、`large-file` 走 lossy 路径。压扁会丢信号。
 */
function resolveCompressionReason(file: File, source: ChatImageDimension): ChatImageCompressionReason {
  if (Math.max(source.width, source.height) > CHAT_IMAGE_MAX_EDGE) return 'resize-required'
  if (normalizeMime(file.type) === 'image/png') return 'png-preserved'
  return 'large-file'
}

async function defaultCreateBitmap(file: File): Promise<BitmapLike> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is not available')
  }
  return createImageBitmap(file)
}

function defaultCreateCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }

  if (typeof document === 'undefined') {
    throw new Error('Canvas is not available')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function get2dContext(canvas: CanvasLike): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas 2d context is not available')
  }
  return context
}

function canvasToBlob(canvas: CanvasLike, mimeType: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality })
  }

  if ('toBlob' in canvas && typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
        mimeType,
        quality,
      )
    })
  }

  throw new Error('Canvas blob export is not available')
}

export async function compressChatImageIfNeeded(
  file: File,
  deps: ChatImageCompressionDeps = {},
): Promise<ChatImageCompressionResult> {
  const inputMime = normalizeMime(file.type)

  if (!inputMime.startsWith('image/') || !isChatCompressibleImage(inputMime)) {
    return {
      file,
      compressed: false,
      reason: resolveSkipReason(file),
    }
  }

  let bitmap: BitmapLike | undefined
  try {
    if (await isKnownAnimatedRaster(file, inputMime)) {
      return {
        file,
        compressed: false,
        reason: 'animated-image',
      }
    }

    bitmap = await (deps.createBitmap ?? defaultCreateBitmap)(file)
    const source = { width: bitmap.width, height: bitmap.height }

    if (!shouldCompress(file, source)) {
      return {
        file,
        compressed: false,
        reason: resolveSkipReason(file, source),
        log: {
          reason: resolveSkipReason(file, source),
          original: {
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            ...source,
          },
          output: {
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            ...source,
          },
        },
      }
    }

    const target = resolveTargetSize(source.width, source.height)
    const canvas = (deps.createCanvas ?? defaultCreateCanvas)(target.width, target.height)
    const context = get2dContext(canvas)
    context.drawImage(bitmap, 0, 0, target.width, target.height)

    const outputMime = resolveOutputMime(file.type)
    const outputBlob = await canvasToBlob(
      canvas,
      outputMime,
      outputMime === 'image/jpeg' ? CHAT_IMAGE_JPEG_QUALITY : undefined,
    )
    const outputName = replaceExtension(file.name, outputMime)
    const outputFile = new File([outputBlob], outputName, {
      type: outputBlob.type || outputMime,
      lastModified: file.lastModified,
    })

    const reason = resolveCompressionReason(file, source)
    const log: ChatImageCompressionLog = {
      reason,
      original: {
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        ...source,
      },
      output: {
        filename: outputFile.name,
        mimeType: outputFile.type,
        size: outputFile.size,
        ...target,
      },
    }

    if (outputFile.size >= file.size && target.width === source.width && target.height === source.height) {
      return {
        file,
        compressed: false,
        reason: 'not-beneficial',
        log: {
          ...log,
          reason: 'not-beneficial',
          output: {
            filename: file.name,
            mimeType: file.type,
            size: file.size,
            ...source,
          },
        },
      }
    }

    return {
      file: outputFile,
      compressed: true,
      reason,
      log,
    }
  } catch (error) {
    return {
      file,
      compressed: false,
      reason: 'compression-failed',
      error,
    }
  } finally {
    bitmap?.close?.()
  }
}
