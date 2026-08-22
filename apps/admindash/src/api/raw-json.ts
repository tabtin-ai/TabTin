import { getApiClient } from './tabtin-client'

function getErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  const directMessage = record.message
  if (typeof directMessage === 'string' && directMessage.trim()) return directMessage
  const detail = record.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    const detailMessage = (detail as Record<string, unknown>).message
    if (typeof detailMessage === 'string' && detailMessage.trim()) return detailMessage
  }
  return fallback
}

export async function rawJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await getApiClient().raw(method, path, {
    rawResponse: true,
    ...(body === undefined ? {} : { body }),
  }) as Response

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    throw new Error('响应内容为空')
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `HTTP ${response.status}`))
  }

  if (payload && typeof payload === 'object' && 'success' in payload) {
    const record = payload as Record<string, unknown>
    if (record.success === false) {
      throw new Error(getErrorMessage(payload, '操作失败'))
    }
  }

  return payload as T
}
