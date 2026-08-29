import fs from 'node:fs/promises'
import path from 'node:path'
import { detectTextEncoding } from '../../shared/text-encoding'

const HTML_ENCODING_BOMS = [
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe, 0x00, 0x00],
  [0x00, 0x00, 0xfe, 0xff],
  [0xff, 0xfe],
  [0xfe, 0xff],
]
const HTML_META_CHARSET_RE = /<meta\b[^>]*\bcharset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))[^>]*>/i
const HTML_SAMPLE_BYTES = 64 * 1024

function hasHtmlEncodingBom(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1024))
  return HTML_ENCODING_BOMS.some((bom) => bom.every((value, index) => sample[index] === value))
}

export function detectDeclaredHtmlEncoding(bytes: Uint8Array): string | undefined {
  if (hasHtmlEncodingBom(bytes)) return undefined
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1024))
  const match = HTML_META_CHARSET_RE.exec(new TextDecoder('latin1').decode(sample))
  const declared = match?.[1] ?? match?.[2] ?? match?.[3]
  return declared?.trim().toLowerCase() || undefined
}

function hasHtmlEncodingDeclaration(bytes: Uint8Array): boolean {
  return hasHtmlEncodingBom(bytes) || detectDeclaredHtmlEncoding(bytes) !== undefined
}

export function detectUnlabeledHtmlPreviewEncoding(bytes: Uint8Array): string | undefined {
  if (hasHtmlEncodingDeclaration(bytes)) return undefined
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /[\u0080-\uffff]/.test(decoded) ? 'utf-8' : undefined
  } catch {
    // Continue with the deliberately narrow GB18030 fallback.
  }
  return detectTextEncoding(bytes) === 'gbk' ? 'gb18030' : undefined
}

export async function detectLocalHtmlPreviewEncoding(filePath: string): Promise<string | undefined> {
  if (!['.html', '.htm'].includes(path.extname(filePath).toLowerCase())) return undefined
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const bytes = Buffer.alloc(Math.min(size, HTML_SAMPLE_BYTES))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return detectUnlabeledHtmlPreviewEncoding(bytes.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
