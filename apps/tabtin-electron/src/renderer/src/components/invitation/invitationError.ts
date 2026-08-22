function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export interface InvitationErrorDetails {
  errorCode: string
  status?: number
  apiMessage: string
  message: string
  errorName: string
}

export function getInvitationErrorDetails(error: unknown): InvitationErrorDetails {
  const root = asRecord(error)
  const response = asRecord(root?.response)
  const responseData = asRecord(response?.data)
  const data = asRecord(root?.data)
  const apiMessage = asString(responseData?.message) || asString(data?.message)
  const rootMessage = asString(root?.message)

  return {
    errorCode: asString(responseData?.error_code) || asString(data?.error_code),
    status: asNumber(root?.status) ?? asNumber(response?.status),
    apiMessage,
    message: apiMessage || rootMessage || (error instanceof Error ? error.message : ''),
    errorName: error instanceof Error ? error.name : 'UnknownError',
  }
}
