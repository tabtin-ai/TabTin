/**
 * DocxViewer 回归测试
 * 覆盖问题：ODX-002, ODX-003, ODX-004, ODX-009, ODX-010, ODX-011
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'

let renderAsyncMock: ReturnType<typeof vi.fn>
let _resolveRenderAsync: () => void
const renderAsyncResolvers: Array<() => void> = []

vi.mock('docx-preview', () => ({
  renderAsync: (...args: unknown[]) => renderAsyncMock(...args),
}))

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html,
  },
}))

vi.mock('lucide-react', () => ({
  AlertCircle: (props: Record<string, unknown>) => <span data-testid="alert-icon" {...props} />,
  ExternalLink: (props: Record<string, unknown>) => <span data-testid="external-link-icon" {...props} />,
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({
    children,
    className,
    scrollBar,
  }: {
    children: React.ReactNode
    className?: string
    scrollBar?: string
  }) => (
    <div data-testid="scroll-area" data-scroll-bar={scrollBar} className={className}>
      {children}
    </div>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockReadBinaryFile = vi.fn()
const mockReadFilePreview = vi.fn()
const mockOpenPath = vi.fn()

Object.defineProperty(window, 'tabtin', {
  value: {
    openPath: mockOpenPath,
    fileSystem: {
      readBinaryFile: mockReadBinaryFile,
      readFilePreview: mockReadFilePreview,
    },
  },
  writable: true,
})

function createDeferredRenderAsync() {
  renderAsyncResolvers.length = 0
  renderAsyncMock = vi.fn().mockImplementation((buffer: ArrayBuffer, container: HTMLElement) => {
    const marker = document.createElement('div')
    marker.setAttribute('data-testid', 'docx-content')
    marker.textContent = `rendered-${buffer.byteLength}`
    container.appendChild(marker)
    return new Promise<void>((resolve) => {
      renderAsyncResolvers.push(resolve)
      _resolveRenderAsync = resolve
    })
  })
}

function resolveRenderAsyncAt(index: number) {
  const resolve = renderAsyncResolvers[index]
  if (!resolve) throw new Error(`No renderAsync resolver at index ${index}`)
  resolve()
}

async function readDocxViewerSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../../../shared/file-preview/DocxViewer.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

import { DocxViewer } from '@components/shared/file-preview/DocxViewer'

describe('DocxViewer ODX regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createDeferredRenderAsync()
    mockReadFilePreview.mockResolvedValue({
      success: true,
      data: { size: 10 },
    })
    mockReadBinaryFile.mockResolvedValue({
      success: true,
      data: new ArrayBuffer(10),
    })
  })

  afterEach(() => {
    cleanup()
  })

  // ODX-002 / : 快速切换时旧 renderAsync 不得擦掉或覆盖新内容
  describe('ODX-002: renderAsync 后的 staleness 检查', () => {
    it('先渲染到游离节点，过期完成时不得清空已挂载的新内容', async () => {
      const source = await readDocxViewerSource()

      // contract W2-β: caller 引入 `buffer` 中间变量（兼容 filePath / props.data 两条路径）
      expect(source).toMatch(/await renderAsync\(\s*(buffer|result\.data|data)/)
      expect(source).toContain("const contentHost = document.createElement('div')")
      expect(source).toContain("const styleHost = document.createElement('div')")
      expect(source).toContain('if (isStale()) return')
      expect(source).toContain('containerRef.current.replaceChildren')
      // 过期路径禁止再 innerHTML='' 清共享容器（旧契约会制造空白预览）
      expect(source).not.toMatch(/if \(isStale\(\)\) \{\s*if \(containerRef\.current\) containerRef\.current\.innerHTML = ''/)
    })

    it('旧 load 晚到时可见 DOM 仍保留新一轮内容', async () => {
      const firstData = new ArrayBuffer(11)
      const secondData = new ArrayBuffer(22)

      const { rerender, container, findByTestId } = render(
        <DocxViewer data={firstData} fileName="a.docx" />,
      )

      await waitFor(() => expect(renderAsyncMock).toHaveBeenCalledTimes(1))

      rerender(<DocxViewer data={secondData} fileName="b.docx" />)

      await waitFor(() => expect(renderAsyncMock).toHaveBeenCalledTimes(2))

      // 新一轮先完成并挂载
      resolveRenderAsyncAt(1)
      const content = await findByTestId('docx-content')
      expect(content.textContent).toBe('rendered-22')

      // 旧一轮晚到：不得把已挂载内容擦成空白
      resolveRenderAsyncAt(0)
      await waitFor(() => {
        const still = container.querySelector('[data-testid="docx-content"]')
        expect(still?.textContent).toBe('rendered-22')
      })
    })
  })

  // ODX-003: 组件卸载后 cleanup 清空 DOM
  describe('ODX-003: 卸载时清空 containerRef 和 styleRef', () => {
    it('组件卸载时应清空容器和样式 DOM', async () => {
      const source = await readDocxViewerSource()
      expect(source).toContain('return () => {')
      expect(source).toContain("if (containerRef.current) containerRef.current.innerHTML = ''")
      expect(source).toContain("if (styleRef.current) styleRef.current.innerHTML = ''")
    })
  })

  // ODX-004: 暗色模式不应污染 Word 纸张和文档内颜色
  describe('ODX-004: 暗色模式不覆盖 Word 文档颜色', () => {
    it('style 标签应使用固定白色纸张且不强制覆盖 docx 正文颜色', () => {
      const { container } = render(<DocxViewer filePath="/test.docx" />)
      const styleEl = container.querySelector('style')
      expect(styleEl).toBeTruthy()
      expect(styleEl?.textContent).toContain('background: #ffffff')
      expect(styleEl?.textContent).not.toContain('color: var(--foreground)')
    })
  })

  // ODX-009: setError 在 stale 时不应调用（contract W2-β：迁到 try/catch + invokeIpc）
  describe('ODX-009: stale 状态下不调用 setError', () => {
    it('readBinaryFile 失败且组件已切换时不应更新 error state', async () => {
      const source = await readDocxViewerSource()
      // try { invokeIpc } catch (err) { if (!isStale()) setError(formatIpcErrorForUser(err)) }
      // try-success-path: 检查 !result?.data 后 if (!isStale()) setError(...)
      expect(source).toContain('if (!result?.data) {')
      expect(source).toContain('if (!isStale()) {')
      expect(source).toContain("setError(t('folder.errors.docxLoadFailed'))")
      expect(source).toContain('} catch (err) {')
      expect(source).toContain('formatIpcErrorForUser(err')
    })
  })

  // ODX-010: renderAsync 前 isStale 检查；完成后仅在未 stale 时挂载
  describe('ODX-010: renderAsync 调用前的 staleness 检查', () => {
    it('readBinaryFile 返回后如已 stale，不应调用 renderAsync；完成后须再校验再挂载', async () => {
      const source = await readDocxViewerSource()
      expect(source).toContain('if (isStale() || !containerRef.current) return')
      expect(source).toContain('await renderAsync(buffer, contentHost, styleHost,')
      expect(source).toContain('containerRef.current.replaceChildren')
    })
  })

  // ODX-011: 快速切换时 styleRef 应被清空
  describe('ODX-011: 快速切换时 styleRef 清空防闪烁', () => {
    it('文件切换时 cleanup 应清空 styleRef', async () => {
      const source = await readDocxViewerSource()
      expect(source).toContain("if (styleRef.current) styleRef.current.innerHTML = ''")
      expect(source).toContain('return () => {')
    })
  })

  // : 宽文档横向滚动 + 字形不被 section overflow 裁切
  describe('#3823: docx 预览横向滚动与字形裁切', () => {
    it('ScrollArea 应启用双向滚动并保留 flex 收缩约束', () => {
      const { container } = render(<DocxViewer filePath="/test.docx" />)
      const scrollArea = container.querySelector('[data-testid="scroll-area"]')
      expect(scrollArea).toBeTruthy()
      expect(scrollArea?.getAttribute('data-scroll-bar')).toBe('both')
      expect(scrollArea?.className).toContain('min-h-0')
      expect(scrollArea?.className).toContain('overscroll-contain')
    })

    it('section.docx 样式不应再用 overflow:hidden 或 max-width:100% 压扁内容', async () => {
      const source = await readDocxViewerSource()
      expect(source).toContain('scrollBar="both"')
      expect(source).toContain('overflow: visible')
      expect(source).not.toMatch(/section\.docx[\s\S]*overflow:\s*hidden/)
      expect(source).not.toContain('max-width: 100%')
      expect(source).toContain('w-max min-w-full')
    })
  })

  describe('invalid DOCX archive errors', () => {
    it('shows a friendly invalid-docx message instead of leaking the raw JSZip error', async () => {
      renderAsyncMock.mockRejectedValue(new Error("Can't find end of central directory: is this a zip file?"))

      const { queryByText, findByText } = render(<DocxViewer filePath="/bad.docx" />)

      expect(await findByText('folder.errors.docxInvalidArchive')).toBeTruthy()
      expect(queryByText(/central directory/i)).toBeNull()
      await waitFor(() => {
        expect(queryByText('folder.actions.openWithSystemApp')).toBeTruthy()
      })
      fireEvent.click(await findByText('folder.actions.openWithSystemApp'))
      expect(mockOpenPath).toHaveBeenCalledWith('/bad.docx')
    })
  })
})
