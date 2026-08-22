import { ErrorCodes } from '../../errors.js'
import type { CommandError } from '../../ports/index.js'

export interface ApiSuccessEnvelope<T> {
  success?: boolean
  data?: T
  message?: string
}

export function extractApiError(err: unknown): CommandError {
  if (err && typeof err === 'object') {
    const error = err as Record<string, unknown>
    if ('response' in error && error.response && typeof error.response === 'object') {
      const response = error.response as Record<string, unknown>
      const status = response.status as number | undefined
      const data = response.data as Record<string, unknown> | undefined
      const message = data?.message ?? data?.detail ?? data?.error ?? JSON.stringify(data)
      return { code: `API_ERROR_${status ?? 'UNKNOWN'}`, message: String(message) }
    }
    if ('message' in error) {
      return { code: ErrorCodes.API_ERROR, message: String(error.message) }
    }
  }
  return { code: ErrorCodes.API_ERROR, message: String(err) }
}

export function unwrapApiData<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new Error('Malformed API response')
  }
  const envelope = value as ApiSuccessEnvelope<T>
  if (envelope.success === false) {
    throw new Error(envelope.message ?? 'API request failed')
  }
  if (envelope.data === undefined) {
    throw new Error('Missing API response data')
  }
  return envelope.data
}
