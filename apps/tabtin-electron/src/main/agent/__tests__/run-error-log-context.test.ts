import { describe, expect, it } from 'vitest'
import { buildRunErrorLogContext } from '../run-error-log-context.js'

describe('buildRunErrorLogContext', () => {
  it('只保留允许进入诊断包的结构化错误字段', () => {
    const error = {
      message: '包含用户正文的上游错误',
      code: 'LLM_ERROR',
      statusCode: 500,
      retryable: true,
      details: {
        stage: 'codex_responses_stream',
        error_type: 'server_error',
        provider_error_code: 'internal_error',
        access_token: 'secret-token',
        prompt: '用户私密正文',
      },
    }

    expect(buildRunErrorLogContext(error, {
      code: 'LLM_ERROR',
      category: 'server_error',
      statusCode: 500,
      retryable: true,
    })).toEqual({
      errorCode: 'LLM_ERROR',
      category: 'server_error',
      statusCode: 500,
      retryable: true,
      stage: 'codex_responses_stream',
      errorType: 'server_error',
      providerErrorCode: 'internal_error',
    })
    expect(JSON.stringify(buildRunErrorLogContext(error, {
      code: 'LLM_ERROR',
      category: 'server_error',
      statusCode: 500,
      retryable: true,
    }))).not.toMatch(/secret-token|用户私密正文|access_token|prompt/)
  })

  it('截断不受信任的上游错误标识', () => {
    const error = { details: { provider_error_code: 'x'.repeat(200) } }
    expect(buildRunErrorLogContext(error, {
      code: 'LLM_ERROR',
      category: 'internal',
      retryable: false,
    }).providerErrorCode).toHaveLength(120)
  })
})
