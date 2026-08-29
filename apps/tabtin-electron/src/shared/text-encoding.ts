import jschardet from 'jschardet'

const DETECTION_SAMPLE_BYTES = 4 * 1024
const ENCODING_CONFIDENCE_THRESHOLD = 0.85

const DETECTED_ENCODING_ALIASES: Record<string, string> = {
  ascii: 'utf-8',
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  gb2312: 'gbk',
  big5: 'big5',
  'shift-jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-8': 'iso-8859-8',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1255': 'windows-1255',
  'koi8-r': 'koi8-r',
  ibm866: 'ibm866',
  'tis-620': 'tis-620',
}

function normalizeDetectedEncoding(encoding: string): string | null {
  const normalized = encoding.toLowerCase().replace(/_/g, '-')
  return (
    DETECTED_ENCODING_ALIASES[encoding.toLowerCase()] ??
    DETECTED_ENCODING_ALIASES[normalized] ??
    null
  )
}

function bytesToBinaryString(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes)
}

/** Detect a text encoding from its BOM or a high-confidence byte sample. */
export function detectTextEncoding(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) return 'utf-8'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) return 'utf-32le'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) return 'utf-32be'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xfe &&
    bytes[1] === 0xff &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) return 'utf-32-3412'
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xfe
  ) return 'utf-32-2143'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'

  try {
    const detected = jschardet.detect(
      bytesToBinaryString(bytes.subarray(0, DETECTION_SAMPLE_BYTES)),
    )
    if (detected.encoding && detected.confidence >= ENCODING_CONFIDENCE_THRESHOLD) {
      return normalizeDetectedEncoding(detected.encoding) ?? 'utf-8'
    }
  } catch {
    // Keep the historic UTF-8 fallback when detection is unavailable.
  }
  return 'utf-8'
}
