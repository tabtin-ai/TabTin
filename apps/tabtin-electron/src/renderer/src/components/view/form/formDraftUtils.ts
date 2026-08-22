/**
 * Shared LocalStorage draft helpers for form components (FormPreviewer / FormBody).
 *
 * Key format: tabtin-form-draft:{namespace}:{userId}:{tableId}:{viewId}
 *   - namespace  — isolates different form scenarios (e.g. "editor", "public")
 *   - userId     — prevents cross-account draft pollution on shared devices
 */

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000 // 24 h

interface DraftData {
  values: Record<string, unknown>
  updatedAt: number
}

export type FormDraftNamespace = 'editor' | 'public' | 'embed'

export interface DraftKeyParams {
  tableId: string
  viewId: string
  /** Current user id — use "anonymous" for unauthenticated / public-share scenarios. */
  userId?: string | null
  namespace?: FormDraftNamespace
}

export function getDraftKey({ tableId, viewId, userId, namespace = 'editor' }: DraftKeyParams): string {
  const uid = userId || 'anonymous'
  return `tabtin-form-draft:${namespace}:${uid}:${tableId}:${viewId}`
}

export function readDraft(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const draft: DraftData = JSON.parse(raw)
    if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(key)
      return null
    }
    return draft.values
  } catch {
    return null
  }
}

export function writeDraft(key: string, values: Record<string, unknown>): void {
  try {
    localStorage.setItem(key, JSON.stringify({ values, updatedAt: Date.now() } satisfies DraftData))
  } catch {
    /* localStorage full or disabled */
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
