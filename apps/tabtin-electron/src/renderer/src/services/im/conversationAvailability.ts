function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The IM control plane keeps old clients compatible by returning HTTP 200
 * while carrying the real error status in the response envelope.
 */
export function isConversationNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.status === 404) return true

  const data = isRecord(error.data) ? error.data : undefined
  if (data?.code === 404) return true

  const response = isRecord(error.response) ? error.response : undefined
  const responseData = isRecord(response?.data) ? response.data : undefined
  return response?.status === 404 || responseData?.code === 404
}
