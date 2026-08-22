/**
 * widgetAuditLogger 测试 —— Widget Wave 7 补丁（决策 13 审计日志短期落盘）。
 *
 * 守约：
 *   1. 每条 audit entry append 到 `~/.tabtin/widget-audit.log`（非 userData 路径）
 *      而且是 JSON line 格式，含 timestamp/session_id/widget_id/text/meta/trigger_source
 *   2. 10MB rotate：当前文件 > 10MB 时 mv 到 `.old` 再重新开始 append
 *   3. 写盘失败不抛（best-effort）——fire-and-forget 契约
 *   4. schema 无 session_id / widget_id 的 entry 被跳过不写（防污染）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const {
  mockAppendFileSync,
  mockMkdirSync,
  mockRenameSync,
  mockStatSync,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockExistsSync: vi.fn(),
}))

vi.mock('node:fs', () => {
  const mod = {
    appendFileSync: mockAppendFileSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
    statSync: mockStatSync,
    existsSync: mockExistsSync,
  }
  return { ...mod, default: mod }
})

// electron ipcMain 必须 stub——测试环境没有 Electron runtime
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import {
  writeWidgetAuditEntry,
  getWidgetAuditLogPath,
  getWidgetAuditLogOldPath,
  __resetWidgetAuditLoggerForTests,
} from '../widgetAuditLogger'

describe('widgetAuditLogger — Wave 7 补丁', () => {
  beforeEach(() => {
    mockAppendFileSync.mockReset()
    mockMkdirSync.mockReset()
    mockRenameSync.mockReset()
    mockStatSync.mockReset()
    mockExistsSync.mockReset()
    __resetWidgetAuditLoggerForTests()
    // 默认 rotate 分支走不到——除非测试显式让文件 > 10MB
    mockExistsSync.mockReturnValue(false)
  })

  it('日志路径在 ~/.tabtin/ 下 — 与 desktop-audit-logger 同目录便于 tail', () => {
    expect(getWidgetAuditLogPath()).toBe(join(homedir(), '.tabtin', 'widget-audit.log'))
    expect(getWidgetAuditLogOldPath()).toBe(join(homedir(), '.tabtin', 'widget-audit.log.old'))
  })

  it('写入一条完整 entry → append JSON line 含 session_id / widget_id / text / meta / trigger_source / timestamp', () => {
    writeWidgetAuditEntry({
      timestamp: 1711000000000,
      session_id: 'sess-1',
      widget_id: 'wgt-x',
      text: '详细解释 ingress 控制器',
      meta: { node: 'ingress' },
      trigger_source: 'widget',
    })

    expect(mockMkdirSync).toHaveBeenCalledTimes(1)
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
    const [path, payload, options] = mockAppendFileSync.mock.calls[0]
    expect(String(path)).toBe(join(homedir(), '.tabtin', 'widget-audit.log'))
    expect(options).toEqual({ mode: 0o600 })

    // payload 必须是合法 JSON line（结尾有 \n）
    const line = String(payload)
    expect(line.endsWith('\n')).toBe(true)
    const json = JSON.parse(line.trim())
    expect(json).toEqual({
      timestamp: 1711000000000,
      session_id: 'sess-1',
      widget_id: 'wgt-x',
      text: '详细解释 ingress 控制器',
      meta: { node: 'ingress' },
      trigger_source: 'widget',
    })
  })

  it('缺 session_id / widget_id 的 entry 被跳过不写（防污染）', () => {
    writeWidgetAuditEntry({
      timestamp: 1711,
      session_id: '',
      widget_id: 'wgt',
      text: 'no session',
    })
    writeWidgetAuditEntry({
      timestamp: 1711,
      session_id: 'sess',
      widget_id: '',
      text: 'no widget',
    })
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  it('文件 > 10MB 时 rotate 到 .old 再 append 新文件', () => {
    mockExistsSync.mockReturnValue(true)
    // 超阈值
    mockStatSync.mockReturnValue({ size: 11 * 1024 * 1024 } as any)

    writeWidgetAuditEntry({
      timestamp: 1711,
      session_id: 'sess',
      widget_id: 'wgt',
      text: 'trigger rotate',
    })

    expect(mockRenameSync).toHaveBeenCalledTimes(1)
    const [from, to] = mockRenameSync.mock.calls[0]
    expect(String(from)).toBe(join(homedir(), '.tabtin', 'widget-audit.log'))
    expect(String(to)).toBe(join(homedir(), '.tabtin', 'widget-audit.log.old'))
    // 新文件仍然被 append（rotate 后下一行写到新文件）
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
  })

  it('文件 < 10MB 时不 rotate', () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ size: 1024 } as any)

    writeWidgetAuditEntry({
      timestamp: 1711,
      session_id: 'sess',
      widget_id: 'wgt',
      text: 'no rotate',
    })

    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
  })

  it('appendFileSync 抛错时 writeWidgetAuditEntry 不抛（best-effort）', () => {
    mockAppendFileSync.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    expect(() =>
      writeWidgetAuditEntry({
        timestamp: 1711,
        session_id: 'sess',
        widget_id: 'wgt',
        text: 'disk full',
      }),
    ).not.toThrow()
  })

  it('缺 trigger_source 默认补 "widget"（Wave 7 本期唯一触发源）', () => {
    writeWidgetAuditEntry({
      timestamp: 1711,
      session_id: 'sess',
      widget_id: 'wgt',
      text: 'default',
      // 没传 trigger_source
    })
    const [, payload] = mockAppendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim())
    expect(json.trigger_source).toBe('widget')
  })
})
