/**
 * Shared retry/error utilities for sync and outbox-flusher.
 *
 * 4xx (except 429) → not retryable (client error)
 * Everything else → retryable (network, server, unknown)
 */
export function isRetryableSyncError(err: unknown): boolean {
  let status: number | undefined
  if (typeof (err as { status?: unknown })?.status === 'number') {
    status = (err as { status: number }).status
  } else if (err instanceof Error && err.message.startsWith('API ')) {
    const parsed = parseInt(err.message.split(' ')[1] ?? '', 10)
    status = Number.isNaN(parsed) ? undefined : parsed
  }
  return !(status !== undefined && status >= 400 && status < 500 && status !== 429)
}

export function toSyncErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
