/**
 * Safe clipboard utility with error handling.
 */

export function safeCopyToClipboard(
  text: string,
  onSuccess?: () => void,
  onError?: () => void,
): void {
  navigator.clipboard?.writeText(text).then(
    () => onSuccess?.(),
    () => onError?.(),
  )
}
