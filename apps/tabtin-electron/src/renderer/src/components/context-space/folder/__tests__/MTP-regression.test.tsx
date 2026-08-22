/**
 * MTP 回归测试
 * 覆盖问题：MTP-001, MTP-003, MTP-004, MTP-007, MTP-010
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, fireEvent } from '@testing-library/react'

/* ── Mocks ── */

vi.mock('react-markdown', () => ({
  default: ({ children, components }: { children: string; components?: Record<string, React.FC<Record<string, unknown>>> }) => {
    const Img = components?.img
    const A = components?.a
    return (
      <div data-testid="react-markdown">
        {Img && <Img src="./images/photo.png" alt="test" />}
        {Img && <Img src="https://example.com/img.png" alt="remote" />}
        {A && <A href="https://example.com">link</A>}
        {A && <A href="./relative.md">relative</A>}
        <span>{children}</span>
      </div>
    )
  },
}))

vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => () => {} }))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>{children}</div>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('lucide-react', () => ({
  FileText: (p: Record<string, unknown>) => <span {...p} />,
  FileArchive: (p: Record<string, unknown>) => <span {...p} />,
  AlertCircle: (p: Record<string, unknown>) => <span {...p} />,
  Save: (p: Record<string, unknown>) => <span {...p} />,
  Check: (p: Record<string, unknown>) => <span {...p} />,
  Loader2: (p: Record<string, unknown>) => <span {...p} />,
  Eye: (p: Record<string, unknown>) => <span {...p} />,
  Code2: (p: Record<string, unknown>) => <span {...p} />,
  X: (p: Record<string, unknown>) => <span {...p} />,
  FileSpreadsheet: (p: Record<string, unknown>) => <span {...p} />,
  Table2: (p: Record<string, unknown>) => <span {...p} />,
}))

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: ({ fileName }: { fileName: string }) => <span data-testid="file-icon">{fileName}</span>,
}))

vi.mock('@components/shared/file-preview/PdfViewer', () => ({
  PdfViewer: ({ fileUrl, base64 }: { fileUrl?: string; base64?: string }) => (
    <div data-testid="pdf-viewer" data-file-url={fileUrl} data-base64={base64 ? 'yes' : 'no'} />
  ),
}))

vi.mock('@components/shared/file-preview/CsvViewer', () => ({
  CsvViewer: ({
    filePath,
    content,
  }: {
    filePath?: string
    content?: string
  }) => (
    <div data-testid="csv-viewer" data-file-path={filePath} data-content={content} />
  ),
}))

const { mockHandleResourceLinkClick } = vi.hoisted(() => ({
  mockHandleResourceLinkClick: vi.fn(),
}))

vi.mock('@/services/openResourceLink', () => ({
  handleResourceLinkClick: (...args: unknown[]) => mockHandleResourceLinkClick(...args),
}))

const mockOpenExternal = vi.fn().mockResolvedValue({ success: true })

Object.defineProperty(window, 'tabtin', {
  value: {
    openExternal: mockOpenExternal,
    fileSystem: {
      readDir: vi.fn(),
      readFilePreview: vi.fn(),
      writeFile: vi.fn(),
      readBinaryFile: vi.fn(),
    },
  },
  writable: true,
})

/* ── Tests ── */

