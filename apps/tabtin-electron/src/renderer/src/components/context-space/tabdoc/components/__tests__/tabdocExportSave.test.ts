import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveExportBlob } from '@/services/tableCoreRuntime'
import {
  sanitizeTabdocExportFilename,
  saveTabdocExportBlob,
} from '../tabdocExportSave'

vi.mock('@/services/tableCoreRuntime', () => ({
  saveExportBlob: vi.fn(),
}))

const saveExportBlobMock = vi.mocked(saveExportBlob)

describe('tabdocExportSave', () => {
  beforeEach(() => {
    saveExportBlobMock.mockReset()
  })

  it('清理导出文件名后再交给原生保存工具', async () => {
    const blob = new Blob(['hello'])
    saveExportBlobMock.mockResolvedValueOnce({
      status: 'saved',
      path: 'C:\\Users\\tester\\Downloads\\bad__name.md',
    })

    const result = await saveTabdocExportBlob(blob, 'bad<>name..md')

    expect(saveExportBlobMock).toHaveBeenCalledWith(blob, 'bad__name.md')
    expect(result).toEqual({
      status: 'saved',
      path: 'C:\\Users\\tester\\Downloads\\bad__name.md',
    })
  })

  it('避免 Windows 保留文件名', () => {
    expect(sanitizeTabdocExportFilename('CON.md')).toBe('_CON.md')
  })

  it('限制过长文件名但保留扩展名', () => {
    const sanitized = sanitizeTabdocExportFilename(`${'a'.repeat(240)}.md`)

    expect(sanitized.length).toBe(200)
    expect(sanitized.endsWith('.md')).toBe(true)
  })
})
