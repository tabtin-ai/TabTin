import type { TableGridEngine, TableGridEngineId } from './types'

const normalizeEngineId = (engineId: string | null | undefined): string | null => {
  if (!engineId) {
    return null
  }

  const normalized = engineId.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

export interface ReadTableGridEnginePreferenceInput {
  locationSearch?: string | null
  storageValue?: string | null
  queryKey?: string
  defaultEngineId?: TableGridEngineId
}

export const readTableGridEnginePreference = (
  input: ReadTableGridEnginePreferenceInput = {}
): TableGridEngineId => {
  const {
    locationSearch = '',
    storageValue = null,
    queryKey = 'tableEngine',
    defaultEngineId = 'canvas',
  } = input

  const searchParams = new URLSearchParams(locationSearch ?? '')
  const searchEngine = normalizeEngineId(searchParams.get(queryKey))
  if (searchEngine) {
    return searchEngine
  }

  const storageEngine = normalizeEngineId(storageValue)
  if (storageEngine) {
    return storageEngine
  }

  return defaultEngineId
}

export interface ReadTableGridEnginePreferenceFromBrowserInput {
  storageKey?: string
  queryKey?: string
  defaultEngineId?: TableGridEngineId
}

export const readTableGridEnginePreferenceFromBrowser = (
  input: ReadTableGridEnginePreferenceFromBrowserInput = {}
): TableGridEngineId => {
  const {
    storageKey = 'tabtin.tableEngine',
    queryKey = 'tableEngine',
    defaultEngineId = 'canvas',
  } = input

  if (typeof window === 'undefined') {
    return defaultEngineId
  }

  let storageValue: string | null = null
  try {
    storageValue = window.localStorage.getItem(storageKey)
  } catch {
    storageValue = null
  }

  return readTableGridEnginePreference({
    locationSearch: window.location.search,
    storageValue,
    queryKey,
    defaultEngineId,
  })
}

export interface ResolveTableGridEngineInput {
  preferredEngineId?: TableGridEngineId | null
  fallbackEngineId?: TableGridEngineId
}

export const resolveTableGridEngine = <T extends TableGridEngine>(
  engines: readonly T[],
  input: ResolveTableGridEngineInput = {}
): T => {
  if (engines.length === 0) {
    throw new Error('[table-engine] At least one grid engine must be provided')
  }

  const { preferredEngineId, fallbackEngineId } = input

  const preferredId = normalizeEngineId(preferredEngineId)
  if (preferredId) {
    const preferredEngine = engines.find(engine => normalizeEngineId(engine.id) === preferredId)
    if (preferredEngine) {
      return preferredEngine
    }
  }

  const fallbackId = normalizeEngineId(fallbackEngineId)
  if (fallbackId) {
    const fallbackEngine = engines.find(engine => normalizeEngineId(engine.id) === fallbackId)
    if (fallbackEngine) {
      return fallbackEngine
    }
  }

  return engines[0]
}
