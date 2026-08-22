import { describe, expect, it } from 'vitest'
import { isShellBackgroundRunningOutput } from '../isShellBackgroundRunningOutput'

describe('isShellBackgroundRunningOutput', () => {
  it('识别顶层 status:running', () => {
    expect(
      isShellBackgroundRunningOutput({
        status: 'running',
        pid: 1,
        output_file: '/tmp/a.log',
      }),
    ).toBe(true)
  })

  it('识别 backgrounded:true', () => {
    expect(isShellBackgroundRunningOutput({ backgrounded: true, stdout: '' })).toBe(true)
  })

  it('识别 stdout 内嵌 running JSON 字符串', () => {
    expect(
      isShellBackgroundRunningOutput({
        exit_code: null,
        stdout: JSON.stringify({ status: 'running', session_id: 's1' }),
      }),
    ).toBe(true)
  })

  it('终态 completed / succeeded 不是后台 running', () => {
    expect(
      isShellBackgroundRunningOutput({
        status: 'completed',
        exit_code: 0,
        stdout: '{"ok":true}',
      }),
    ).toBe(false)
    expect(
      isShellBackgroundRunningOutput({
        stdout: JSON.stringify({
          ok: true,
          data: { status: 'succeeded', result_urls: ['https://example.com/a.png'] },
        }),
      }),
    ).toBe(false)
  })

  it('null / 非对象 → false', () => {
    expect(isShellBackgroundRunningOutput(null)).toBe(false)
    expect(isShellBackgroundRunningOutput('plain text')).toBe(false)
  })
})
