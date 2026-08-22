/**
 * 历史面板刷新信号：只用表级版本与行数，避免逐行 updated_at/version 拼签名
 * 在整表还原时触发 N 次历史请求风暴。
 */

export interface TableHistoryRefreshSource {
  latest_version?: string | number | null
  total?: number | null
  matched_total?: number | null
}

export function buildTableHistoryRefreshKey(
  source: TableHistoryRefreshSource | null | undefined,
): string {
  return [
    source?.latest_version ?? '',
    source?.total ?? '',
    source?.matched_total ?? '',
  ].join(':')
}

/**
 * 还原进行中时吸收外部 refreshKey：不推进 previousKey，成功路径会自行 fetch，
 * 并用 skipNextExternalRefresh 吞掉结束 loading 后的那一次外部信号。
 * 失败时不设 skip，key 若已变会在 loading 结束后正常 refresh。
 */
export function shouldAbsorbExternalHistoryRefresh(options: {
  open: boolean
  restoreLoading: boolean
  skipNextExternalRefresh: boolean
  previousKey: string
  nextKey: string
}): 'ignore' | 'absorb' | 'refresh' {
  const {
    open,
    restoreLoading,
    skipNextExternalRefresh,
    previousKey,
    nextKey,
  } = options
  if (!open || previousKey === nextKey) return 'ignore'
  if (restoreLoading || skipNextExternalRefresh) return 'absorb'
  return 'refresh'
}
