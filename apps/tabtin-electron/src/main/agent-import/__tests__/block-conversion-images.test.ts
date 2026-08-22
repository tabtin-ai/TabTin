import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  imageRefPlaceholderText,
  toTabtinFileUrl,
  unifiedBlockToContentBlock,
} from '../block-conversion'
import { materializeSessionImages } from '../materialize-images'
import type { UnifiedMessage } from '@tabtin/agent-import'

describe('block-conversion image_ref', () => {
  it('可读绝对路径转为 image 块 + tabtin-file URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabtin-import-conv-'))
    const filePath = join(root, 'shot.png')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    try {
      const block = unifiedBlockToContentBlock({
        type: 'image_ref',
        path: filePath,
        mimeType: 'image/png',
      })
      expect(block.type).toBe('image')
      if (block.type !== 'image') return
      expect(block.filename).toBe('shot.png')
      expect(block.mime_type).toBe('image/png')
      expect(block.url).toBe(toTabtinFileUrl(filePath))
      expect(block.source).toEqual({ type: 'url', url: block.url })
      expect(block.url.startsWith('tabtin-file://')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('空路径 / 相对路径 / 缺失文件降级为占位文本', () => {
    expect(unifiedBlockToContentBlock({ type: 'image_ref', path: '', mimeType: 'image/png' })).toEqual({
      type: 'text',
      text: imageRefPlaceholderText('unknown'),
    })
    expect(
      unifiedBlockToContentBlock({ type: 'image_ref', path: 'relative/a.png', mimeType: 'image/png' }),
    ).toEqual({
      type: 'text',
      text: imageRefPlaceholderText('relative/a.png'),
    })
    expect(
      unifiedBlockToContentBlock({
        type: 'image_ref',
        path: '/tmp/tabtin-definitely-missing-image-xyz.png',
        mimeType: 'image/png',
      }),
    ).toEqual({
      type: 'text',
      text: imageRefPlaceholderText('/tmp/tabtin-definitely-missing-image-xyz.png'),
    })
  })

  it('toTabtinFileUrl 编码空格与中文段', () => {
    expect(toTabtinFileUrl('/tmp/a b/图.png')).toBe('tabtin-file:///tmp/a%20b/%E5%9B%BE.png')
  })
})

describe('materializeSessionImages', () => {
  it('把源图拷进 attachments 并改写 path', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabtin-import-img-'))
    const src = join(root, 'src-shot.png')
    const attachments = join(root, 'attachments')
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const messages: UnifiedMessage[] = [
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date().toISOString(),
        blocks: [
          { type: 'text', text: 'hello' },
          { type: 'image_ref', path: src, mimeType: 'image/png' },
        ],
      },
    ]
    try {
      const out = materializeSessionImages(messages, attachments)
      const img = out[0]?.blocks.find((b) => b.type === 'image_ref')
      expect(img?.type).toBe('image_ref')
      if (img?.type !== 'image_ref') return
      expect(img.path).toContain(attachments)
      expect(img.path).not.toBe(src)
      expect(unifiedBlockToContentBlock(img).type).toBe('image')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('源文件不存在时保留原 path（后续转占位）', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabtin-import-img-miss-'))
    try {
      const missing = join(root, 'missing.png')
      const messages: UnifiedMessage[] = [
        {
          id: 'm1',
          role: 'user',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'image_ref', path: missing, mimeType: 'image/png' }],
        },
      ]
      const out = materializeSessionImages(messages, join(root, 'attachments'))
      expect(out[0]?.blocks[0]).toMatchObject({
        type: 'image_ref',
        path: missing,
      })
      expect(unifiedBlockToContentBlock(out[0]!.blocks[0]!).type).toBe('text')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
