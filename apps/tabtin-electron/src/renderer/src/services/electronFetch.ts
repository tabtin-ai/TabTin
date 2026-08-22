/**
 * 将标准 Fetch API 桥接到 Electron IPC 代理（window.tabtin.apiRequest），
 * 供 @tabtin/api-client (openapi-fetch) 的 options.fetch 使用。
 *
 * 所有 HTTP 请求由 Electron main 进程通过 Node.js http/https 转发，
 * 绕过 renderer 的 CSP / CORS 限制。
 */

function extractHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

interface MultipartEntry {
  name: string
  filename?: string
  contentType?: string
  base64: string
}

async function extractBody(
  body: BodyInit | null | undefined,
): Promise<{ body?: string; multipartEntries?: MultipartEntry[] }> {
  if (body == null) return {}

  if (typeof body === 'string') {
    return { body }
  }

  if (body instanceof FormData) {
    const entries: MultipartEntry[] = []
    for (const [name, value] of body.entries()) {
      if (typeof value !== 'string' && value instanceof File) {
        const buffer = await value.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        entries.push({
          name,
          filename: value instanceof File ? value.name : undefined,
          contentType: value.type || undefined,
          base64: btoa(binary),
        })
      } else {
        entries.push({
          name,
          base64: btoa(unescape(encodeURIComponent(String(value)))),
        })
      }
    }
    return { multipartEntries: entries }
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return { body: btoa(binary) }
  }

  if (body instanceof Blob) {
    const buffer = await body.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return { body: btoa(binary) }
  }

  return { body: String(body) }
}

function normalizeHeaders(headers?: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers()
  if (!headers) return result
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      value.forEach((v) => result.append(key, v))
    } else if (value != null) {
      result.set(key, String(value))
    }
  }
  return result
}

export const electronFetch: typeof globalThis.fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  let url: string
  if (typeof input === 'string') {
    url = input
  } else if (input instanceof URL) {
    url = input.href
  } else if (input instanceof Request) {
    url = input.url
  } else {
    url = String(input)
  }

  const method = init?.method ?? 'GET'
  const headers = extractHeaders(init?.headers)
  const { body, multipartEntries } = await extractBody(init?.body)

  const result = await window.tabtin.apiRequest({
    url,
    method,
    headers,
    body,
    multipartEntries,
  })

  if (result.data?.__isBinary) {
    const raw = atob(result.data.__buffer)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i)
    }
    return new Response(bytes, {
      status: result.status ?? 200,
      statusText: result.statusText ?? 'OK',
      headers: normalizeHeaders(result.headers),
    })
  }

  const responseBody =
    result.data === undefined || result.data === null
      ? null
      : typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data)

  return new Response(responseBody, {
    status: result.status ?? 200,
    statusText: result.statusText ?? 'OK',
    headers: normalizeHeaders(result.headers),
  })
}
