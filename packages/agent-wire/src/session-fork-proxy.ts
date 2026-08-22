/**
 * Shared POST /api/chat/sessions/:id/fork proxy logic for Electron CLI server and Daemon.
 * Keeps validation and path construction identical across runtimes.
 */

export type DjangoHttpResult = { status: number; data: unknown }

export type SessionForkDjangoRequest = (
  method: 'POST',
  path: string,
  body: Record<string, unknown>,
  opts: { logTag: string },
) => Promise<DjangoHttpResult>

export type SessionForkBody = {
  session_id?: string
  message_id?: string
}

export type ProxySessionForkOutcome =
  | { kind: 'bad_request'; message: string }
  | { kind: 'response'; response: DjangoHttpResult }

/**
 * Forwards fork request to Django. Callers map `bad_request` / non-2xx to their error envelope.
 */
export async function proxyChatSessionFork(
  djangoRequest: SessionForkDjangoRequest,
  body: SessionForkBody,
  logTag: string,
): Promise<ProxySessionForkOutcome> {
  const sessionId = body?.session_id
  if (!sessionId || typeof sessionId !== 'string') {
    return { kind: 'bad_request', message: '缺少 session_id' }
  }

  const payload: Record<string, unknown> = {}
  if (body?.message_id !== undefined && body?.message_id !== null && body?.message_id !== '') {
    payload.message_id = body.message_id
  }

  const path = `/api/chat/sessions/${encodeURIComponent(sessionId)}/fork`
  const response = await djangoRequest('POST', path, payload, { logTag })
  return { kind: 'response', response }
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300
}
