/**
 * 诊断 / 错误上报共享脱敏
 *
 * 单一真相源：Electron（主/渲染进程诊断包 + Sentry beforeSend）与 Daemon
 * （Sentry beforeSend）都走这一份规则，保证「本地诊断包」与「外部错误上报」
 * 两条通道的脱敏口径一致。契约见 docs/agent/error-context-schema.md：
 * token / 手机号 / 邮箱 / 家目录用户名不出境。
 */

/** 单条脱敏规则：匹配 + 替换（字符串或函数）。 */
type RedactionRule = [RegExp, string | ((match: string, ...groups: string[]) => string)]

function maskPhone(match: string): string {
  return `${match.slice(0, 3)}****${match.slice(7)}`
}

function maskEmail(_match: string, local: string, domain: string): string {
  const head = local.slice(0, 1)
  return `${head}***@${domain}`
}

const RULES: RedactionRule[] = [
  [/(bearer\s+)[A-Za-z0-9\-._~+/]{8,}=*/gi, '$1<redacted>'],
  [
    /("?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)"?\s*[:=]\s*"?)([^\s"',}]{4,})/gi,
    '$1<redacted>',
  ],
  [/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, '<redacted-jwt>'],
  [/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, maskEmail],
  [/\b1[3-9]\d{9}\b/g, maskPhone],
  [/(\/Users\/)[^/\s]+/g, '$1<user>'],
  [/(\/home\/)[^/\s]+/g, '$1<user>'],
  [/([A-Za-z]:\\Users\\)[^\\/\s]+/g, '$1<user>'],
]

/** 对一段文本做全量脱敏。 */
export function redact(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input ?? ''
  let out = input
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as string)
  }
  return out
}

/** 对象先 JSON 序列化再脱敏。 */
export function redactJson(value: unknown, space = 2): string {
  let json: string
  try {
    json = JSON.stringify(value, null, space)
  } catch {
    json = String(value)
  }
  return redact(json)
}
