import type { PPTElement } from '../types/slides'
import { convertBackendElement, type BackendSlideElement } from '../exports/backend-adapter'

export function normalizeCollabElement(raw: Record<string, unknown>): PPTElement {
  const converted = convertBackendElement(raw as unknown as BackendSlideElement)
  return (converted ?? raw) as PPTElement
}

export function normalizeCollabElements(rawElements: Record<string, unknown>[] | null | undefined): PPTElement[] {
  if (!Array.isArray(rawElements) || rawElements.length === 0) return []
  return rawElements.map((el) => normalizeCollabElement(el))
}
