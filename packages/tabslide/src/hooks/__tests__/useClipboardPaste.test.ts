/**
 * useClipboardPaste 单元测试
 *
 * 覆盖：
 * - tryPasteClipboardText — 读取 text/html 并清理后插入文本元素
 * - tryPasteClipboardText — 降级到 readText() 并转换为 HTML 段落
 * - tryPasteClipboardText — clipboard API 不可用时返回 false
 * - tryPasteClipboardImage — 读取图片文件并触发插入
 * - tryPasteClipboardImage — 校验失败调用 onError
 * - 外部 paste 事件 — 图片优先，HTML 其次，纯文本兜底
 * - 外部 paste 事件 — isEditableTarget 时跳过处理
 * - presentation 未初始化时防御
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── React mock：让 hook 可在非组件上下文直接调用 ──
vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof import('react')>()
  return {
    ...actual,
    useCallback: <T>(fn: T) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
  }
})

// ── 工具模块 mock ──
vi.mock('../../utils/id', () => ({
  createElementId: vi.fn(() => `el_paste_mock`),
  regenerateNestedIds: vi.fn(),
}))

vi.mock('../../utils/sanitize', () => ({
  sanitizeHtml: vi.fn((html: string) => html.trim() ? `[sanitized]${html}` : ''),
  sanitizeCssValue: vi.fn((v: string) => v),
  isSafeSrcUrl: vi.fn(() => true),
}))

const mockHasClipboardImage = vi.fn(() => false)
const mockIsEditableTarget = vi.fn(() => false)
const mockExtractImageFile = vi.fn(() => null as File | null)
const mockReadClipboardImageFile = vi.fn(async () => null as File | null)
const mockCreateImageElement = vi.fn(async (src: string) => ({
  id: 'el_paste_mock',
  type: 'image' as const,
  x: 760, y: 390, width: 400, height: 300,
  rotate: 0, opacity: 1, locked: false, fixedRatio: true, src,
}))
const mockResolveImageSrc = vi.fn(async (_file: File) => ({
  src: 'data:image/png;base64,mock',
  fallback: false,
}))
const mockValidateImageFile = vi.fn(() => ({ valid: true } as { valid: boolean; reason?: string }))

vi.mock('../../utils/image', () => ({
  hasClipboardImage: mockHasClipboardImage,
  isEditableTarget: mockIsEditableTarget,
  extractImageFile: mockExtractImageFile,
  readClipboardImageFile: mockReadClipboardImageFile,
  createImageElement: mockCreateImageElement,
  resolveImageSrc: mockResolveImageSrc,
  validateImageFile: mockValidateImageFile,
}))

// ── Store mock ──
const mockAddElement = vi.fn()
const mockPushSnapshot = vi.fn()

vi.mock('../../store/slide', () => ({
  useSlideStore: {
    getState: vi.fn(() => ({
      presentation: {
        pages: [{ id: 'page_1', elements: [] }],
        canvasWidth: 1920,
        canvasHeight: 1080,
        theme: { fontName: 'Arial', fontColor: '#000' },
      },
      addElement: mockAddElement,
    })),
    setState: vi.fn(),
  },
}))

vi.mock('../../store/history', () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      pushSnapshot: mockPushSnapshot,
    })),
  },
}))

// ── 辅助：模拟 navigator.clipboard ──

function stubNavigatorClipboard(impl: {
  read?: () => Promise<unknown[]>
  readText?: () => Promise<string>
} | null): void {
  const obj = impl
    ? {
        read: impl.read,
        readText: impl.readText ?? (async () => ''),
      }
    : undefined

  Object.defineProperty(globalThis, 'navigator', {
    value: obj !== undefined ? { clipboard: obj } : {},
    writable: true,
    configurable: true,
  })
}

function restoreNavigator(): void {
  // 恢复 navigator 为 getter（Node.js 原始行为）
  // 这里仅保证测试间不污染
  Object.defineProperty(globalThis, 'navigator', {
    value: undefined,
    writable: true,
    configurable: true,
  })
}

// ── 辅助：捕获 document.addEventListener('paste', handler) ──

type PasteHandler = (e: ClipboardEvent) => void | Promise<void>

function capturePasteHandler(): { getHandler: () => PasteHandler | null; restore: () => void } {
  let captured: PasteHandler | null = null
  const originalAdd = document.addEventListener.bind(document)
  const originalRemove = document.removeEventListener.bind(document)

  vi.spyOn(document, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'paste') captured = handler as PasteHandler
    else originalAdd(type, handler as EventListener)
  })
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, handler) => {
    if (type === 'paste') captured = null
    else originalRemove(type, handler as EventListener)
  })

  return {
    getHandler: () => captured,
    restore: () => {
      vi.mocked(document.addEventListener).mockRestore()
      vi.mocked(document.removeEventListener).mockRestore()
    },
  }
}

// ──────────────────────────────────────────────

describe('useClipboardPaste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasClipboardImage.mockReturnValue(false)
    mockIsEditableTarget.mockReturnValue(false)
    mockExtractImageFile.mockReturnValue(null)
    mockReadClipboardImageFile.mockResolvedValue(null)
    mockValidateImageFile.mockReturnValue({ valid: true })
    mockCreateImageElement.mockImplementation(async (src: string) => ({
      id: 'el_paste_mock', type: 'image' as const,
      x: 760, y: 390, width: 400, height: 300,
      rotate: 0, opacity: 1, locked: false, fixedRatio: true, src,
    }))
    mockResolveImageSrc.mockResolvedValue({ src: 'data:image/png;base64,mock', fallback: false })
    restoreNavigator()
  })

  afterEach(() => {
    restoreNavigator()
  })

  // ────────────────────────────────────
  //  tryPasteClipboardText
  // ────────────────────────────────────

  describe('tryPasteClipboardText()', () => {
    it('读取 text/html 成功时插入经过 sanitize 的文本元素', async () => {
      // 注意：使用带 .text() 方法的对象替代 real Blob（Vitest/Node.js 环境中 Blob.text() 行为不稳定）
      const htmlContent = '<b>Hello World</b>'
      const mockItem = {
        types: ['text/html'],
        getType: vi.fn(async () => ({ text: async () => htmlContent })),
      }

      stubNavigatorClipboard({
        read: async () => [mockItem],
        readText: async () => '',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardText as () => Promise<boolean>)()

      expect(result).toBe(true)
      expect(mockAddElement).toHaveBeenCalledOnce()
      expect(mockPushSnapshot).toHaveBeenCalledOnce()

      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.type).toBe('text')
      expect(insertedEl.content).toContain('[sanitized]')
    })

    it('text/html 内容为空时降级到 readText() 并转换为 HTML 段落', async () => {
      // 返回空白 blob，sanitizeHtml 会返回 ''（mock: empty trim → ''）
      const emptyBlob = new Blob([''], { type: 'text/html' })
      const mockItem = {
        types: ['text/html'],
        getType: vi.fn(async () => emptyBlob),
      }

      stubNavigatorClipboard({
        read: async () => [mockItem],
        readText: async () => 'Hello\nWorld',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardText as () => Promise<boolean>)()

      expect(result).toBe(true)
      expect(mockAddElement).toHaveBeenCalledOnce()
      const insertedEl = mockAddElement.mock.calls[0][0]
      // 纯文本路径：按换行拆分为 <p> 段落
      expect(insertedEl.content).toContain('<p>Hello</p>')
      expect(insertedEl.content).toContain('<p>World</p>')
    })

    it('read() 抛出异常时降级到 readText()', async () => {
      stubNavigatorClipboard({
        read: async () => { throw new Error('Permission denied') },
        readText: async () => 'fallback text',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardText as () => Promise<boolean>)()

      expect(result).toBe(true)
      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.content).toContain('<p>fallback text</p>')
    })

    it('navigator.clipboard 不可用时返回 false', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        writable: true,
        configurable: true,
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardText as () => Promise<boolean>)()

      expect(result).toBe(false)
      expect(mockAddElement).not.toHaveBeenCalled()
    })

    it('剪贴板为空（纯文本全空白）时返回 false', async () => {
      const emptyItem = { types: [] as string[], getType: vi.fn() }
      stubNavigatorClipboard({
        read: async () => [emptyItem],
        readText: async () => '   ',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardText as () => Promise<boolean>)()

      expect(result).toBe(false)
      expect(mockAddElement).not.toHaveBeenCalled()
    })

    it('纯文本中的 HTML 特殊字符被转义（XSS 防护）', async () => {
      stubNavigatorClipboard({
        read: async () => [],
        readText: async () => '<script>alert("xss")</script>',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardText as () => Promise<boolean>)()

      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.content).toContain('&lt;')
      expect(insertedEl.content).toContain('&gt;')
      expect(insertedEl.content).not.toContain('<script>')
    })

    it('& 字符被转义为 &amp;', async () => {
      stubNavigatorClipboard({
        read: async () => [],
        readText: async () => 'A & B',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardText as () => Promise<boolean>)()

      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.content).toContain('&amp;')
    })

    it('文本元素使用 presentation 主题的字体和颜色', async () => {
      stubNavigatorClipboard({
        read: async () => [],
        readText: async () => 'styled text',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardText as () => Promise<boolean>)()

      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.defaultFontName).toBe('Arial')
      expect(insertedEl.defaultColor).toBe('#000')
    })

    it('空行被转换为 <br> 占位', async () => {
      stubNavigatorClipboard({
        read: async () => [],
        readText: async () => 'Line1\n\nLine3',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardText as () => Promise<boolean>)()

      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.content).toContain('<p><br></p>')
    })
  })

  // ────────────────────────────────────
  //  tryPasteClipboardImage
  // ────────────────────────────────────

  describe('tryPasteClipboardImage()', () => {
    it('readClipboardImageFile 返回文件时插入图片元素', async () => {
      const mockFile = new File(['img-data'], 'pasted.png', { type: 'image/png' })
      mockReadClipboardImageFile.mockResolvedValueOnce(mockFile)

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(result).toBe(true)
      expect(mockAddElement).toHaveBeenCalledOnce()
      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.type).toBe('image')
      expect(mockPushSnapshot).toHaveBeenCalledOnce()
    })

    it('readClipboardImageFile 返回 null 时返回 false 且不插入', async () => {
      mockReadClipboardImageFile.mockResolvedValueOnce(null)

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      const result = await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(result).toBe(false)
      expect(mockAddElement).not.toHaveBeenCalled()
    })

    it('图片校验失败时调用 onError("validation") 并不插入', async () => {
      const mockFile = new File(['bad'], 'not-image.exe', { type: 'application/octet-stream' })
      mockReadClipboardImageFile.mockResolvedValueOnce(mockFile)
      mockValidateImageFile.mockReturnValueOnce({ valid: false, reason: 'not_image' })

      const onError = vi.fn()
      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({ onError }) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(onError).toHaveBeenCalledWith('validation', 'not_image')
      expect(mockAddElement).not.toHaveBeenCalled()
    })

    it('resolveImageSrc 降级为 base64 时触发 onError("upload")', async () => {
      const mockFile = new File(['img'], 'photo.jpg', { type: 'image/jpeg' })
      mockReadClipboardImageFile.mockResolvedValueOnce(mockFile)
      mockResolveImageSrc.mockResolvedValueOnce({ src: 'data:image/jpeg;base64,abc', fallback: true })

      const onError = vi.fn()
      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({ onError }) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(onError).toHaveBeenCalledWith('upload', 'fallback_base64')
      // 降级后仍然插入元素（base64 fallback）
      expect(mockAddElement).toHaveBeenCalledOnce()
    })

    it('createImageElement 抛出异常时调用 onError("load")', async () => {
      const mockFile = new File(['corrupted'], 'bad.png', { type: 'image/png' })
      mockReadClipboardImageFile.mockResolvedValueOnce(mockFile)
      mockCreateImageElement.mockRejectedValueOnce(new Error('Failed to load image'))

      const onError = vi.fn()
      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({ onError }) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(onError).toHaveBeenCalledWith('load', 'Failed to load image')
      expect(mockAddElement).not.toHaveBeenCalled()
    })

    it('onUploadImage 成功时使用返回的 URL', async () => {
      const mockFile = new File(['img'], 'upload.jpg', { type: 'image/jpeg' })
      mockReadClipboardImageFile.mockResolvedValueOnce(mockFile)
      mockResolveImageSrc.mockResolvedValueOnce({ src: 'https://cdn.example.com/upload.jpg', fallback: false })

      const onUploadImage = vi.fn(async () => 'https://cdn.example.com/upload.jpg')
      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardImage } = useClipboardPaste({ onUploadImage }) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardImage as () => Promise<boolean>)()

      expect(mockAddElement).toHaveBeenCalledOnce()
      expect(mockCreateImageElement).toHaveBeenCalledWith(
        'https://cdn.example.com/upload.jpg',
        expect.objectContaining({ offlinePendingUpload: false }),
      )
    })
  })

  // ────────────────────────────────────
  //  外部 paste 事件处理
  // ────────────────────────────────────

  describe('外部 paste 事件（document paste listener）', () => {
    it('isEditableTarget=true 时跳过处理', async () => {
      mockIsEditableTarget.mockReturnValue(true)

      const { capture, restore } = (() => {
        let handler: PasteHandler | null = null
        const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
          if (type === 'paste') handler = fn as PasteHandler
        })
        vi.spyOn(document, 'removeEventListener').mockImplementation(() => { /* no-op */ })
        return {
          capture: () => handler,
          restore: () => { spy.mockRestore(); vi.mocked(document.removeEventListener).mockRestore() },
        }
      })()

      const { useClipboardPaste } = await import('../useClipboardPaste')
      useClipboardPaste({})

      // 手动触发 useEffect
      const reactModule = await import('react')
      const useEffectMock = vi.mocked(reactModule.useEffect)
      for (const [cb] of useEffectMock.mock.calls) {
        (cb as () => void)()
      }

      const handler = capture()
      if (handler) {
        const event = { clipboardData: { getData: () => '' }, target: document.body, preventDefault: vi.fn() } as unknown as ClipboardEvent
        await handler(event)
        expect(mockAddElement).not.toHaveBeenCalled()
      }

      restore()
    })

    it('paste 事件含 text/html 时插入净化后的文本元素', async () => {
      let pasteHandler: PasteHandler | null = null
      vi.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
        if (type === 'paste') pasteHandler = fn as PasteHandler
      })
      vi.spyOn(document, 'removeEventListener').mockImplementation(() => { /* no-op */ })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      useClipboardPaste({})

      // 触发 useEffect 注册监听器
      const reactModule = await import('react')
      const useEffectMock = vi.mocked(reactModule.useEffect)
      for (const [cb] of useEffectMock.mock.calls) {
        (cb as () => void)()
      }

      expect(pasteHandler).not.toBeNull()

      const event = {
        clipboardData: {
          getData: (type: string) => type === 'text/html' ? '<p>Pasted</p>' : '',
          items: [],
        },
        target: document.body,
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent

      await pasteHandler!(event)
      await new Promise((r) => setTimeout(r, 10))

      expect(event.preventDefault).toHaveBeenCalled()
      expect(mockAddElement).toHaveBeenCalledOnce()
      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.type).toBe('text')

      vi.mocked(document.addEventListener).mockRestore()
      vi.mocked(document.removeEventListener).mockRestore()
    })

    it('paste 事件仅含纯文本时转换为 <p> 段落', async () => {
      let pasteHandler: PasteHandler | null = null
      vi.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
        if (type === 'paste') pasteHandler = fn as PasteHandler
      })
      vi.spyOn(document, 'removeEventListener').mockImplementation(() => { /* no-op */ })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      useClipboardPaste({})

      const reactModule = await import('react')
      for (const [cb] of vi.mocked(reactModule.useEffect).mock.calls) {
        (cb as () => void)()
      }

      const event = {
        clipboardData: {
          getData: (type: string) => type === 'text/plain' ? 'Line1\nLine2' : '',
          items: [],
        },
        target: document.body,
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent

      await pasteHandler!(event)
      await new Promise((r) => setTimeout(r, 10))

      expect(mockAddElement).toHaveBeenCalledOnce()
      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.content).toContain('<p>Line1</p>')
      expect(insertedEl.content).toContain('<p>Line2</p>')

      vi.mocked(document.addEventListener).mockRestore()
      vi.mocked(document.removeEventListener).mockRestore()
    })

    it('paste 事件含图片时调用 insertImageFromFile', async () => {
      mockHasClipboardImage.mockReturnValue(true)

      const mockFile = new File(['img'], 'clip.png', { type: 'image/png' })
      mockExtractImageFile.mockReturnValue(mockFile)

      let pasteHandler: PasteHandler | null = null
      vi.spyOn(document, 'addEventListener').mockImplementation((type, fn) => {
        if (type === 'paste') pasteHandler = fn as PasteHandler
      })
      vi.spyOn(document, 'removeEventListener').mockImplementation(() => { /* no-op */ })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      useClipboardPaste({})

      const reactModule = await import('react')
      for (const [cb] of vi.mocked(reactModule.useEffect).mock.calls) {
        (cb as () => void)()
      }

      const event = {
        clipboardData: { getData: () => '', items: [] },
        target: document.body,
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent

      await pasteHandler!(event)
      await new Promise((r) => setTimeout(r, 10))

      expect(event.preventDefault).toHaveBeenCalled()
      expect(mockAddElement).toHaveBeenCalledOnce()
      const insertedEl = mockAddElement.mock.calls[0][0]
      expect(insertedEl.type).toBe('image')

      vi.mocked(document.addEventListener).mockRestore()
      vi.mocked(document.removeEventListener).mockRestore()
    })
  })

  // ────────────────────────────────────
  //  presentation 未初始化时防御
  // ────────────────────────────────────

  describe('presentation 为 null 时防御', () => {
    it('tryPasteClipboardText 不插入元素', async () => {
      const { useSlideStore } = await import('../../store/slide')
      vi.mocked(useSlideStore.getState).mockReturnValue({
        presentation: null,
        addElement: mockAddElement,
      } as unknown as ReturnType<typeof useSlideStore.getState>)

      stubNavigatorClipboard({
        read: async () => [],
        readText: async () => 'some text',
      })

      const { useClipboardPaste } = await import('../useClipboardPaste')
      const { tryPasteClipboardText } = useClipboardPaste({}) as ReturnType<typeof useClipboardPaste>

      await (tryPasteClipboardText as () => Promise<boolean>)()

      // insertTextElement 检查 presentation，为 null 则提前 return
      expect(mockAddElement).not.toHaveBeenCalled()
    })
  })
})
