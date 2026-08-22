import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlTrace')

type TraceListResponse = {
  items?: Array<{ trace_id?: string; status?: string }>
  data?: Array<{ trace_id?: string; status?: string }>
  results?: Array<{ trace_id?: string; status?: string }>
  traces?: Array<{ trace_id?: string; status?: string }>
}

function pickRunningTraceId(payload: TraceListResponse | null): string | null {
  if (!payload) return null
  const candidates =
    payload.items ||
    payload.data ||
    payload.results ||
    payload.traces ||
    []
  const running = candidates.find(trace => trace.status === 'running' && trace.trace_id)
  return running?.trace_id || null
}

const FETCH_TIMEOUT_MS = 10_000

async function fetchTraceList(url: string, token?: string): Promise<TraceListResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    return response.json() as Promise<TraceListResponse>
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      log.warn('fetch timed out:', { url, timeoutMs: FETCH_TIMEOUT_MS })
    } else {
      log.warn('fetch failed:', { url, err })
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveRunningTraceId(params: {
  baseURL: string
  threadId: string
  token?: string
}): Promise<string | null> {
  const { baseURL, threadId, token } = params
  const query = `thread_id=${encodeURIComponent(threadId)}`
  const candidateUrls = [
    `${baseURL}/agent/user/traces?${query}`,
    `${baseURL}/agent/debug/traces?${query}`,
  ]

  for (const url of candidateUrls) {
    const list = await fetchTraceList(url, token)
    const running = pickRunningTraceId(list)
    if (running) return running
  }

  return null
}
