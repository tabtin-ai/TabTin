import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shouldPreviewUnknownFileAsText } from '../unknown-file-preview'

describe('unknown file preview text fallback', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tabtin-preview-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('treats an empty extensionless file as text', async () => {
    const filePath = path.join(tempDir, 'notes')
    await writeFile(filePath, '')

    await expect(shouldPreviewUnknownFileAsText(filePath, 0)).resolves.toBe(true)
  })

  it('treats an extensionless utf-8 file as text', async () => {
    const filePath = path.join(tempDir, 'notes')
    const content = 'hello\n'
    await writeFile(filePath, content)

    await expect(shouldPreviewUnknownFileAsText(filePath, Buffer.byteLength(content))).resolves.toBe(true)
  })

  it('treats an unknown extension without binary markers as text', async () => {
    const filePath = path.join(tempDir, 'draft.unknown')
    const content = 'plain text'
    await writeFile(filePath, content)

    await expect(shouldPreviewUnknownFileAsText(filePath, Buffer.byteLength(content))).resolves.toBe(true)
  })

  it('keeps an unknown file with null bytes as binary', async () => {
    const filePath = path.join(tempDir, 'artifact')
    const content = Buffer.from([0x01, 0x00, 0x02, 0x03])
    await writeFile(filePath, content)

    await expect(shouldPreviewUnknownFileAsText(filePath, content.length)).resolves.toBe(false)
  })
})
