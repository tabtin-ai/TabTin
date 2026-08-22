import { describe, expect, it } from 'vitest'
import { LOCAL_TEXT_PREVIEW_BYTES } from '@components/shared/file-utils'
import { TEXT_PREVIEW_FILENAMES } from '@shared/text-preview-contract'
import {
  decodeUtf8Preview,
  localFilePreviewRegistry,
} from './localFilePreviewRegistry'

describe('localFilePreviewRegistry remote preview matrix', () => {
  it('connects every local preview format to binary or safe URL preview', () => {
    const urlPreviewTypes = new Set(['image', 'video', 'audio'])
    const missingRemotePreview = localFilePreviewRegistry.formats()
      .filter(format => !format.renderBinaryPreview && !urlPreviewTypes.has(format.fileType))
      .map(format => format.fileType)

    expect(missingRemotePreview).toEqual([])
  })

  it.each(['csv', 'json', 'txt', 'markdown', 'text'])(
    'caps remote %s previews at the local text limit',
    (fileType) => {
      expect(localFilePreviewRegistry.getByFileType(fileType)?.maxBinaryPreviewBytes)
        .toBe(LOCAL_TEXT_PREVIEW_BYTES)
    },
  )

  it('strictly decodes UTF-8 without replacement characters', () => {
    expect(decodeUtf8Preview(new TextEncoder().encode('你好\nhello').buffer)).toBe('你好\nhello')
    expect(() => decodeUtf8Preview(new Uint8Array([0xc3, 0x28]).buffer))
      .toThrow()
  })

  it('keeps SVG on the safe image URL path instead of text or HTML rendering', () => {
    const svg = localFilePreviewRegistry.getByPath('diagram.svg')
    expect(svg?.fileType).toBe('image')
    expect(svg?.renderBinaryPreview).toBeUndefined()
  })

  it.each(['guide.md', 'guide.mark', 'guide.markdown'])(
    'routes %s through the shared Markdown viewer',
    (fileName) => {
      const format = localFilePreviewRegistry.getByPath(fileName)
      expect(format?.fileType).toBe('markdown')
      expect(format?.renderBinaryPreview).toBeTypeOf('function')
    },
  )

  it('routes legacy .doc through the shared read-only Office renderer', () => {
    const format = localFilePreviewRegistry.getByPath('legacy.doc')
    expect(format?.fileType).toBe('doc')
    expect(format?.renderBinaryPreview).toBeTypeOf('function')
  })

  it('covers every filename recognized as text by the local main-process contract', () => {
    for (const fileName of TEXT_PREVIEW_FILENAMES) {
      const format = localFilePreviewRegistry.getByPath(`/workspace/${fileName}`)
      expect(format?.fileType, fileName).toBe('text')
      expect(format?.renderBinaryPreview, fileName).toBeTypeOf('function')
    }
  })
})
