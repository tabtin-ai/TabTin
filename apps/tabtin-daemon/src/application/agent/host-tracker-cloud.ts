import { joinApiPath } from '@tabtin/config'

export type HostTrackerAuth = {
  token: string
  apiBaseUrl: string
  fingerprint: string
}

export type HostScheduleSnapshot = {
  items: Array<{
    trackerId: string
    triggerType: string
    triggerConfig: Record<string, unknown>
    lastRunAt?: string | null
    createdAt?: string | null
  }>
  work: Array<{ runId: string }>
}

export type HostTrackerPrepareResult = {
  sessionId: string
  agentId?: string
  workspaceId?: string
  prompt: string
  modelId?: string
  taskId?: string
  appContext?: Record<string, unknown>
}

function hostTrackerHeaders(auth: HostTrackerAuth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'X-Device-Fingerprint': auth.fingerprint,
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}

export async function fetchHostTrackerSnapshot(
  auth: HostTrackerAuth,
  fetchFn: typeof fetch = fetch,
): Promise<HostScheduleSnapshot> {
  const response = await fetchFn(joinApiPath(auth.apiBaseUrl, '/tracker/host-schedule'), {
    signal: AbortSignal.timeout(15_000),
    headers: hostTrackerHeaders(auth),
  })
  if (!response.ok) {
    throw new Error(`Host tracker schedule failed: HTTP ${response.status}`)
  }
  const body = await readJson(response) as {
    success?: boolean
    data?: {
      items?: Array<{
        id?: string
        trigger_type?: string
        trigger_config?: Record<string, unknown>
        last_run_at?: string | null
        created_at?: string | null
      }>
      work?: Array<{ run_id?: string }>
    }
  }
  if (body.success !== true || !Array.isArray(body.data?.items)) {
    throw new Error('Host tracker schedule returned invalid response')
  }
  const items = body.data.items.flatMap((item) => {
    const trackerId = typeof item.id === 'string' ? item.id : ''
    const triggerType = typeof item.trigger_type === 'string' ? item.trigger_type : ''
    if (!trackerId || !triggerType) return []
    return [{
      trackerId,
      triggerType,
      triggerConfig: item.trigger_config && typeof item.trigger_config === 'object'
        ? item.trigger_config
        : {},
      lastRunAt: item.last_run_at,
      createdAt: item.created_at,
    }]
  })
  const work = Array.isArray(body.data.work)
    ? body.data.work.flatMap((item) => {
        const runId = typeof item.run_id === 'string' ? item.run_id : ''
        return runId ? [{ runId }] : []
      })
    : []
  return { items, work }
}

export async function fireHostTracker(
  auth: HostTrackerAuth,
  trackerId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(
    joinApiPath(auth.apiBaseUrl, `/tracker/host-schedule/${encodeURIComponent(trackerId)}/fire`),
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: hostTrackerHeaders(auth),
    },
  )
  if (!response.ok) {
    throw new Error(`Host tracker fire failed: HTTP ${response.status}`)
  }
  const body = await readJson(response) as { success?: boolean }
  if (body.success !== true) {
    throw new Error('Host tracker fire returned invalid response')
  }
}

export async function reconcileHostTrackerLifecycle(
  auth: HostTrackerAuth,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(joinApiPath(auth.apiBaseUrl, '/tracker/host-schedule/reconcile'), {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: hostTrackerHeaders(auth),
  })
  if (!response.ok) {
    throw new Error(`Host tracker reconcile failed: HTTP ${response.status}`)
  }
  const body = await readJson(response) as { success?: boolean }
  if (body.success !== true) {
    throw new Error('Host tracker reconcile returned invalid response')
  }
}

export async function prepareHostTrackerRun(
  auth: HostTrackerAuth,
  runId: string,
  fetchFn: typeof fetch = fetch,
): Promise<HostTrackerPrepareResult> {
  const response = await fetchFn(
    joinApiPath(auth.apiBaseUrl, `/tracker/host-schedule/runs/${encodeURIComponent(runId)}/prepare`),
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: hostTrackerHeaders(auth),
    },
  )
  if (!response.ok) {
    throw new Error(`Host tracker prepare failed: HTTP ${response.status}`)
  }
  const body = await readJson(response) as {
    success?: boolean
    data?: {
      session_id?: string
      agent_id?: string
      workspace_id?: string
      prompt?: string
      model_id?: string
      task_id?: string
      app_context?: Record<string, unknown>
    }
  }
  if (body.success !== true || !body.data?.session_id || !body.data.prompt) {
    throw new Error('Host tracker prepare returned invalid response')
  }
  return {
    sessionId: body.data.session_id,
    agentId: body.data.agent_id,
    workspaceId: body.data.workspace_id,
    prompt: body.data.prompt,
    modelId: body.data.model_id,
    taskId: body.data.task_id,
    appContext: body.data.app_context,
  }
}

export async function finalizeHostTrackerRun(
  auth: HostTrackerAuth,
  runId: string,
  error = '',
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(
    joinApiPath(auth.apiBaseUrl, `/tracker/host-schedule/runs/${encodeURIComponent(runId)}/finalize`),
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: hostTrackerHeaders(auth),
      body: JSON.stringify({ error }),
    },
  )
  if (!response.ok) {
    throw new Error(`Host tracker finalize failed: HTTP ${response.status}`)
  }
}
