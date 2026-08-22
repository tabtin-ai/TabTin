// ---------- Overview ----------

export interface QueueInfo {
  name: string
  pending: number
  warning: boolean
}

export interface WorkerInfo {
  name: string
  active_tasks: number
}

export interface CeleryOverview {
  workers_healthy: number
  workers_total: number
  worker_list: WorkerInfo[]
  queues: QueueInfo[]
  failed_open: number
  failed_total_24h: number
  issues: string[]
}

// ---------- Failed Tasks ----------

export interface FailedTaskItem {
  id: number
  task_id: string
  task_name: string
  exception: string
  retries: number
  resolved: boolean
  failed_at: string
  resolved_at: string | null
}

export interface FailedTaskDetail extends FailedTaskItem {
  args: unknown[]
  kwargs: Record<string, unknown>
  traceback: string
}

export interface FailedTaskListResponse {
  items: FailedTaskItem[]
  total: number
  page: number
  page_size: number
}

export interface FailedTaskQuery {
  resolved?: 'all' | 'true' | 'false'
  task_name?: string
  page?: number
  page_size?: number
}

export interface BatchResolveResponse {
  resolved_count: number
}

export interface RetryResponse {
  new_task_id: string
  task_name: string
}
