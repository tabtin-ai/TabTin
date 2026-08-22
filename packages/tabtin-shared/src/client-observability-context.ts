export type ClientPlatform = 'desktop' | 'ios' | 'android'

export type ClientRuntime =
  | 'electron-main'
  | 'electron-renderer'
  | 'electron-preload'
  | 'ios-native'
  | 'ios-webview'
  | 'android-native'
  | 'android-webview'

export type ClientErrorCategory =
  | 'CLIENT_CRASH'
  | 'RENDERER_CRASH'
  | 'GPU_CRASH'
  | 'WEBVIEW_CRASH'
  | 'STARTUP_FATAL'
  | 'IPC_FATAL'
  | 'AGENT_RUN_FATAL'
  | 'AGENT_DOOM_LOOP'
  | 'AGENT_PROTOCOL_FATAL'
  | 'NETWORK_FATAL'
  | 'AUTH_FATAL'
  | 'LOCAL_DATA_FATAL'
  | 'RESOURCE_FATAL'
  | 'HANG'
  | 'ABNORMAL_TERMINATION'
  | 'UNKNOWN_FATAL'

export type ClientErrorSeverity = 'debug' | 'recoverable' | 'actionable' | 'fatal' | 'crash'
export type ClientErrorRecoverability = 'recovered' | 'degraded' | 'unrecoverable' | 'unknown'

export interface SafeSentryContextInput {
  source: 'client'
  service: 'tabtin-client'
  clientPlatform: ClientPlatform
  runtime: ClientRuntime
  environment: 'local' | 'development' | 'preprod' | 'production'
  release: string
  releaseChannel?: string
  errorCategory: ClientErrorCategory
  errorCode: string
  severity: ClientErrorSeverity
  handledBy: string
  recoverability: ClientErrorRecoverability
  userId?: string
  organizationId?: string
  workspaceId?: string
  spaceId?: string
  clientInstallId?: string
  agentId?: string
  sessionId?: string
  runId?: string
  traceId?: string
  requestId?: string
  taskId?: string
  diagnosticBundleId?: string
  appVersion?: string
  buildNumber?: string
  gitSha?: string
  platform?: ClientPlatform
}

function setIfPresent(target: Record<string, string>, key: string, value?: string): void {
  if (value) target[key] = value
}

export function buildSafeSentryContext(input: SafeSentryContextInput) {
  const tags: Record<string, string> = {
    source: input.source,
    service: input.service,
    client_platform: input.clientPlatform,
    runtime: input.runtime,
    environment: input.environment,
    release: input.release,
    error_category: input.errorCategory,
    error_code: input.errorCode,
    severity: input.severity,
    handled_by: input.handledBy,
    recoverability: input.recoverability,
  }
  setIfPresent(tags, 'release_channel', input.releaseChannel)

  const tabtin: Record<string, string> = {}
  setIfPresent(tabtin, 'organization_id', input.organizationId)
  setIfPresent(tabtin, 'workspace_id', input.workspaceId)
  setIfPresent(tabtin, 'space_id', input.spaceId)
  setIfPresent(tabtin, 'client_install_id', input.clientInstallId)
  setIfPresent(tabtin, 'agent_id', input.agentId)
  setIfPresent(tabtin, 'session_id', input.sessionId)
  setIfPresent(tabtin, 'run_id', input.runId)
  setIfPresent(tabtin, 'trace_id', input.traceId)
  setIfPresent(tabtin, 'request_id', input.requestId)
  setIfPresent(tabtin, 'task_id', input.taskId)
  setIfPresent(tabtin, 'diagnostic_bundle_id', input.diagnosticBundleId)
  setIfPresent(tabtin, 'app_version', input.appVersion)
  setIfPresent(tabtin, 'build_number', input.buildNumber)
  setIfPresent(tabtin, 'git_sha', input.gitSha)
  setIfPresent(tabtin, 'platform', input.platform)

  return {
    tags,
    contexts: { tabtin },
    ...(input.userId ? { user: { id: input.userId } } : {}),
  }
}
