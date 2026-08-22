/**
 * BrowserView loadURL Preview Guard — phase 1.
 *
 * Pure decision only: does not open Preview Modal, does not touch Preview store.
 * Callers skip webContents.loadURL when action === 'block-preview'.
 */

import {
  resolveOpenIntent,
  type OpenIntent,
  type ResolveOpenIntentInput,
} from './open-intent'

export interface GuardLoadURLInput {
  url: string
  filename?: string
  mimeType?: string
  assetId?: string
  forceBrowser?: boolean
  /** Call-site tag for logs / future telemetry */
  source?: string
}

export type GuardLoadURLDecision =
  | { action: 'allow' }
  | { action: 'block-preview'; intent: Extract<OpenIntent, { kind: 'preview' }> }

/**
 * Decide whether a URL may proceed to webContents.loadURL.
 *
 * - preview → block-preview (do not load)
 * - browser / unknown → allow
 * - forceBrowser → allow (via resolveOpenIntent)
 */
export function guardLoadURL(input: GuardLoadURLInput): GuardLoadURLDecision {
  const intentInput: ResolveOpenIntentInput = {
    url: input.url,
    filename: input.filename,
    mimeType: input.mimeType,
    assetId: input.assetId,
    forceBrowser: input.forceBrowser,
  }
  const intent = resolveOpenIntent(intentInput)

  if (intent.kind === 'preview') {
    return { action: 'block-preview', intent }
  }

  return { action: 'allow' }
}

/** True when loadURL should proceed. */
export function shouldAllowLoadURL(input: GuardLoadURLInput): boolean {
  return guardLoadURL(input).action === 'allow'
}
