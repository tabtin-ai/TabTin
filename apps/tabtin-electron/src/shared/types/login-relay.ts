export interface LoginRelayStartRequest {
  spaceId: string
  organizationId: string
  domain: string
}

export interface LoginRelayCompleteRequest {
  relayId: string
  threadId: string
  tabId?: string
}

export interface LoginRelayCancelRequest {
  relayId: string
}

export interface LoginRelayImportResult {
  success: boolean
  imported_count?: number
  reloaded?: boolean
  error?: string
  error_code?: string
}

export interface LoginRelayStartResult {
  success: boolean
  relayId?: string
  partition?: string
  loginUrl?: string
  error?: string
}

export interface LoginRelayCompleteResult {
  success: boolean
  packageId?: string
  importResult?: LoginRelayImportResult
  error?: string
}

export interface LoginRelayCancelResult {
  success: boolean
  error?: string
}

export interface LoginRelayAPI {
  start: (request: LoginRelayStartRequest) => Promise<LoginRelayStartResult>
  complete: (request: LoginRelayCompleteRequest) => Promise<LoginRelayCompleteResult>
  cancel: (request: LoginRelayCancelRequest) => Promise<LoginRelayCancelResult>
}
