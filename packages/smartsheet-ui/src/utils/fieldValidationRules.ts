/**
 * 字段 validation_rules 校验（与 table-ui / 后端 validate_with_rules 对齐）。
 * 供记录表单等不依赖 table-ui 的入口复用。
 */

export type FieldRulesValidationResult =
  | { valid: true }
  | { valid: false; errorCode: string; params?: Record<string, unknown> }

function isEmptyCellValue(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

/** 与后端 `int(min_length)` 对齐：JSON 偶发把阈值存成字符串时仍须生效 */
export function coerceRuleNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * 解析字段验证正则：支持裸模式 `^[0-9]+$`，也兼容 JS 字面量 `/[0-9]+/g`。
 * 与后端 re.match 对齐——只要求从开头匹配，不要求整串（除非模式自带 `$`）。
 */
export function normalizeValidationPattern(raw: string): { source: string; flags: string } {
  const trimmed = raw.trim()
  const literal = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed)
  if (literal) {
    // g 对单次校验无意义，且会让 RegExp#test 产生 lastIndex 副作用
    const flags = literal[2].replace(/g/g, '')
    return { source: literal[1], flags }
  }
  return { source: trimmed, flags: '' }
}

function compileValidationPattern(raw: string): RegExp | null {
  const { source, flags } = normalizeValidationPattern(raw)
  if (!source) return null
  return new RegExp(`^(?:${source})`, flags)
}

export function validateFieldRules(
  value: unknown,
  validationRules?: Record<string, unknown> | null,
): FieldRulesValidationResult {
  const rules: Record<string, unknown> = { ...(validationRules ?? {}) }

  if (Object.keys(rules).length === 0) {
    return { valid: true }
  }

  if (isEmptyCellValue(value)) {
    return { valid: true }
  }

  const lengthValue =
    typeof value === 'string' || Array.isArray(value)
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null

  if (lengthValue != null) {
    const length = lengthValue.length
    const minLength = coerceRuleNumber(rules.min_length)
    const maxLength = coerceRuleNumber(rules.max_length)
    if (minLength !== undefined && length < minLength) {
      return {
        valid: false,
        errorCode: 'min_length',
        params: {
          minLength,
          ...(typeof rules.message === 'string' ? { message: rules.message } : {}),
        },
      }
    }
    if (maxLength !== undefined && length > maxLength) {
      return {
        valid: false,
        errorCode: 'max_length',
        params: {
          maxLength,
          ...(typeof rules.message === 'string' ? { message: rules.message } : {}),
        },
      }
    }
  }

  if (Array.isArray(value)) {
    const maxItems = coerceRuleNumber(rules.max_items)
    if (maxItems !== undefined && value.length > maxItems) {
      return {
        valid: false,
        errorCode: 'max_items',
        params: {
          maxItems,
          ...(typeof rules.message === 'string' ? { message: rules.message } : {}),
        },
      }
    }
  }

  const pattern = rules.pattern
  const patternValue = typeof value === 'string' ? value : lengthValue
  if (typeof pattern === 'string' && pattern.length > 0 && typeof patternValue === 'string') {
    try {
      const compiled = compileValidationPattern(pattern)
      if (compiled && !compiled.test(patternValue)) {
        return {
          valid: false,
          errorCode: 'pattern',
          params: typeof rules.message === 'string' ? { message: rules.message } : undefined,
        }
      }
    } catch {
      // 非法正则配置不阻断
    }
  }

  return { valid: true }
}
