export interface CanonicalGroupField {
  fieldType?: string
  choices?: readonly unknown[]
  userDisplayNameById?: ReadonlyMap<string, string>
}

export interface CanonicalGroupValue {
  key: string
  label: string
  empty: boolean
}

const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])
const SET_FIELD_TYPES = new Set(['multi_select'])
const NUMERIC_FIELD_TYPES = new Set([
  'number', 'currency', 'percent', 'rating', 'duration',
])
const DATE_FIELD_TYPES = new Set([
  'date', 'created_time', 'last_modified_time',
])
// Keep this deliberately version-agnostic: member ids may be UUIDv7, and the
// grouping identity must not depend on whether the member directory has loaded.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isEmptyGroupValue = (value: unknown): boolean =>
  value == null || value === '' || (Array.isArray(value) && value.length === 0)

const readFirstText = (
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

const stableSerialize = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

const normalizeText = (value: string): string => value.normalize('NFKC').toLowerCase()
const splitNaturalText = (value: string): string[] =>
  normalizeText(value).split(/(\d+)/u).filter(Boolean)

/** Locale-independent natural comparison, mirrored by the Django service. */
export const compareCanonicalText = (left: string, right: string): number => {
  const leftParts = splitNaturalText(left)
  const rightParts = splitNaturalText(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart)
      const rightNumber = BigInt(rightPart)
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    const leftPoints = Array.from(leftPart, char => char.codePointAt(0) ?? 0)
    const rightPoints = Array.from(rightPart, char => char.codePointAt(0) ?? 0)
    const pointLength = Math.max(leftPoints.length, rightPoints.length)
    for (let pointIndex = 0; pointIndex < pointLength; pointIndex += 1) {
      const leftPoint = leftPoints[pointIndex]
      const rightPoint = rightPoints[pointIndex]
      if (leftPoint === undefined) return -1
      if (rightPoint === undefined) return 1
      if (leftPoint !== rightPoint) return leftPoint - rightPoint
    }
  }
  const leftPoints = Array.from(left, char => char.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, char => char.codePointAt(0) ?? 0)
  const pointLength = Math.max(leftPoints.length, rightPoints.length)
  for (let index = 0; index < pointLength; index += 1) {
    const leftPoint = leftPoints[index]
    const rightPoint = rightPoints[index]
    if (leftPoint === undefined) return -1
    if (rightPoint === undefined) return 1
    if (leftPoint !== rightPoint) return leftPoint - rightPoint
  }
  return 0
}

const choiceKey = (value: unknown): string => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of ['value', 'id', 'name', 'label'] as const) {
      if (record[key] != null) return String(record[key])
    }
  }
  return String(value)
}

const resolveUserToken = (
  value: unknown,
  userDisplayNameById?: ReadonlyMap<string, string>,
): { token: string; label: string } => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const id = readFirstText(record, ['id', 'user_id', 'open_id', 'union_id'])
    const name = readFirstText(record, ['name', 'display_name', 'nickname', 'en_name'])
    // UUID-shaped member ids stay stable before and after the organization
    // directory loads; imported open ids still need an explicit directory hit.
    if (id && (UUID_PATTERN.test(id) || userDisplayNameById?.has(id))) {
      return { token: id, label: userDisplayNameById?.get(id) ?? name ?? id }
    }
    const label = name ?? id ?? stableSerialize(record)
    return { token: `name:${label}`, label }
  }

  const text = String(value)
  if (UUID_PATTERN.test(text) || userDisplayNameById?.has(text)) {
    return { token: text, label: userDisplayNameById?.get(text) ?? text }
  }
  return { token: `name:${text}`, label: text }
}

