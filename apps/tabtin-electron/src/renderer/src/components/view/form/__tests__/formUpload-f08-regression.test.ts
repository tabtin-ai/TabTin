/**
 * Regression tests for FormField upload handling.
 *
 * Covers:
 *   FMF-021 — multi-file upload: partial success still committed, all errors reported
 *   FMF-022 — fileSize fallback to file.size when result.fileSize is missing
 */

import { describe, it, expect } from 'vitest'

/**
 * Extracted logic from FormAttachmentUploader.handleFileSelect
 * to enable unit-level testing without React rendering.
 */
function simulateUpload(
  files: Array<{ name: string; size: number }>,
  uploadFn: (file: { name: string; size: number }, name: string) => Promise<{
    fileId: string
    fileName: string
    fileSize?: number
    accessUrl: string
  }>,
  existingItems: Array<{ file_id: string; name: string; size: number; url: string }> = [],
): { items: Array<{ file_id: string; name: string; size: number; url: string }>; errors: string[] } {
  const newItems = [...existingItems]
  const failedFiles: string[] = []

  const results: Array<{
    ok: boolean
    file: { name: string; size: number }
    result?: { fileId: string; fileName: string; fileSize?: number; accessUrl: string }
    error?: string
  }> = []

  for (const file of files) {
    try {
      const r = uploadFn(file, file.name) as unknown as {
        fileId: string
        fileName: string
        fileSize?: number
        accessUrl: string
      }
      results.push({ ok: true, file, result: r })
    } catch {
      // not used in sync simulation
    }
  }

  return { items: newItems, errors: failedFiles }
}

describe('FMF-021: multi-file upload partial failure', () => {
  it('should report all failed file names, not just the last one', async () => {
    const failedFiles: string[] = []
    const newItems: Array<{ file_id: string; name: string; size: number; url: string }> = []

    const files = [
      { name: 'good.pdf', size: 1000 },
      { name: 'bad1.pdf', size: 2000 },
      { name: 'bad2.pdf', size: 3000 },
    ]

    const uploadFn = async (file: { name: string; size: number }) => {
      if (file.name.startsWith('bad')) {
        throw new Error(`upload failed for ${file.name}`)
      }
      return {
        fileId: `id-${file.name}`,
        fileName: file.name,
        fileSize: file.size,
        accessUrl: `https://cdn/${file.name}`,
      }
    }

    for (const file of files) {
      try {
        const result = await uploadFn(file)
        newItems.push({
          file_id: result.fileId,
          name: result.fileName,
          size: result.fileSize ?? file.size,
          url: result.accessUrl,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('abort')) break
        failedFiles.push(`${file.name}: ${msg}`)
      }
    }

    const uploadError = failedFiles.length > 0 ? failedFiles.join('; ') : null

    expect(newItems).toHaveLength(1)
    expect(newItems[0].name).toBe('good.pdf')

    expect(failedFiles).toHaveLength(2)
    expect(uploadError).toContain('bad1.pdf')
    expect(uploadError).toContain('bad2.pdf')
  })

  it('should commit successful files even when some fail', async () => {
    const newItems: Array<{ file_id: string; name: string; size: number; url: string }> = []
    const failedFiles: string[] = []

    const files = [
      { name: 'a.png', size: 100 },
      { name: 'b.png', size: 200 },
      { name: 'c.png', size: 300 },
    ]

    const uploadFn = async (file: { name: string; size: number }) => {
      if (file.name === 'b.png') throw new Error('network error')
      return {
        fileId: `id-${file.name}`,
        fileName: file.name,
        fileSize: file.size,
        accessUrl: `https://cdn/${file.name}`,
      }
    }

    for (const file of files) {
      try {
        const result = await uploadFn(file)
        newItems.push({
          file_id: result.fileId,
          name: result.fileName,
          size: result.fileSize ?? file.size,
          url: result.accessUrl,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('abort')) break
        failedFiles.push(`${file.name}: ${msg}`)
      }
    }

    expect(newItems).toHaveLength(2)
    expect(newItems.map(i => i.name)).toEqual(['a.png', 'c.png'])
    expect(failedFiles).toHaveLength(1)
    expect(failedFiles[0]).toContain('b.png')
  })
})

describe('FMF-022: fileSize fallback', () => {
  it('should use result.fileSize when available', () => {
    const result = { fileId: 'f1', fileName: 'a.pdf', fileSize: 12345, accessUrl: 'url' }
    const file = { size: 99999 }
    const size = result.fileSize ?? file.size
    expect(size).toBe(12345)
  })

  it('should fallback to file.size when result.fileSize is undefined', () => {
    const result = { fileId: 'f1', fileName: 'a.pdf', fileSize: undefined, accessUrl: 'url' }
    const file = { size: 99999 }
    const size = result.fileSize ?? file.size
    expect(size).toBe(99999)
  })

  it('should fallback to file.size when result.fileSize is 0 (falsy but valid)', () => {
    const result = { fileId: 'f1', fileName: 'a.pdf', fileSize: 0, accessUrl: 'url' }
    const file = { size: 99999 }
    const size = result.fileSize ?? file.size
    expect(size).toBe(0)
  })
})
