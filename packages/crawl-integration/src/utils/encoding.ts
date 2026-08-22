/**
 * 编码检测和处理工具
 * 用于正确解析不同编码的网页内容
 */

// 常见编码类型
export enum EncodingType {
  UTF8 = 'utf-8',
  UTF16 = 'utf-16',
  UTF16LE = 'utf-16le',
  UTF16BE = 'utf-16be',
  ASCII = 'ascii',
  LATIN1 = 'latin1',
  ISO88591 = 'iso-8859-1',
  WINDOWS1252 = 'windows-1252',
  GBK = 'gbk',
  GB2312 = 'gb2312',
  BIG5 = 'big5',
  SHIFTJIS = 'shift_jis',
  EUC_JP = 'euc-jp',
  EUC_KR = 'euc-kr'
}

// BOM (Byte Order Mark) 检测
const BOM_PATTERNS = {
  'utf-8': [0xEF, 0xBB, 0xBF],
  'utf-16le': [0xFF, 0xFE],
  'utf-16be': [0xFE, 0xFF],
  'utf-32le': [0xFF, 0xFE, 0x00, 0x00],
  'utf-32be': [0x00, 0x00, 0xFE, 0xFF]
};

/**
 * 从 BOM 检测编码
 */
export function detectEncodingFromBOM(buffer: Buffer): string | null {
  for (const [encoding, bom] of Object.entries(BOM_PATTERNS)) {
    if (buffer.length >= bom.length) {
      const match = bom.every((byte, index) => buffer[index] === byte);
      if (match) {
        return encoding;
      }
    }
  }
  return null;
}

/**
 * 从 HTTP 响应头检测编码
 */
export function detectEncodingFromHeaders(headers: Record<string, string>): string | null {
  const contentType = headers['content-type'] || headers['Content-Type'];
  if (!contentType) {
    return null;
  }

  const charsetMatch = contentType.match(/charset=([^;,\s]+)/i);
  if (charsetMatch) {
    return normalizeEncodingName(charsetMatch[1]);
  }

  return null;
}

/**
 * 从 HTML meta 标签检测编码
 */
