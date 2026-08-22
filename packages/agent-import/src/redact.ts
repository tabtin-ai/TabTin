/**
 * Secret 打码（PRD §3.3 统一规则 / §6.3）。
 *
 * 模式集移植自 agent-observer core.mjs 的 SECRET_PATTERNS（已在真实数据上
 * 验证过误报率可接受），按 TabTin 场景补充 JWT 与常见私有前缀。
 * 打码保形：保留前 4 后 2 字符便于用户辨认是哪个 key（回看历史时能对上号）。
 */

export interface RedactStats {
  hits: number
  byPattern: Record<string, number>
}

interface NamedPattern {
  name: string
  re: RegExp
}

const PATTERNS: NamedPattern[] = [
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'generic_assignment',
    re: /\b(api[_-]?key|access[_-]?token|secret|password|passwd|auth[_-]?token)\s*[=:]\s*['"]?[A-Za-z0-9._~+/-]{12,}['"]?/gi,
  },
]

function mask(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-2)}`
}

/** 对单段文本打码；stats 跨调用累计（预览页披露命中数用） */
export function redactText(text: string, stats?: RedactStats): string {
  let out = text
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (m) => {
      if (stats) {
        stats.hits += 1
        stats.byPattern[name] = (stats.byPattern[name] ?? 0) + 1
      }
      // generic_assignment 保留键名，只码值部分
      if (name === 'generic_assignment') {
        const eq = m.search(/[=:]/)
        return `${m.slice(0, eq + 1)} ${mask(m.slice(eq + 1).trim())}`
      }
      return mask(m)
    })
  }
  return out
}

export function newRedactStats(): RedactStats {
  return { hits: 0, byPattern: {} }
}