export const resolveCanonicalGroupValue = (
  value: unknown,
  field: CanonicalGroupField = {},
  emptyLabel = '',
): CanonicalGroupValue => {
  if (isEmptyGroupValue(value)) {
    return { key: '__empty__', label: emptyLabel, empty: true }
  }

  if (field.fieldType && USER_FIELD_TYPES.has(field.fieldType)) {
    const resolvedMembers = (Array.isArray(value) ? value : [value])
      .map(item => resolveUserToken(item, field.userDisplayNameById))
    const memberByToken = new Map(resolvedMembers.map(member => [member.token, member]))
    const members = [...memberByToken.values()]
    const tokens = [...members].sort((left, right) => compareCanonicalText(left.token, right.token))
    const labels = [...members].sort((left, right) =>
      compareCanonicalText(left.label, right.label) || compareCanonicalText(left.token, right.token)
    )
    return {
      key: `user:${JSON.stringify(tokens.map(item => item.token))}`,
      label: labels.map(item => item.label).join(', '),
      empty: false,
    }
  }

  if (field.fieldType && SET_FIELD_TYPES.has(field.fieldType)) {
    const items = (Array.isArray(value) ? value : [value]).map(choiceKey)
    const uniqueItems = [...new Set(items)].sort(compareCanonicalText)
    return {
      key: uniqueItems.join('|'),
      label: uniqueItems.join(', '),
      empty: false,
    }
  }

  if (Array.isArray(value)) {
    const items = value.map(item =>
      item != null && typeof item === 'object' ? stableSerialize(item) : String(item)
    )
    return {
      key: items.join('|'),
      label: value.map(item => choiceKey(item)).join(', '),
      empty: false,
    }
  }

  if (typeof value === 'object') {
    const serialized = stableSerialize(value)
    return { key: serialized, label: choiceKey(value), empty: false }
  }

  const text = String(value)
  return { key: text, label: text, empty: false }
}

const compareNumberArrays = (left: number[], right: number[]): number => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftItem = left[index]
    const rightItem = right[index]
    if (leftItem === undefined) return -1
    if (rightItem === undefined) return 1
    if (leftItem !== rightItem) return leftItem - rightItem
  }
  return 0
}

const parseCanonicalDate = (value: unknown): number | null => {
  const text = String(value).trim()
  let normalized = text
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    normalized = `${text}T00:00:00Z`
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.test(text)
  ) {
    normalized = `${text}Z`
  }
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

const resolveChoiceRanks = (
  value: unknown,
  choices: readonly unknown[],
  setLike = false,
): number[] => {
  const rankByKey = new Map<string, number>()
  choices.forEach((choice, index) => {
    if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
      const record = choice as Record<string, unknown>
      for (const key of ['value', 'id', 'name', 'label'] as const) {
        if (record[key] != null && !rankByKey.has(String(record[key]))) {
          rankByKey.set(String(record[key]), index)
        }
      }
    } else if (choice != null && !rankByKey.has(String(choice))) {
      rankByKey.set(String(choice), index)
    }
  })
  const rawValues = Array.isArray(value) ? value : [value]
  const values = setLike
    ? [...new Map(rawValues.map(item => [choiceKey(item), item])).values()]
    : rawValues
  return values
    .map(item => rankByKey.get(choiceKey(item)) ?? Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a - b)
}

export const compareCanonicalGroupValues = (
  left: unknown,
  right: unknown,
  field: CanonicalGroupField = {},
  direction: 'asc' | 'desc' | string = 'asc',
): number => {
  const leftValue = resolveCanonicalGroupValue(left, field)
  const rightValue = resolveCanonicalGroupValue(right, field)
  if (leftValue.empty || rightValue.empty) {
    return leftValue.empty === rightValue.empty ? 0 : leftValue.empty ? 1 : -1
  }

  let result = 0
  if (Array.isArray(field.choices) && field.choices.length > 0) {
    const setLike = field.fieldType != null && SET_FIELD_TYPES.has(field.fieldType)
    result = compareNumberArrays(
      resolveChoiceRanks(left, field.choices, setLike),
      resolveChoiceRanks(right, field.choices, setLike),
    )
  } else if (field.fieldType && NUMERIC_FIELD_TYPES.has(field.fieldType)) {
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    const leftInvalid = !Number.isFinite(leftNumber)
    const rightInvalid = !Number.isFinite(rightNumber)
    result = leftInvalid || rightInvalid
      ? leftInvalid === rightInvalid ? 0 : leftInvalid ? 1 : -1
      : leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1
  } else if (field.fieldType && DATE_FIELD_TYPES.has(field.fieldType)) {
    const leftTime = parseCanonicalDate(left)
    const rightTime = parseCanonicalDate(right)
    const leftInvalid = leftTime === null
    const rightInvalid = rightTime === null
    result = leftInvalid || rightInvalid
      ? leftInvalid === rightInvalid ? 0 : leftInvalid ? 1 : -1
      : leftTime === rightTime ? 0 : (leftTime as number) < (rightTime as number) ? -1 : 1
  }

  if (result === 0) result = compareCanonicalText(leftValue.label, rightValue.label)
  if (result === 0) result = compareCanonicalText(leftValue.key, rightValue.key)
  return direction === 'desc' ? -result : result
}