export function detectEncodingFromHTML(html: string): string | null {
  // 检查 HTML5 meta charset
  const html5Match = html.match(/<meta\s+charset=["']?([^"'\s>]+)/i);
  if (html5Match) {
    return normalizeEncodingName(html5Match[1]);
  }

  // 检查传统 meta http-equiv
  const httpEquivMatch = html.match(/<meta\s+http-equiv=["']?content-type["']?\s+content=["']?[^"'>]*charset=([^"'\s;>]+)/i);
  if (httpEquivMatch) {
    return normalizeEncodingName(httpEquivMatch[1]);
  }

  // 检查 content 在前的情况
  const contentFirstMatch = html.match(/<meta\s+content=["']?[^"'>]*charset=([^"'\s;>]+)[^"'>]*["']?\s+http-equiv=["']?content-type/i);
  if (contentFirstMatch) {
    return normalizeEncodingName(contentFirstMatch[1]);
  }

  return null;
}

/**
 * 统计字节模式来推测编码
 */
export function detectEncodingFromContent(buffer: Buffer): string {
  const bytes = Array.from(buffer.slice(0, Math.min(buffer.length, 8192)));

  // UTF-8 检测
  if (isValidUTF8(buffer)) {
    return 'utf-8';
  }

  // ASCII 检测
  if (bytes.every(byte => byte < 128)) {
    return 'ascii';
  }

  // 中文编码检测
  const chineseScore = detectChineseEncoding(bytes);
  if (chineseScore.encoding !== 'unknown') {
    return chineseScore.encoding;
  }

  // 日文编码检测
  const japaneseScore = detectJapaneseEncoding(bytes);
  if (japaneseScore.encoding !== 'unknown') {
    return japaneseScore.encoding;
  }

  // 韩文编码检测
  if (detectKoreanEncoding(bytes)) {
    return 'euc-kr';
  }

  // 欧洲编码检测
  const europeanScore = detectEuropeanEncoding(bytes);
  if (europeanScore.encoding !== 'unknown') {
    return europeanScore.encoding;
  }

  // 默认返回 latin1
  return 'latin1';
}

/**
 * 综合检测编码
 */
export function detectEncoding(
  buffer: Buffer,
  headers?: Record<string, string>,
  htmlContent?: string
): {
  encoding: string;
  confidence: number;
  sources: string[];
} {
  const sources: string[] = [];
  const candidates: { encoding: string; confidence: number; source: string }[] = [];

  // 1. BOM 检测（最高优先级）
  const bomEncoding = detectEncodingFromBOM(buffer);
  if (bomEncoding) {
    candidates.push({ encoding: bomEncoding, confidence: 1.0, source: 'BOM' });
    sources.push('BOM');
  }

  // 2. HTTP 头检测
  if (headers) {
    const headerEncoding = detectEncodingFromHeaders(headers);
    if (headerEncoding) {
      candidates.push({ encoding: headerEncoding, confidence: 0.9, source: 'HTTP headers' });
      sources.push('HTTP headers');
    }
  }

  // 3. HTML meta 标签检测
  if (htmlContent) {
    const htmlEncoding = detectEncodingFromHTML(htmlContent);
    if (htmlEncoding) {
      candidates.push({ encoding: htmlEncoding, confidence: 0.8, source: 'HTML meta' });
      sources.push('HTML meta');
    }
  }

  // 4. 内容分析检测
  const contentEncoding = detectEncodingFromContent(buffer);
  candidates.push({ encoding: contentEncoding, confidence: 0.6, source: 'content analysis' });
  sources.push('content analysis');

  // 选择置信度最高的编码
  const best = candidates.reduce((prev, current) =>
    current.confidence > prev.confidence ? current : prev
  );

  return {
    encoding: best.encoding,
    confidence: best.confidence,
    sources
  };
}

/**
 * 标准化编码名称
 */
export function normalizeEncodingName(encoding: string): string {
  const normalized = encoding.toLowerCase().replace(/[-_\s]/g, '');

  const mappings: Record<string, string> = {
    'utf8': 'utf-8',
    'utf16': 'utf-16',
    'iso88591': 'iso-8859-1',
    'latin1': 'iso-8859-1',
    'cp1252': 'windows-1252',
    'windows1252': 'windows-1252',
    'gb2312': 'gbk',
    'cp936': 'gbk',
    'ms936': 'gbk',
    'chinese': 'gbk',
    'csgb2312': 'gbk',
    'shiftjis': 'shift_jis',
    'sjis': 'shift_jis',
    'csshiftjis': 'shift_jis',
    'eucjp': 'euc-jp',
    'euckr': 'euc-kr',
    'ksc56011987': 'euc-kr',
    'csbig5': 'big5'
  };

  return mappings[normalized] || encoding;
}

/**
 * 检查是否为有效的 UTF-8
 */
function isValidUTF8(buffer: Buffer): boolean {
  try {
    const decoded = buffer.toString('utf-8');
    const reencoded = Buffer.from(decoded, 'utf-8');
    return buffer.equals(reencoded);
  } catch {
    return false;
  }
}

/**
 * 检测中文编码
 */
function detectChineseEncoding(bytes: number[]): { encoding: string; confidence: number } {
  let gbkScore = 0;
  let big5Score = 0;

  for (let i = 0; i < bytes.length - 1; i++) {
    const byte1 = bytes[i];
    const byte2 = bytes[i + 1];

    // GBK 范围检测
    if (byte1 >= 0x81 && byte1 <= 0xFE && byte2 >= 0x40 && byte2 <= 0xFE && byte2 !== 0x7F) {
      gbkScore++;
    }

    // Big5 范围检测
    if (byte1 >= 0xA1 && byte1 <= 0xFE &&
        ((byte2 >= 0x40 && byte2 <= 0x7E) || (byte2 >= 0xA1 && byte2 <= 0xFE))) {
      big5Score++;
    }
  }

  if (gbkScore > big5Score && gbkScore > 10) {
    return { encoding: 'gbk', confidence: Math.min(gbkScore / 100, 0.9) };
  }

  if (big5Score > 10) {
    return { encoding: 'big5', confidence: Math.min(big5Score / 100, 0.9) };
  }

  return { encoding: 'unknown', confidence: 0 };
}

/**
 * 检测日文编码
 */
function detectJapaneseEncoding(bytes: number[]): { encoding: string; confidence: number } {
  let shiftJisScore = 0;
  let eucJpScore = 0;

  for (let i = 0; i < bytes.length - 1; i++) {
    const byte1 = bytes[i];
    const byte2 = bytes[i + 1];

    // Shift_JIS 检测
    if ((byte1 >= 0x81 && byte1 <= 0x9F) || (byte1 >= 0xE0 && byte1 <= 0xEF)) {
      if ((byte2 >= 0x40 && byte2 <= 0x7E) || (byte2 >= 0x80 && byte2 <= 0xFC)) {
        shiftJisScore++;
      }
    }

    // EUC-JP 检测
    if (byte1 >= 0xA1 && byte1 <= 0xFE && byte2 >= 0xA1 && byte2 <= 0xFE) {
      eucJpScore++;
    }
  }

  if (shiftJisScore > eucJpScore && shiftJisScore > 10) {
    return { encoding: 'shift_jis', confidence: Math.min(shiftJisScore / 100, 0.9) };
  }

  if (eucJpScore > 10) {
    return { encoding: 'euc-jp', confidence: Math.min(eucJpScore / 100, 0.9) };
  }

  return { encoding: 'unknown', confidence: 0 };
}

/**
 * 检测韩文编码
 */
function detectKoreanEncoding(bytes: number[]): boolean {
  let eucKrScore = 0;

  for (let i = 0; i < bytes.length - 1; i++) {
    const byte1 = bytes[i];
    const byte2 = bytes[i + 1];

    if (byte1 >= 0xA1 && byte1 <= 0xFE && byte2 >= 0xA1 && byte2 <= 0xFE) {
      eucKrScore++;
    }
  }

  return eucKrScore > 10;
}

/**
 * 检测欧洲编码
 */
function detectEuropeanEncoding(bytes: number[]): { encoding: string; confidence: number } {
  let latin1Score = 0;
  let windows1252Score = 0;

  for (const byte of bytes) {
    // Windows-1252 特有字符
    if (byte >= 0x80 && byte <= 0x9F) {
      windows1252Score++;
    }

    // 高位字符
    if (byte >= 0xA0 && byte <= 0xFF) {
      latin1Score++;
    }
  }

  if (windows1252Score > 5) {
    return { encoding: 'windows-1252', confidence: 0.7 };
  }

  if (latin1Score > 10) {
    return { encoding: 'iso-8859-1', confidence: 0.6 };
  }

  return { encoding: 'unknown', confidence: 0 };
}

const NODE_BUFFER_ENCODINGS = new Set([
  'ascii', 'utf8', 'utf-8', 'utf16le', 'utf-16le',
  'ucs2', 'ucs-2', 'base64', 'base64url', 'latin1', 'binary', 'hex',
]);

/**
 * 安全解码 Buffer 为字符串
 *
 * 对于 Node.js Buffer 原生支持的编码（utf-8/ascii/latin1 等）使用 Buffer.toString()；
 * 对于非原生编码（gbk/shift_jis/euc-jp/big5/euc-kr/windows-1252 等）使用 TextDecoder。
 */
export function safeDecodeBuffer(
  buffer: Buffer,
  encoding?: string,
  headers?: Record<string, string>
): {
  content: string;
  encoding: string;
  confidence: number;
} {
  let detectedEncoding = encoding;
  let confidence = 1.0;

  if (!detectedEncoding) {
    const htmlSnippet = buffer.subarray(0, 4096).toString('ascii');
    const detection = detectEncoding(buffer, headers, htmlSnippet);
    detectedEncoding = detection.encoding;
    confidence = detection.confidence;
  }

  try {
    if (NODE_BUFFER_ENCODINGS.has(detectedEncoding.toLowerCase())) {
      const content = buffer.toString(detectedEncoding as BufferEncoding);
      return { content, encoding: detectedEncoding, confidence };
    }

    const decoder = new TextDecoder(detectedEncoding);
    const content = decoder.decode(buffer);
    return { content, encoding: detectedEncoding, confidence };
  } catch {
    try {
      const content = buffer.toString('utf-8');
      return { content, encoding: 'utf-8', confidence: 0.5 };
    } catch {
      const content = buffer.toString('latin1');
      return { content, encoding: 'latin1', confidence: 0.1 };
    }
  }
}
