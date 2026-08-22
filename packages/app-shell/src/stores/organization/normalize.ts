import type { Organization, OrganizationType } from '../../types/organization.js'

export const normalizeString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export const normalizeOrganization = (value: unknown): Organization | null => {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<Organization> & Record<string, unknown>
  const id = normalizeString(raw.id, '').trim()
  if (!id) return null

  const now = new Date().toISOString()
  const name = normalizeString(raw.name, '').trim() || 'Untitled Organization'
  const description = normalizeString(raw.description, '').trim()
  const icon = normalizeString(raw.icon, '').trim()
  const ownerId = normalizeString(raw.owner_id, '')
  const createdAt = normalizeString(raw.created_at, now)
  const updatedAt = normalizeString(raw.updated_at, createdAt || now)
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings
    : undefined

  const VALID_TYPES = new Set<OrganizationType>(['personal', 'team'])
  const rawType = raw.type as OrganizationType | undefined
  const type: OrganizationType = rawType && VALID_TYPES.has(rawType)
    ? rawType
    : (Boolean(raw.is_default) ? 'personal' : 'team')

  return {
    id,
    name,
    description: description || undefined,
    icon: icon || undefined,
    type,
    owner_id: ownerId,
    is_default: Boolean(raw.is_default),
    settings,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

export const normalizeOrganizationList = (value: unknown): Organization[] => {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeOrganization(item))
    .filter((item): item is Organization => item !== null)
}
