export interface DaemonConfig {
  server_url: string
  ws_url: string
  device_id: string
  fingerprint: string
  credential: string
  organization_id: string
  user_id?: string
  device_name: string
  plugins: string[]
  capabilities: string[]
  log_level: 'debug' | 'info' | 'warn' | 'error'
  log_file: string | null
  heartbeat_interval_ms: number
  proxy: string | null
  workspace_root?: string
  sentry_dsn?: string | null
  daemon_control_enabled?: boolean
  daemon_control_api_base_url?: string | null
  daemon_control_runtime_profile_revision?: number
}

export const DEFAULT_CONFIG: Omit<
  DaemonConfig,
  'server_url' | 'ws_url' | 'device_id' | 'fingerprint' | 'credential' | 'organization_id' | 'device_name'
> = {
  plugins: [],
  capabilities: ['terminal_execute', 'file'],
  log_level: 'info',
  log_file: null,
  heartbeat_interval_ms: 15_000,
  proxy: null,
  daemon_control_enabled: false,
}

export interface InstallToken {
  organization_id: string
  user_id: string
  device_name: string
  expires_at: string
  scope: 'device_register'
  server_url: string
  ws_url: string
}

export interface DeviceCredential {
  device_id: string
  access_token: string
  organization_id: string
}

export type LastExitReason =
  | 'auth_fatal'
  | 'device_removed'
  | 'drain_complete'
  | 'drain_timeout'
  | 'crash'

export interface LastExitInfo {
  reason: LastExitReason
  timestamp: number
  message: string
  exit_code: number
  action_required?: 'reinit' | 'contact_admin' | 'none'
  context?: Record<string, unknown>
}

export type FatalExitHandler = (message?: string) => void
export type DaemonState = 'stopped' | 'running' | 'draining'
