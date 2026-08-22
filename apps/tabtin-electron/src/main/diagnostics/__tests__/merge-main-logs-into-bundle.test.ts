import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { mergeMainLogsIntoBundleBuffer } from '../merge-main-logs-into-bundle'

vi.mock('../read-main-logs', () => ({
  readMainProcessLogSnapshot: vi.fn(),
}))

import { readMainProcessLogSnapshot } from '../read-main-logs'

const readSnapshot = vi.mocked(readMainProcessLogSnapshot)

async function makeBaseZip(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('renderer.log', 'hello')
  zip.file('main.log.note.txt', 'placeholder')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe('mergeMainLogsIntoBundleBuffer', () => {
  beforeEach(() => {
    readSnapshot.mockReset()
  })

  it('注入 main.log 并移除占位 note', async () => {
    readSnapshot.mockResolvedValue({
      available: true,
      logDir: '/tmp/logs',
      mainLog: '[info] boot ok',
      oldLog: null,
      archivedLogs: [],
    })

    const merged = await mergeMainLogsIntoBundleBuffer(await makeBaseZip())
    const out = await JSZip.loadAsync(merged.buffer)

    expect(merged.mainLogAttached).toBe(true)
    expect(await out.file('main.log')?.async('string')).toBe('[info] boot ok')
    expect(out.file('main.log.note.txt')).toBeNull()
  })

  it('注入多份 main.N.log 归档', async () => {
    readSnapshot.mockResolvedValue({
      available: true,
      logDir: '/tmp/logs',
      mainLog: null,
      oldLog: 'old-compat',
      archivedLogs: [
        { fileName: 'main.1.log', content: 'archive-1' },
        { fileName: 'main.5.log', content: 'archive-5' },
      ],
    })

    const merged = await mergeMainLogsIntoBundleBuffer(await makeBaseZip())
    const out = await JSZip.loadAsync(merged.buffer)

    expect(merged.mainLogAttached).toBe(false)
    expect(merged.oldLogAttached).toBe(true)
    expect(await out.file('main.1.log')?.async('string')).toBe('archive-1')
    expect(await out.file('main.5.log')?.async('string')).toBe('archive-5')
    expect(out.file('main.old.log')).toBeNull()
    expect(out.file('main.log.note.txt')).toBeNull()
  })

  it('无日志内容时写入 note', async () => {
    readSnapshot.mockResolvedValue({
      available: false,
      logDir: null,
      mainLog: null,
      oldLog: null,
      archivedLogs: [],
      note: '开发模式无 main.log',
    })

    const merged = await mergeMainLogsIntoBundleBuffer(await makeBaseZip())
    const out = await JSZip.loadAsync(merged.buffer)

    expect(merged.mainLogAttached).toBe(false)
    expect(await out.file('main.log.note.txt')?.async('string')).toBe('开发模式无 main.log')
    expect(out.file('main.log')).toBeNull()
  })
})
