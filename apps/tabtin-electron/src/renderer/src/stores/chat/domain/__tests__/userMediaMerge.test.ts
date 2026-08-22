import { describe, expect, it } from 'vitest'
import {
  appendMissingUserMediaBlocks,
  upgradeUserMediaBlocksWithFileId,
} from '../userMediaMerge'

describe('upgradeUserMediaBlocksWithFileId / appendMissingUserMediaBlocks ', () => {
  it('把 DB 扁平块的 file_id 写回 transcript 的 source.url 图块', () => {
    const url = 'https://oss.example.com/private/a.png?sign=old'
    const local = [
      { type: 'text', text: '看这张图' },
      { type: 'image', source: { type: 'url', url }, detail: 'auto' },
    ]
    const server = [
      {
        type: 'image',
        file_id: 'fid-img-1',
        filename: 'a.png',
        mime_type: 'image/png',
        size: 100,
        url,
      },
    ]

    const { blocks, upgraded } = upgradeUserMediaBlocksWithFileId(local, server)
    expect(upgraded).toBe(true)
    expect(blocks[1]).toMatchObject({
      type: 'image',
      file_id: 'fid-img-1',
      source: { type: 'url', url },
    })
  })

  it('file↔document 跨类型按同 URL 升级（PDF/Office 附件）', () => {
    const url = 'https://oss.example.com/private/brief.pdf'
    const local = [
      {
        type: 'document',
        title: 'brief.pdf',
        mime_type: 'application/pdf',
        source: { type: 'url', url },
      },
    ]
    const server = [
      {
        type: 'file',
        file_id: 'fid-pdf-1',
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        size: 4096,
        url,
      },
    ]

    const { blocks, added } = appendMissingUserMediaBlocks(local, server)
    expect(added).toBe(true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'document',
      file_id: 'fid-pdf-1',
      size: 4096,
      filename: 'brief.pdf',
      source: { type: 'url', url },
    })
  })

  it('已有 file_id 的 document 仍从 DB file 补 size（避免附件卡 0 B）', () => {
    const url = 'https://oss.example.com/private/brief.pdf'
    const local = [
      {
        type: 'document',
        file_id: 'fid-pdf-1',
        title: 'brief.pdf',
        mime_type: 'application/pdf',
        source: { type: 'url', url },
      },
    ]
    const server = [
      {
        type: 'file',
        file_id: 'fid-pdf-1',
        filename: 'brief.pdf',
        mime_type: 'application/pdf',
        size: 10041,
        url,
      },
    ]

    const { blocks, added } = appendMissingUserMediaBlocks(local, server)
    expect(added).toBe(true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'document',
      file_id: 'fid-pdf-1',
      size: 10041,
      filename: 'brief.pdf',
    })
  })

  it('已升级后不再追加同 URL 的 DB 块', () => {
    const url = 'https://oss.example.com/private/b.png'
    const local = [{ type: 'image', source: { type: 'url', url } }]
    const server = [{ type: 'image', file_id: 'fid-2', url, filename: 'b.png' }]

    const { blocks, added } = appendMissingUserMediaBlocks(local, server)
    expect(added).toBe(true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ file_id: 'fid-2' })
  })
})