describe('MTP-001: MarkdownViewer relative image path resolution', () => {
  it('resolves relative src to tabtin-file:// URL when filePath is provided', async () => {
    const { MarkdownViewer } = await import('@components/shared/file-preview/MarkdownViewer')
    const { container } = render(
      <MarkdownViewer content="![test](./images/photo.png)" filePath="/home/user/docs/readme.md" />
    )

    const img = container.querySelector('img[alt="test"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('tabtin-file:///home/user/docs/images/photo.png')
  })

  it('passes through remote URLs unchanged', async () => {
    const { MarkdownViewer } = await import('@components/shared/file-preview/MarkdownViewer')
    const { container } = render(
      <MarkdownViewer content="![remote](https://example.com/img.png)" filePath="/home/user/docs/readme.md" />
    )

    const img = container.querySelector('img[alt="remote"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('https://example.com/img.png')
  })

  it('passes through src when no filePath', async () => {
    const { MarkdownViewer } = await import('@components/shared/file-preview/MarkdownViewer')
    const { container } = render(
      <MarkdownViewer content="![test](./images/photo.png)" />
    )

    const img = container.querySelector('img[alt="test"]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('./images/photo.png')
  })
})

describe('MTP-010: MarkdownViewer links open in TabWeb via ResourceRouter', () => {
  beforeEach(() => {
    mockOpenExternal.mockClear()
    mockHandleResourceLinkClick.mockClear()
  })

  it('dispatches https links to handleResourceLinkClick instead of openExternal', async () => {
    const { MarkdownViewer } = await import('@components/shared/file-preview/MarkdownViewer')
    const { container } = render(
      <MarkdownViewer content="[link](https://example.com)" />
    )

    const link = container.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()
    fireEvent.click(link!)
    expect(mockOpenExternal).not.toHaveBeenCalled()
    expect(mockHandleResourceLinkClick).toHaveBeenCalled()
    expect(mockHandleResourceLinkClick.mock.calls[0]?.[1]).toBe('https://example.com')
  })

  it('does not dispatch relative links', async () => {
    const { MarkdownViewer } = await import('@components/shared/file-preview/MarkdownViewer')
    const { container } = render(
      <MarkdownViewer content="[relative](./relative.md)" />
    )

    const link = container.querySelector('a[href="./relative.md"]')
    expect(link).not.toBeNull()
    fireEvent.click(link!)
    expect(mockOpenExternal).not.toHaveBeenCalled()
    expect(mockHandleResourceLinkClick).not.toHaveBeenCalled()
  })
})

describe('MTP-004: buildTabtinFileUrl encodes # character', () => {
  it('encodes # in file path segments', async () => {
    const mod = await import('../FilePreview')
    const { FilePreview } = mod

    const entry = {
      name: 'file#1.pdf',
      path: '/home/user/file#1.pdf',
      isDirectory: false,
      size: 1024,
      modifiedAt: Date.now(),
    }
    const preview = {
      kind: 'pdf' as const,
      path: '/home/user/file#1.pdf',
      content: undefined,
    }

    const { findByTestId } = render(
      <FilePreview entry={entry} preview={preview} isLoading={false} />
    )

    const pdfViewer = await findByTestId('pdf-viewer')
    expect(pdfViewer.getAttribute('data-file-url')).toBe('tabtin-file:///home/user/file%231.pdf')
    expect(pdfViewer.getAttribute('data-base64')).toBe('no')
  })
})

describe('MTP-003: renderMarkdownToggle hides toggle for truncated files', () => {
  it('does not show markdown toggle when file is truncated', async () => {
    const { FilePreview } = await import('../FilePreview')
    const entry = {
      name: 'readme.md',
      path: '/home/user/readme.md',
      isDirectory: false,
      size: 2048,
      modifiedAt: Date.now(),
    }
    const preview = {
      kind: 'text' as const,
      content: '# Hello World',
      truncated: true,
    }

    const { queryByText } = render(
      <FilePreview entry={entry} preview={preview} isLoading={false} />
    )

    expect(queryByText('folder.labels.viewSource')).toBeNull()
    expect(queryByText('folder.labels.viewRendered')).toBeNull()
  })

  it('shows markdown toggle when file is not truncated', async () => {
    const { FilePreview } = await import('../FilePreview')
    const entry = {
      name: 'readme.md',
      path: '/home/user/readme.md',
      isDirectory: false,
      size: 200,
      modifiedAt: Date.now(),
    }
    const preview = {
      kind: 'text' as const,
      content: '# Hello World',
      truncated: false,
    }

    const { getByText } = render(
      <FilePreview entry={entry} preview={preview} isLoading={false} />
    )

    expect(getByText('folder.labels.viewSource')).toBeTruthy()
    expect(getByText('folder.labels.viewRendered')).toBeTruthy()
  })
})

describe('CSV preview routing', () => {
  it('renders csv files through the shared CSV table preview instead of the text editor', async () => {
    const { FilePreview } = await import('../FilePreview')
    const entry = {
      name: 'data.csv',
      path: '/home/user/data.csv',
      isDirectory: false,
      size: 24,
      modifiedAt: Date.now(),
    }
    const preview = {
      kind: 'text' as const,
      content: 'name,score\nAlice,10',
      truncated: false,
    }

    const { findByTestId, queryByText } = render(
      <FilePreview entry={entry} preview={preview} isLoading={false} />
    )

    const csvViewer = await findByTestId('csv-viewer')
    expect(csvViewer.getAttribute('data-file-path')).toBe('/home/user/data.csv')
    expect(csvViewer.getAttribute('data-content')).toBe('name,score\nAlice,10')
    expect(queryByText('name,score')).toBeNull()
  })
})
