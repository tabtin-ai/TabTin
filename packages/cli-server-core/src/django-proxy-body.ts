/**
 * Django 代理响应体解码（Electron / Daemon 共用）。
 *
 * Go CLI 的 `--output` 写盘协议约定：
 * - `{ __binary: true, content_type, base64 }` → base64 解码后写原始 bytes
 * - `{ __passthrough: true, content_type, raw }` → 文本透传（CSV 等）
 * - 其它 → JSON 或 `{ raw }` 文本回退
 *
 * 若把 xlsx/pdf 等二进制当 UTF-8 解码，非法字节会变成 U+FFFD（ef bf bd），
 * ZIP/Office 文件损坏（见 ）。
 */

export interface DjangoBinaryEnvelope {
  __binary: true
  content_type: string
  base64: string
}

export interface DjangoPassthroughEnvelope {
  __passthrough: true
  content_type: string
  raw: string
}

export interface DjangoRawTextEnvelope {
  raw: string
}

/** JSON 对象、或上述三种信封。 */
export type DjangoProxyBody =
  | DjangoBinaryEnvelope
  | DjangoPassthroughEnvelope
  | DjangoRawTextEnvelope
  | Record<string, unknown>

function isTextContentType(contentType: string): boolean {
  return (
    contentType.includes('application/json') ||
    contentType.includes('text/') ||
    contentType.includes('application/xml') ||
    contentType.includes('application/javascript')
  )
}

function isPassthroughContentType(contentType: string): boolean {
  return (
    contentType.includes('text/csv') ||
    contentType.includes('text/tab-separated-values')
  )
}

function isValidUtf8(raw: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw)
    return true
  } catch {
    return false
  }
}

function asBinaryEnvelope(contentType: string, raw: Buffer): DjangoBinaryEnvelope {
  return {
    __binary: true,
    content_type: contentType,
    base64: raw.toString('base64'),
  }
}

/**
 * 按 Content-Type 解码 Django 响应体，供宿主 `djangoRequest` 使用。
 * 不含宿主专有的 401 处理（Electron 刷新 token / Daemon AUTH_EXPIRED）。
 *
 * Content-Type 缺失时：非法 UTF-8 体走 `__binary`（application/octet-stream），
 * 避免再落入 toString('utf-8') 污染路径。
 */
export function decodeDjangoProxyBody(
  contentType: string | undefined | null,
  raw: Buffer,
): DjangoProxyBody {
  const ct = contentType || ''

  if (ct && !isTextContentType(ct)) {
    return asBinaryEnvelope(ct, raw)
  }

  if (!ct && !isValidUtf8(raw)) {
    return asBinaryEnvelope('application/octet-stream', raw)
  }

  if (isPassthroughContentType(ct)) {
    return {
      __passthrough: true,
      content_type: ct,
      raw: raw.toString('utf-8'),
    }
  }

  const text = raw.toString('utf-8')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { raw: text }
  }
}
