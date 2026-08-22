/**
 * TrackerRun.status → UI 显示态。
 *
 * Agent 侧栏 / Run 会话指示器 / breadcrumb 必须共用同一口径，
 * 避免后端 `completed` 与历史 `success` 在不同组件里一个绿一个黄。
 */

export type TrackerRunDisplayStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'pending'

export function displayFromRunStatus(status?: string | null): TrackerRunDisplayStatus {
  const s = (status ?? '').toLowerCase()
  if (s === 'success' || s === 'completed') return 'success'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'cancelled' || s === 'canceled' || s === 'aborted') return 'cancelled'
  if (s === 'running' || s === 'in_progress' || s === 'waiting_device') return 'running'
  return 'pending'
}

export function isSuccessfulRunStatus(status?: string | null): boolean {
  return displayFromRunStatus(status) === 'success'
}
