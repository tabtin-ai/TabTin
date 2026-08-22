import {
  getRestrictedShellAllowlist,
  type AgentModeName,
} from '@tabtin/agent-modes'

/**
 * Soft-reconfigure is allowed only when the shell-restriction tier is unchanged.
 * Crossing ask/plan/study ↔ agent/group/yolo must rebuild (ShellCap is baked).
 */
export function canSoftReconfigureByShellTier(
  existingMode: AgentModeName,
  requestedMode: AgentModeName,
): boolean {
  return (
    getRestrictedShellAllowlist(existingMode)
    === getRestrictedShellAllowlist(requestedMode)
  )
}
