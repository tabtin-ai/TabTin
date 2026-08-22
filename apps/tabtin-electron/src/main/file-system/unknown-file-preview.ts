import fsPromises from 'node:fs/promises'

const UNKNOWN_FILE_BINARY_SNIFF_BYTES = 8 * 1024

const hasBinaryContent = (buffer: Buffer): boolean => {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return false
  if (buffer.length >= 2 && ((buffer[0] === 0xFF && buffer[1] === 0xFE) || (buffer[0] === 0xFE && buffer[1] === 0xFF))) return false

  const checkLen = Math.min(UNKNOWN_FILE_BINARY_SNIFF_BYTES, buffer.length)
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export const shouldPreviewUnknownFileAsText = async (filePath: string, size: number): Promise<boolean> => {
  if (size === 0) return true

  const handle = await fsPromises.open(filePath, 'r')
  try {
    const previewSize = Math.min(size, UNKNOWN_FILE_BINARY_SNIFF_BYTES)
    const buffer = Buffer.alloc(previewSize)
    await handle.read(buffer, 0, previewSize, 0)
    return !hasBinaryContent(buffer)
  } finally {
    await handle.close()
  }
}
