/**
 * Nested sidebar leaf active-state matching.
 *
 * Parent entries may treat a whole section as active (siblings share one
 * "group" highlight). Leaf links must only match their own route so siblings
 * do not light up together .
 *
 * When `href` includes a query string, `search` must match that query exactly
 * (e.g. `/governance/admin-logs?type=login`).
 *
 * When `href` has no query, path match is enough and filter params
 * (`month`, `page`, `q`, …) are ignored — except `type`, which is reserved
 * for query-discriminated siblings (admin-logs「全部」vs「登录日志」等).
 */
export function checkLeafItemActive(href: string, pathname: string, search = ''): boolean {
  const qIndex = href.indexOf('?')
  const path = qIndex === -1 ? href : href.slice(0, qIndex)
  const hrefQuery = qIndex === -1 ? '' : href.slice(qIndex + 1)

  if (path === '/') {
    return pathname === '/' && hrefQuery === ''
  }

  const pathMatches = pathname === path || pathname.startsWith(`${path}/`)
  if (!pathMatches) return false

  const currentQuery = search.startsWith('?') ? search.slice(1) : search

  if (hrefQuery !== '') {
    return currentQuery === hrefQuery
  }

  const params = new URLSearchParams(currentQuery)
  const navType = params.get('type')
  if (navType) return false

  return true
}
