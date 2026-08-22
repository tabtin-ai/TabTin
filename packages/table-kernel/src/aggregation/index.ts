/**
 * Rollup 聚合函数 — 从 Django RollupFieldService._aggregate() 精确翻译
 *
 * 纯函数，不依赖任何外部服务。
 */

export type AggregationFunction =
  | 'sum'
  | 'average'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'count_not_empty'
  | 'count_empty'
  | 'count_distinct'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'percent_unique'
  | 'array_join'
  | 'array_unique'
  | 'array_compact'

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

function toNumbers(values: unknown[]): number[] {
  return values
    .map((v) => Number(v))
    .filter((n) => !isNaN(n) && isFinite(n))
}

/**
 * 对一组值执行聚合运算
 *
 * @param func 聚合函数名
 * @param values 待聚合的值数组
 * @param separator array_join 的分隔符，默认 ", "
 */
export function aggregate(func: AggregationFunction, values: unknown[], separator: string = ', '): unknown {
  switch (func) {
    case 'sum': {
      const nums = toNumbers(values)
      return nums.reduce((a, b) => a + b, 0)
    }
    case 'average':
    case 'avg': {
      const nums = toNumbers(values)
      if (nums.length === 0) return null
      return nums.reduce((a, b) => a + b, 0) / nums.length
    }
    case 'min': {
      const nums = toNumbers(values)
      if (nums.length === 0) return null
      return Math.min(...nums)
    }
    case 'max': {
      const nums = toNumbers(values)
      if (nums.length === 0) return null
      return Math.max(...nums)
    }
    case 'count':
      return values.length
    case 'count_not_empty':
      return values.filter((v) => !isEmpty(v)).length
    case 'count_empty':
      return values.filter((v) => isEmpty(v)).length
    case 'count_distinct': {
      const seen = new Set(values.filter((v) => !isEmpty(v)).map(String))
      return seen.size
    }
    case 'percent_empty': {
      if (values.length === 0) return 0
      return (values.filter((v) => isEmpty(v)).length / values.length) * 100
    }
    case 'percent_not_empty': {
      if (values.length === 0) return 0
      return (values.filter((v) => !isEmpty(v)).length / values.length) * 100
    }
    case 'percent_unique': {
      const nonEmpty = values.filter((v) => !isEmpty(v))
      if (nonEmpty.length === 0) return 0
      const unique = new Set(nonEmpty.map(String))
      return (unique.size / nonEmpty.length) * 100
    }
    case 'array_join': {
      return values.filter((v) => !isEmpty(v)).map(String).join(separator)
    }
    case 'array_unique': {
      const seen = new Set<string>()
      return values.filter((v) => {
        if (isEmpty(v)) return false
        const s = String(v)
        if (seen.has(s)) return false
        seen.add(s)
        return true
      })
    }
    case 'array_compact': {
      return values.filter((v) => !isEmpty(v))
    }
    default:
      return null
  }
}

export const SUPPORTED_AGGREGATION_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  'sum', 'average', 'avg', 'min', 'max', 'count',
  'count_not_empty', 'count_empty', 'count_distinct',
  'percent_empty', 'percent_not_empty', 'percent_unique',
  'array_join', 'array_unique', 'array_compact',
])
