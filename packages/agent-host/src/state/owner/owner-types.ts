import type { PersistedEntryOwner } from '@tabtin/agent-runtime'

export type ExecutionOwner = Pick<
  PersistedEntryOwner,
  'userId' | 'organizationId' | 'agentId'
>

export function executionOwnerScopeId(owner: ExecutionOwner): string {
  return `${owner.userId}|${owner.organizationId}`
}
