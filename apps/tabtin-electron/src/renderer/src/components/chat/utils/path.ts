/**
 * Shared path utilities for chat card components.
 */

export function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}
