export type LocaleDictionary = Record<string, unknown>

const isPlainObject = (value: unknown): value is LocaleDictionary =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function deepMergeLocaleObjects<T extends LocaleDictionary>(
  base: T,
  override?: LocaleDictionary | null,
): T {
  if (!override) {
    return { ...base }
  }

  const result: LocaleDictionary = { ...base }

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key]
    result[key] =
      isPlainObject(baseValue) && isPlainObject(overrideValue)
        ? deepMergeLocaleObjects(baseValue, overrideValue)
        : overrideValue
  }

  return result as T
}
