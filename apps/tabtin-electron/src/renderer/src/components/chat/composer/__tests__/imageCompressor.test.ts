import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_IMAGE_JPEG_QUALITY,
  compressChatImageIfNeeded,
  type ChatImageCompressionReason,
  type ChatImageDimension,
  type ChatImageFileSnapshot,
  type CanvasFactory,
  type ImageBitmapFactory,
} from '../imageCompressor'

const MB = 1024 * 1024

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 123 })
}

/**
 * 构造一个真 RIFF/WEBP/VP8X 头 + ANIM flag 置位的字节流——
 * `isAnimatedWebp` 严格按 chunk 扫描判定，不能用"字节里包含 ANIM 字符串"
 * 这种朴素 fixture（合法静态 WebP 元数据也可能含 'ANIM' 子串导致误判反而
 * 通过，反而掩盖回归）。
 */
function makeAnimatedWebpFile(): File {
  const bytes = new Uint8Array(32)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x18, 0x00, 0x00, 0x00], 4) // size = 24
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X chunk type
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16) // VP8X chunk size = 10
  bytes[20] = 0x02 // VP8X flag byte：第 2 位 = ANIM
  return new File([bytes], 'motion.webp', { type: 'image/webp', lastModified: 123 })
}

/**
 * 构造一个真 PNG 签名 + acTL chunk 在 IDAT 之前的字节流，
 * `isAnimatedPng` 必须按 chunk 长度跳跃才能命中 acTL（朴素 includes 会被
 * tEXt chunk 的 'acTL' 字符串误命中通过，反而把回归隐藏）。
 */
function makeAnimatedPngFile(): File {
  const bytes = new Uint8Array(40)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR chunk 长度 0（fixture 不需要真数据，只要 chunk 头 + 长度）
  bytes.set([0x00, 0x00, 0x00, 0x00], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12) // 'IHDR'
  bytes.set([0x00, 0x00, 0x00, 0x00], 16) // CRC 占位
  // 跳到下一个 chunk header：offset = 8 + 12 + 0 = 20
  bytes.set([0x00, 0x00, 0x00, 0x00], 20) // chunk size = 0
  bytes.set([0x61, 0x63, 0x54, 0x4c], 24) // 'acTL'
  bytes.set([0x00, 0x00, 0x00, 0x00], 28) // CRC 占位
  return new File([bytes], 'motion.png', { type: 'image/png', lastModified: 123 })
}

function makeDeps(options: {
  width?: number
  height?: number
  outputSize?: number
  failDecode?: boolean
}) {
  const drawImage = vi.fn()
  const close = vi.fn()
  const convertToBlob = vi.fn(async (blobOptions?: ImageEncodeOptions) => (
    new Blob([new Uint8Array(options.outputSize ?? 256 * 1024)], {
      type: blobOptions?.type ?? 'image/jpeg',
    })
  ))
  const createBitmap: ImageBitmapFactory = vi.fn(async () => {
    if (options.failDecode) throw new Error('decode failed')
    return {
      width: options.width ?? 1200,
      height: options.height ?? 800,
      close,
    } as unknown as ImageBitmap
  }) as unknown as ImageBitmapFactory
  const createCanvas: CanvasFactory = vi.fn((width: number, height: number) => ({
    width,
    height,
    getContext: vi.fn(() => ({ drawImage })),
    convertToBlob,
  }) as unknown as OffscreenCanvas) as unknown as CanvasFactory

  return {
    deps: { createBitmap, createCanvas } as { createBitmap: ImageBitmapFactory; createCanvas: CanvasFactory },
    createBitmap,
    createCanvas,
    convertToBlob,
    drawImage,
    close,
  }
}

