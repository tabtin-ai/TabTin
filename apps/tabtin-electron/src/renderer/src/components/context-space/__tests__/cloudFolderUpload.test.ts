import { describe, expect, it } from 'vitest'
import {
  CLOUD_FOLDER_UPLOAD_EXTENSIONS,
  planCloudFolderUpload,
} from '../cloudFolderUpload'
import { TABFILES_IMPORT_MAX_SIZE_BYTES } from '../resourceFileImportRouting'

function fileAt(relativePath: string, size = 16, content = 'x'): File {
  const name = relativePath.split('/').pop() || relativePath
  const file = new File([content.repeat(Math.max(1, size))], name)
  Object.defineProperty(file, 'size', { value: size })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

describe('planCloudFolderUpload', () => {
  it('keeps only first-level files under the selected root folder', () => {
    const plan = planCloudFolderUpload([
      fileAt('Docs/readme.md'),
      fileAt('Docs/nested/deep.txt'),
      fileAt('Docs/sheet.xlsx'),
    ])

    expect(plan.folderName).toBe('Docs')
    expect(plan.accepted.map(item => item.fileName)).toEqual(['readme.md', 'sheet.xlsx'])
    expect(plan.skippedNestedCount).toBe(1)
    expect(plan.skippedTypeCount).toBe(0)
  })

  it('skips unsupported types, empty files and oversized files', () => {
    const plan = planCloudFolderUpload([
      fileAt('Pack/ok.docx', 32),
      fileAt('Pack/skip.zip', 32),
      fileAt('Pack/empty.txt', 0),
      fileAt('Pack/huge.pdf', TABFILES_IMPORT_MAX_SIZE_BYTES + 1),
      fileAt('Pack/clip.mp4', 32),
    ])

    expect(plan.accepted.map(item => item.fileName)).toEqual(['ok.docx'])
    expect(plan.skippedTypeCount).toBe(2)
    expect(plan.skippedEmptyCount).toBe(1)
    expect(plan.skippedTooLargeCount).toBe(1)
  })

  it('exposes the curated office + image whitelist without audio/video', () => {
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).toContain('docx')
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).toContain('xlsx')
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).toContain('png')
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).not.toContain('mp4')
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).not.toContain('mp3')
    expect(CLOUD_FOLDER_UPLOAD_EXTENSIONS).not.toContain('ts')
  })

  it('dedupes first-level files that appear twice in the FileList', () => {
    const plan = planCloudFolderUpload([
      fileAt('Docs/readme.md'),
      fileAt('Docs/readme.md'),
      fileAt('Docs/sheet.xlsx'),
    ])

    expect(plan.accepted.map(item => item.fileName)).toEqual(['readme.md', 'sheet.xlsx'])
    expect(plan.skippedDuplicateCount).toBe(1)
  })
})
