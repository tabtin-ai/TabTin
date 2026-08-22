/** Notion 等厂商按 UA 拦截内置窗时的文案探测（无 Electron 依赖，便于单测）。 */

export function oauthPageLooksUnsupported(text: string): boolean {
  return /browser is not compatible|not compatible with notion|upgrade to the latest browser/i.test(
    text,
  )
}
