export function isUserMediaBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return type === 'image' || type === 'file' || type === 'video'
}
