import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordLog,
  getLogEntries,
  formatLogEntries,
  installConsoleCapture,
  __clearLogEntries,
} from '../logCollector'

describe('logCollector', () => {
  beforeEach(() => {
    __clearLogEntries()
  })

  it('recordLog 写入并可读回', () => {
    recordLog('info', ['hello', 42])
    const entries = getLogEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe('info')
    expect(entries[0].text).toContain('hello')
    expect(entries[0].text).toContain('42')
  })

  it('序列化对象与 Error', () => {
    recordLog('error', [new Error('boom')])
    expect(getLogEntries()[0].text).toContain('boom')
    recordLog('log', [{ a: 1 }])
    expect(getLogEntries()[1].text).toContain('"a":1')
  })

  it('环形缓冲不超过上限且保留最新', () => {
    for (let i = 0; i < 2100; i++) recordLog('log', [`m${i}`])
    const entries = getLogEntries()
    expect(entries.length).toBeLessThanOrEqual(2000)
    expect(entries[entries.length - 1].text).toContain('m2099')
  })

  it('formatLogEntries 带级别标签', () => {
    recordLog('warn', ['careful'])
    const text = formatLogEntries(getLogEntries())
    expect(text).toContain('[WARN]')
    expect(text).toContain('careful')
  })

  it('installConsoleCapture 幂等并捕获 console 输出', () => {
    installConsoleCapture()
    installConsoleCapture()
    console.log('captured-line-xyz')
    expect(getLogEntries().some((e) => e.text.includes('captured-line-xyz'))).toBe(true)
  })
})
