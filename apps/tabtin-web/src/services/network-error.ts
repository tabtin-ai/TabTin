export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) return true
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof TypeError && err.message.toLowerCase().includes('network')) return true
  return false
}
