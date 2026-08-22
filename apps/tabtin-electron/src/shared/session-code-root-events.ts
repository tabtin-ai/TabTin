export const SESSION_CODE_ROOT_CHANGED_CHANNEL =
  'agent-engine:session-code-root-changed' as const

export interface SessionCodeRootChangedEvent {
  sessionId: string
  spaceId: string
  tabScopeKey: string
  previousRootPath: string
  rootPath: string
  branch: string | null
  revision: number
  created: boolean
  source: 'agent_cli'
}
