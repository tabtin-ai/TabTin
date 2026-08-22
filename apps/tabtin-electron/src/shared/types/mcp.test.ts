import { describe, expect, it } from 'vitest'
import { parseMcpError } from './mcp'

describe('parseMcpError', () => {
  it('解析带参数的 JSON 错误包', () => {
    expect(parseMcpError('{"code":"MCP_ERR:PROBE_TIMEOUT","params":{"seconds":180}}')).toEqual({
      code: 'PROBE_TIMEOUT',
      params: { seconds: 180 },
    })
  })

  it('保留纯错误码兼容', () => {
    expect(parseMcpError('MCP_ERR:AUTHORIZATION_REQUIRED')).toEqual({
      code: 'AUTHORIZATION_REQUIRED',
    })
  })

  it('忽略非 MCP 错误', () => {
    expect(parseMcpError('{"code":"OTHER_ERROR"}')).toBeNull()
  })
})
