export const JSON_MODE_OPTIONS = [
  {
    value: 'json_object',
    label: 'JSON 对象',
    description: '保证是合法 JSON，例如 {"name":"小明"}；不保证有哪些字段',
  },
  {
    value: 'json_schema',
    label: 'JSON Schema',
    description: '请求时传入字段规则，例如 name 必须是文字、age 必须是数字',
  },
] as const

export const CACHING_MODE_OPTIONS = [
  { value: 'none', label: '不支持' },
  { value: 'automatic_implicit', label: '自动缓存（上游自动命中）' },
  { value: 'explicit_cache_control', label: '显式缓存控制' },
  { value: 'context_cache', label: '上下文缓存资源' },
] as const

const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export function hasJsonMode(modesCsv: string, mode: string): boolean {
  return splitCsv(modesCsv).includes(mode)
}

export function toggleJsonMode(modesCsv: string, mode: string, enabled: boolean): string {
  const selected = new Set(splitCsv(modesCsv))
  if (enabled) {
    selected.add(mode)
  } else {
    selected.delete(mode)
  }

  const knownModes = JSON_MODE_OPTIONS.map((option) => option.value).filter((value) =>
    selected.has(value)
  )
  const unknownModes = [...selected].filter(
    (value) => !JSON_MODE_OPTIONS.some((option) => option.value === value)
  )
  return [...knownModes, ...unknownModes].join(',')
}
