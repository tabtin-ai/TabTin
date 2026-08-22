import { resolveUserDisplayName } from './userDisplayName'

/** Link cell values are denormalized and can contain legacy UUID fallbacks. */
export const UNNAMED_RECORD_DISPLAY_NAME = '未命名记录'

const SERIALIZED_USER_VALUE_PATTERN = /^\[\s*\{\s*['"](?:id|user_id|open_id)['"]\s*:/

const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])

interface ResolvePrimaryFieldRecordTitleOptions {
  fieldType?: string
  userDisplayNameById?: ReadonlyMap<string, string>
}

/** Resolve the readable title used by a sub-record parent link from its primary field. */
export function resolvePrimaryFieldRecordTitle(
  value: unknown,
  options: ResolvePrimaryFieldRecordTitleOptions = {},
): string | undefined {
  if (USER_FIELD_TYPES.has(options.fieldType ?? '')) {
    const values = Array.isArray(value) ? value : value == null ? [] : [value]
    const names = values.flatMap((item) => {
      if (typeof item === 'string') {
        return resolveUserDisplayName(item, {
          resolvedNameById: options.userDisplayNameById,
        }) ?? []
      }
      if (!item || typeof item !== 'object') return []

      const user = item as Record<string, unknown>
      const id = String(user.id ?? user.user_id ?? user.open_id ?? '')
      return resolveUserDisplayName(id, {
        embeddedName: user.name ?? user.display_name ?? user.email,
        resolvedNameById: options.userDisplayNameById,
      }) ?? []
    })
    return names.length > 0 ? names.join(', ') : undefined
  }

  if (value == null || typeof value === 'object') return undefined
  const title = String(value).trim()
  return title || undefined
}

export function isIdLikeLinkTitle(id: string, title: string | undefined): boolean {
  if (!title) return true
  if (title === id) return true
  const normalizedId = id.replace(/-/g, '')
  const normalizedTitle = title.replace(/-/g, '')
  return normalizedId.length > normalizedTitle.length && normalizedId.startsWith(normalizedTitle)
}

export function resolveLinkRecordDisplayTitle(
  id: string,
  title: string | undefined,
): string {
  return isIdLikeLinkTitle(id, title) ? UNNAMED_RECORD_DISPLAY_NAME : title ?? UNNAMED_RECORD_DISPLAY_NAME
}

/** A parent link displays the loaded parent record's current primary-field projection. */
export function resolveSubRecordParentLinkTitle(
  id: string,
  title: string | undefined,
  resolveTitleById?: (recordId: string) => string | undefined,
): string {
  const resolvedTitle = resolveTitleById?.(id)?.trim()
  if (!resolvedTitle && SERIALIZED_USER_VALUE_PATTERN.test(title?.trim() ?? '')) {
    return UNNAMED_RECORD_DISPLAY_NAME
  }
  return resolvedTitle || resolveLinkRecordDisplayTitle(id, title)
}
