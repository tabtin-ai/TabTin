/**
 * 找出时间线变化中应直接呈现的历史身份。
 * prepend 返回共享窗口前的前缀；around= 整窗替换返回全部；普通 append 返回空。
 */
export function resolveHistoricalMessageEnterKeys(
  previousKeys: readonly string[],
  currentKeys: readonly string[],
): readonly string[] {
  if (previousKeys.length === 0 || currentKeys.length === 0) return []
  const previousKeySet = new Set(previousKeys)
  const firstSharedIndex = currentKeys.findIndex((key) => previousKeySet.has(key))
  if (firstSharedIndex > 0) return currentKeys.slice(0, firstSharedIndex)
  if (firstSharedIndex < 0) return currentKeys
  return []
}
