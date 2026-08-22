import { describe, expect, it } from 'vitest'
import { formatLlmProbeError, formatLlmProbeErrorLine } from './formatLlmProbeError'

const ZH: Record<string, string> = {
  'llm.providers.validateFailed': '连接失败',
  'llm.providers.probeErrors.unauthorized': '认证失败，请检查 API Key 是否正确或已过期',
  'llm.providers.probeErrors.forbidden': '无权访问该模型服务，请检查账号权限或 API Key 范围',
  'llm.providers.probeErrors.notFound': '模型或接口不存在，请确认模型名称与 API Base URL 是否正确',
  'llm.providers.probeErrors.rateLimited': '请求过于频繁，请稍后再试',
  'llm.providers.probeErrors.serverError': '模型服务暂时不可用（上游 {{status}}），请稍后重试',
  'llm.providers.probeErrors.timeout': '连接超时，请检查网络或服务是否正常',
  'llm.providers.probeErrors.network': '无法连接模型服务，请检查网络与 API Base URL',
  'llm.providers.probeErrors.invalidRequest': '请求参数不被上游接受，请检查模型配置',
  'llm.providers.probeErrors.quotaExceeded': '上游额度不足或账单异常，请检查服务商账户',
  'llm.providers.probeErrors.generic': '连通性测试失败，请检查渠道配置后重试',
  'llm.providers.probeErrors.withDetail': '{{message}}（{{detail}}）',
}

function t(key: string, options?: Record<string, unknown>): string {
  let template = ZH[key] ?? (typeof options?.defaultValue === 'string' ? options.defaultValue : key)
  if (options) {
    for (const [name, value] of Object.entries(options)) {
      if (name === 'defaultValue') continue
      template = template.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value))
    }
  }
  return template
}

describe('formatLlmProbeError ', () => {
  it('maps structured AUTH_FAILED / 401 to friendly unauthorized copy', () => {
    const result = formatLlmProbeError(
      {
        error: "Error code: 401 - {'error': {'message': 'Incorrect API key'}}",
        error_code: 'AUTH_FAILED',
        status_code: 401,
      },
      t,
    )
    expect(result.message).toBe('认证失败，请检查 API Key 是否正确或已过期')
    expect(result.detail).toBe('HTTP 401')
  })

  it('maps raw Error code: 404 when structured fields are missing', () => {
    const result = formatLlmProbeError(
      {
        error: 'Error code: 404 - model gpt-5 does not exist',
      },
      t,
    )
    expect(result.message).toBe('模型或接口不存在，请确认模型名称与 API Base URL 是否正确')
    expect(result.detail).toBe('HTTP 404')
  })

  it('maps bare status code strings to friendly copy', () => {
    expect(formatLlmProbeError({ error: '429' }, t).message).toBe('请求过于频繁，请稍后再试')
    expect(formatLlmProbeError({ error: '503' }, t).message).toContain('503')
  })

  it('maps timeout / network keywords', () => {
    expect(formatLlmProbeError({ error: 'Connection timed out after 30s' }, t).message)
      .toBe('连接超时，请检查网络或服务是否正常')
    expect(formatLlmProbeError({ error: 'APIConnectionError: Connection refused' }, t).message)
      .toBe('无法连接模型服务，请检查网络与 API Base URL')
  })

  it('prefers nested level_1 status_code from probe details', () => {
    const result = formatLlmProbeError(
      {
        error: 'unknown',
        details: {
          level_1: { valid: false, error: 'boom', status_code: 403, error_code: 'AUTH_FAILED' },
        },
      },
      t,
    )
    expect(result.message).toBe('无权访问该模型服务，请检查账号权限或 API Key 范围')
    expect(result.detail).toBe('HTTP 403')
  })

  it('formatLlmProbeErrorLine appends secondary diagnostic', () => {
    const line = formatLlmProbeErrorLine(
      {
        error: 'Error code: 401 - Incorrect API key provided',
        status_code: 401,
        error_code: 'AUTH_FAILED',
      },
      t,
    )
    expect(line).toBe('认证失败，请检查 API Key 是否正确或已过期（HTTP 401）')
  })
})