describe('compressChatImageIfNeeded', () => {
  it('小图保持原文件，不做压缩（reason=below-threshold）', async () => {
    const file = makeFile('small.jpg', 'image/jpeg', 600 * 1024)
    const mocks = makeDeps({ width: 1200, height: 800 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.file).toBe(file)
    expect(result.reason).toBe('below-threshold')
    expect(result.log?.original).toMatchObject({
      width: 1200,
      height: 800,
      size: file.size,
    })
    expect(mocks.createCanvas).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalled()
  })

  it('大 JPEG 长边超过 2048 时缩放并按 0.85 质量输出 JPEG（reason=resize-required）', async () => {
    const file = makeFile('huge.jpg', 'image/jpeg', 8 * MB)
    const mocks = makeDeps({ width: 4000, height: 2000, outputSize: 900 * 1024 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(true)
    expect(result.reason).toBe('resize-required')
    expect(result.file).not.toBe(file)
    expect(result.file.name).toBe('huge.jpg')
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.size).toBe(900 * 1024)
    expect(mocks.createCanvas).toHaveBeenCalledWith(2048, 1024)
    expect(mocks.convertToBlob).toHaveBeenCalledWith({
      type: 'image/jpeg',
      quality: CHAT_IMAGE_JPEG_QUALITY,
    })
    expect(result.log).toMatchObject({
      original: { width: 4000, height: 2000, size: 8 * MB },
      output: { width: 2048, height: 1024, size: 900 * 1024 },
    })
  })

  it('已是 WebP 的大图转为 JPEG，并修正文件扩展名', async () => {
    const file = makeFile('preview.webp', 'image/webp', 6 * MB)
    const mocks = makeDeps({ width: 3000, height: 1500, outputSize: 700 * 1024 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(true)
    expect(result.file.name).toBe('preview.jpg')
    expect(result.file.type).toBe('image/jpeg')
    expect(result.log?.output).toMatchObject({
      filename: 'preview.jpg',
      mimeType: 'image/jpeg',
      width: 2048,
      height: 1024,
    })
  })

  it('动画 WebP 直接跳过，避免压成静态首帧（reason=animated-image）', async () => {
    const file = makeAnimatedWebpFile()
    const mocks = makeDeps({ width: 3000, height: 1500 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.file).toBe(file)
    expect(result.reason).toBe('animated-image')
    expect(mocks.createBitmap).not.toHaveBeenCalled()
  })

  it('动画 PNG（acTL chunk）也识别为 animated-image，不被 drawImage 压成首帧', async () => {
    const file = makeAnimatedPngFile()
    const mocks = makeDeps({ width: 800, height: 600 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.reason).toBe('animated-image')
    expect(mocks.createBitmap).not.toHaveBeenCalled()
  })

  it('PNG 大图只缩放并保持 PNG 格式（reason=resize-required，但 outputMime=PNG）', async () => {
    const file = makeFile('diagram.png', 'image/png', 7 * MB)
    const mocks = makeDeps({ width: 4096, height: 2048, outputSize: 2 * MB })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(true)
    expect(result.reason).toBe('resize-required')
    expect(result.file.name).toBe('diagram.png')
    expect(result.file.type).toBe('image/png')
    expect(mocks.createCanvas).toHaveBeenCalledWith(2048, 1024)
    expect(mocks.convertToBlob).toHaveBeenCalledWith({
      type: 'image/png',
      quality: undefined,
    })
  })

  it('PNG 长边 ≤ 2048 但文件 > 5MB（高码率 PNG），触发 png-preserved 而非 large-file', async () => {
    // 长边 2048（≤ 阈值，不会 resize）+ 6MB（> 5MB，会强制压缩）
    const file = makeFile('hi-density.png', 'image/png', 6 * MB)
    const mocks = makeDeps({ width: 2048, height: 1500, outputSize: 1.5 * MB })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(true)
    expect(result.reason).toBe('png-preserved')
    expect(result.file.type).toBe('image/png')
    expect(mocks.convertToBlob).toHaveBeenCalledWith({
      type: 'image/png',
      quality: undefined,
    })
  })

  it('JPEG 长边 ≤ 2048 但文件 > 5MB，触发 large-file（区别于 resize-required）', async () => {
    const file = makeFile('thick.jpg', 'image/jpeg', 6 * MB)
    const mocks = makeDeps({ width: 2048, height: 1500, outputSize: 1.5 * MB })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(true)
    expect(result.reason).toBe('large-file')
    expect(result.file.type).toBe('image/jpeg')
  })

  it('GIF 直接跳过（unsupported-mime），不解码不绘 canvas', async () => {
    const file = makeFile('motion.gif', 'image/gif', 10 * MB)
    const mocks = makeDeps({ width: 3200, height: 1800 })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.file).toBe(file)
    expect(result.reason).toBe('unsupported-mime')
    expect(mocks.createBitmap).not.toHaveBeenCalled()
    expect(mocks.createCanvas).not.toHaveBeenCalled()
  })

  it('HEIC 同样跳过（unsupported-mime），不强行解码', async () => {
    const file = makeFile('photo.heic', 'image/heic', 4 * MB)
    const mocks = makeDeps({})
    const result = await compressChatImageIfNeeded(file, mocks.deps)
    expect(result.compressed).toBe(false)
    expect(result.reason).toBe('unsupported-mime')
  })

  it('非图片 MIME（application/pdf）不进压缩流程（reason=not-image）', async () => {
    const file = makeFile('report.pdf', 'application/pdf', 800 * 1024)
    const mocks = makeDeps({})
    const result = await compressChatImageIfNeeded(file, mocks.deps)
    expect(result.compressed).toBe(false)
    expect(result.reason).toBe('not-image')
    expect(mocks.createBitmap).not.toHaveBeenCalled()
  })

  it('损坏图片解码失败时回退原图，不阻断上传（reason=compression-failed）', async () => {
    const file = makeFile('broken.jpg', 'image/jpeg', 7 * MB)
    const mocks = makeDeps({ failDecode: true })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.file).toBe(file)
    expect(result.reason).toBe('compression-failed')
    expect(result.error).toBeInstanceOf(Error)
    expect(mocks.createCanvas).not.toHaveBeenCalled()
  })

  it('压缩后文件比原图大且未 resize → not-beneficial 回退原图', async () => {
    const file = makeFile('compact.jpg', 'image/jpeg', 6 * MB)
    // outputSize > 6MB → 触发 not-beneficial 路径；source 长边 == 阈值 → 不 resize
    const mocks = makeDeps({ width: 2048, height: 1024, outputSize: 7 * MB })

    const result = await compressChatImageIfNeeded(file, mocks.deps)

    expect(result.compressed).toBe(false)
    expect(result.file).toBe(file)
    expect(result.reason).toBe('not-beneficial')
  })
})

describe('类型契约：公开类型能被消费方静态约束', () => {
  it('reason 联合类型覆盖 9 个语义清晰的字面量', () => {
    const reasons: ChatImageCompressionReason[] = [
      'resize-required',
      'large-file',
      'png-preserved',
      'below-threshold',
      'unsupported-mime',
      'animated-image',
      'not-image',
      'not-beneficial',
      'compression-failed',
    ]
    expect(reasons).toHaveLength(9)
  })

  it('ChatImageDimension / ChatImageFileSnapshot 暴露给 chatAttachmentApi 日志层使用', () => {
    const dim: ChatImageDimension = { width: 100, height: 50 }
    const snap: ChatImageFileSnapshot = {
      ...dim,
      size: 1024,
      mimeType: 'image/png',
      filename: 'a.png',
    }
    expect(snap.width).toBe(100)
    expect(snap.filename).toBe('a.png')
  })
})
