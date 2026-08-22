/**
 * Shared decision for whether a host may reuse an existing runtime session.
 *
 * Platform adapters supply host-specific predicates (soft-reconfigure
 * eligibility, extra match fields). Core owns the decision table so Electron
 * and Daemon cannot drift on the reuse / soft-reconfigure / rebuild fork.
 */

export type RuntimeReuseDecision =
  | { kind: 'reuse' }
  | { kind: 'soft-reconfigure' }
  | { kind: 'rebuild' }

export interface RuntimeReuseInput {
  /** Whether a session entry already exists for this session id. */
  hasExisting: boolean
  /** Shared baked cache-key fields match (model, rules, owner, space, …). */
  bakedFieldsMatch: boolean
  /** Current request agentMode equals the cached session agentMode. */
  agentModeMatches: boolean
  /**
   * Whether soft-reconfigure is allowed when only agentMode changed.
   * Both Electron and Daemon allow it when the shell-restriction tier is
   * unchanged (`canSoftReconfigure` / `getRestrictedShellAllowlist`).
   */
  softReconfigureAllowed: boolean
  /**
   * Extra match fields shared by both hosts (disabledApps / disabledToolPrefixes).
   * Defaults to true when omitted.
   */
  extraFieldsMatch?: boolean
}

export function decideRuntimeReuse(
  input: RuntimeReuseInput,
): RuntimeReuseDecision {
  if (!input.hasExisting) return { kind: 'rebuild' }

  const extraFieldsMatch = input.extraFieldsMatch ?? true
  if (!input.bakedFieldsMatch || !extraFieldsMatch) {
    return { kind: 'rebuild' }
  }

  if (input.agentModeMatches) {
    return { kind: 'reuse' }
  }

  if (input.softReconfigureAllowed) {
    return { kind: 'soft-reconfigure' }
  }

  return { kind: 'rebuild' }
}
