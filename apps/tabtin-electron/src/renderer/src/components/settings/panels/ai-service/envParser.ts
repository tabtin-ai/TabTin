/**
 * envParser —— 把 .env 文本解析成 KEY=VALUE 数组，并匹配已知服务预设。
 *
 * 支持格式：
 *  - `KEY=value` / `KEY="value"` / `KEY='value'`
 *  - `export KEY=value`（shell rc 文件常见）
 *  - 行内 # 注释（仅整行注释，行内 value 中含 # 不处理）
 *
 * 输入示例：
 *   OPENAI_API_KEY=sk-abc...
 *   export ANTHROPIC_API_KEY="sk-ant-..."
 *   # SERPER_API_KEY=xxx
 *   SOMETHING_ELSE=value
 */

import { SERVICE_PRESETS } from '../credentials/constants'

export interface ParsedEnvEntry {
  /** ENV 变量名（大写） */
  envKey: string
  /** 值（去引号） */
  value: string
  /** 匹配到的服务预设 value（如 'openai'）；未识别时为 'custom' */
  preset: string
  /** 预设的字段名（如 'api_key'），自定义时默认 'api_key' */
  field: string
  /** 给用户看的服务标签（'OpenAI' / 'Anthropic' / 'Custom · OPENAI_FOO'） */
  serviceLabel: string
}

/**
 * 常见 AI 服务 ENV 变量名 → 预设映射。
 * 命中即可一键导入；未命中走自定义服务名。
 */
const ENV_TO_PRESET: Record<string, { preset: string; field: string }> = {
  OPENAI_API_KEY: { preset: 'openai', field: 'api_key' },
  OPENAI_KEY: { preset: 'openai', field: 'api_key' },
  ANTHROPIC_API_KEY: { preset: 'anthropic', field: 'api_key' },
  ANTHROPIC_KEY: { preset: 'anthropic', field: 'api_key' },
  CLAUDE_API_KEY: { preset: 'anthropic', field: 'api_key' },
  SERPER_API_KEY: { preset: 'serper', field: 'api_key' },
  SERPAPI_API_KEY: { preset: 'serper', field: 'api_key' },
  SENDGRID_API_KEY: { preset: 'sendgrid', field: 'api_key' },
}

export function parseEnvText(text: string): ParsedEnvEntry[] {
  const out: ParsedEnvEntry[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i)
    if (!m) continue

    const envKey = m[1].toUpperCase()
    if (seen.has(envKey)) continue
    seen.add(envKey)

    let value = m[2].trim()
    if (value.endsWith(';')) value = value.slice(0, -1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!value) continue

    const preset = ENV_TO_PRESET[envKey]
    if (preset) {
      const meta = SERVICE_PRESETS.find((p) => p.value === preset.preset)
      out.push({
        envKey,
        value,
        preset: preset.preset,
        field: preset.field,
        serviceLabel: meta?.label || preset.preset,
      })
    } else {
      out.push({
        envKey,
        value,
        preset: 'custom',
        field: 'api_key',
        serviceLabel: envKey,
      })
    }
  }

  return out
}
