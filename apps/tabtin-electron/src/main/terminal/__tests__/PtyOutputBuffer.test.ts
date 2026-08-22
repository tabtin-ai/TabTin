import { describe, expect, it } from 'vitest'
import { PtyOutputBuffer } from '../PtyOutputBuffer'

describe('PtyOutputBuffer', () => {
  it('支持基于绝对 cursor 读取后续输出，即使前面的 chunk 被裁剪', () => {
    const buffer = new PtyOutputBuffer(6)

    buffer.append('aa')
    buffer.append('bb')
    const cursor = buffer.createCursor()

    buffer.append('cc')
    buffer.append('dd')

    expect(buffer.readAll()).toBe('bbccdd')
    expect(buffer.readFromCursor(cursor)).toBe('ccdd')
  })

  it('支持按 chunk 数读取 tail，并暴露当前 chunk 数与字节数', () => {
    const buffer = new PtyOutputBuffer(32)

    buffer.append('alpha')
    buffer.append('beta')
    buffer.append('gamma')

    expect(buffer.getChunkCount()).toBe(3)
    expect(buffer.getTotalBytes()).toBe(Buffer.byteLength('alphabetagamma', 'utf8'))
    expect(buffer.readTail(2)).toBe('betagamma')
    expect(buffer.lastChunkCursor()).toBe(2)
  })
})
