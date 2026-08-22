import { createErrorExtractor } from '@tabtin/shared'

export const extractErrorMessage = createErrorExtractor(
  (key, _opts) => key,
)

export async function dedupAsync<T>(
  map: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key)
  if (existing) return existing

  const promise = factory()
  map.set(key, promise)
  try {
    return await promise
  } finally {
    map.delete(key)
  }
}
