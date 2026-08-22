import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function readXlsxViewerSource() {
  return readFile(resolve(__dirname, '../XlsxViewer.tsx'), 'utf8')
}

describe('XlsxViewer crash-safety source guards', () => {
  it('only falls back to main-thread parsing when the worker cannot be created', async () => {
    const source = await readXlsxViewerSource()

    expect(source).toContain('isWorkerUnavailableError(error)')
    expect(source).toContain('return parseXlsxPreview(buffer)')
    expect(source).toContain('throw error')
    expect(source).toContain('Worker 内解析失败不能同步重试')
  })

  it('terminates formula preview workers on timeout and when the viewer unmounts', async () => {
    const source = await readXlsxViewerSource()

    expect(source).toContain('XLSX_PREVIEW_WORKER_TIMEOUT_MS = 5_000')
    expect(source).toContain("XLSX preview parsing timed out")
    expect(source).toContain('worker.terminate()')
    expect(source).toContain('abortController.abort()')
  })
})
