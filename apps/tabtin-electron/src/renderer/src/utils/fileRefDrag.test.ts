import { describe, expect, it } from 'vitest'

import { DRAG_TYPE_FILE_REF } from '@/utils/split-coordinator'
import {
  buildFileRefDragPayload,
  canWriteFileRefDrag,
  readFileRefDragPayload,
  writeFileRefDragPayload,
} from './fileRefDrag'

function createDataTransfer() {
  const store = new Map<string, string>()
  return {
    types: [] as string[],
    effectAllowed: 'none' as string,
    setData(type: string, value: string) {
      store.set(type, value)
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
}

describe('fileRefDrag', () => {
  it('file_id 或 http(s)/data url 可拖，blob 不可拖', () => {
    expect(canWriteFileRefDrag({ fileId: 'f1' })).toBe(true)
    expect(canWriteFileRefDrag({ url: 'https://cdn.example/a.png' })).toBe(true)
    expect(canWriteFileRefDrag({ url: 'data:image/png;base64,abc' })).toBe(true)
    expect(canWriteFileRefDrag({ url: 'blob:http://localhost/x' })).toBe(false)
    expect(canWriteFileRefDrag({})).toBe(false)
  })

  it('write/read 往返保留关键字段', () => {
    const dt = createDataTransfer()
    const ok = writeFileRefDragPayload(dt as unknown as DataTransfer, {
      fileId: 'file-1',
      url: 'https://cdn.example/pic.png',
      name: 'pic.png',
      mimeType: 'image/png',
      size: 12,
    })
    expect(ok).toBe(true)
    expect(dt.types).toContain(DRAG_TYPE_FILE_REF)
    expect(dt.getData('text/uri-list')).toBe('https://cdn.example/pic.png')

    const payload = readFileRefDragPayload(dt)
    expect(payload).toEqual({
      version: 1,
      source: 'chat',
      name: 'pic.png',
      file_id: 'file-1',
      url: 'https://cdn.example/pic.png',
      mime_type: 'image/png',
      size: 12,
    })
  })

  it('拒绝缺 name / 缺引用 / 错误 version 的 payload', () => {
    expect(buildFileRefDragPayload({ url: 'https://x' })?.name).toBe('image')
    expect(readFileRefDragPayload({
      types: [DRAG_TYPE_FILE_REF],
      getData: () => JSON.stringify({ version: 1, source: 'chat', name: '' }),
    })).toBeNull()
    expect(readFileRefDragPayload({
      types: [DRAG_TYPE_FILE_REF],
      getData: () => JSON.stringify({ version: 2, source: 'chat', name: 'a', url: 'https://x' }),
    })).toBeNull()
  })
})
