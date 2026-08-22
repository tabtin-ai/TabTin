import type { SessionShareStatus } from '@/services/tabchatApi'

export function isOutgoingSessionShare(params: {
  ownerUserId: string
  currentUserId: string
}): boolean {
  return params.ownerUserId === params.currentUserId
}

export interface SessionShareManagementState {
  showCurrentPeer: boolean
  showTier: boolean
  canRevoke: boolean
  canResume: boolean
  statusLabel: 'pending' | 'revoked' | null
}

export function resolveSessionShareManagementState(
  status: SessionShareStatus,
): SessionShareManagementState {
  if (status === 'pending') {
    return {
      showCurrentPeer: false,
      showTier: false,
      canRevoke: true,
      canResume: false,
      statusLabel: 'pending',
    }
  }
  if (status === 'revoked') {
    return {
      showCurrentPeer: false,
      showTier: false,
      canRevoke: false,
      canResume: true,
      statusLabel: 'revoked',
    }
  }
  return {
    showCurrentPeer: true,
    showTier: true,
    canRevoke: true,
    canResume: false,
    statusLabel: null,
  }
}

export function resolveSharedSessionRowState(
  status: SessionShareStatus,
  outgoing: boolean,
): Pick<SessionShareManagementState, 'showTier' | 'statusLabel'> & { disabled: boolean } {
  const state = resolveSessionShareManagementState(status)
  return {
    disabled: status === 'pending' || (status === 'revoked' && !outgoing),
    showTier: state.showTier,
    statusLabel: state.statusLabel,
  }
}
