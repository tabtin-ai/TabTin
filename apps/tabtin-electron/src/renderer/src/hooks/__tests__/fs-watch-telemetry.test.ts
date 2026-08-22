import { beforeEach, describe, expect, it } from 'vitest'
import {
  classifyFsWatchError,
  getFsWatchTelemetrySnapshot,
  redactRootPath,
  reportFsWatchSetupFailed,
  resetFsWatchTelemetry,
} from '../fs-watch-telemetry'

describe('fs-watch-telemetry', () => {
  beforeEach(() => {
    resetFsWatchTelemetry()
  })

  describe('redactRootPath', () => {
    it('mac 路径脱敏用户名段', () => {
      expect(redactRootPath('/Users/alice/dev/proj')).toBe('/Users/<redacted>/dev/proj')
    })

    it('linux 路径脱敏 home 段', () => {
      expect(redactRootPath('/home/bob/work/x')).toBe('/home/<redacted>/work/x')
    })

    it('windows 路径脱敏 Users 段（大小写不敏感）', () => {
      expect(redactRootPath('C:\\Users\\charlie\\Documents')).toBe(
        'C:\\Users\\<redacted>\\Documents',
      )
    })

    it('未匹配的路径原样返回', () => {
      expect(redactRootPath('/opt/data/foo')).toBe('/opt/data/foo')
    })

    it('空字符串原样返回', () => {
      expect(redactRootPath('')).toBe('')
    })
  })

  describe('classifyFsWatchError', () => {
    it('thrown source 直接归 thrown_exception', () => {
      expect(classifyFsWatchError('whatever', 'thrown')).toBe('thrown_exception')
    })

    it('access denied / permission / EACCES 归 access_denied', () => {
      expect(classifyFsWatchError('access denied: ...', 'result_failed')).toBe('access_denied')
      expect(classifyFsWatchError('Permission Denied', 'result_failed')).toBe('access_denied')
      expect(classifyFsWatchError('EACCES: nope', 'result_failed')).toBe('access_denied')
    })

    it('outside workspace 归 outside_workspace', () => {
      expect(classifyFsWatchError('path outside workspace', 'result_failed')).toBe(
        'outside_workspace',
      )
    })

    it('not a directory / ENOTDIR 归 not_a_directory', () => {
      expect(classifyFsWatchError('path is not a directory', 'result_failed')).toBe(
        'not_a_directory',
      )
      expect(classifyFsWatchError('ENOTDIR', 'result_failed')).toBe('not_a_directory')
    })

    it('not found / ENOENT 归 path_not_found', () => {
      expect(classifyFsWatchError('ENOENT: file not found', 'result_failed')).toBe(
        'path_not_found',
      )
      expect(classifyFsWatchError('does not exist', 'result_failed')).toBe('path_not_found')
    })

    it('preload unavailable 归 preload_unavailable', () => {
      expect(
        classifyFsWatchError(
          'window.tabtin.fileSystem watch API not available',
          'result_failed',
        ),
      ).toBe('preload_unavailable')
    })

    it('未知归 unknown', () => {
      expect(classifyFsWatchError('weird error', 'result_failed')).toBe('unknown')
      expect(classifyFsWatchError('', 'result_failed')).toBe('unknown')
      expect(classifyFsWatchError(null, 'result_failed')).toBe('unknown')
    })
  })

  describe('reportFsWatchSetupFailed — 字段 / 脱敏', () => {
    it('上报后 snapshot 含完整字段，rootPath 已脱敏', () => {
      const ok = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'access denied: outside workspace',
        source: 'result_failed',
        now: 1_000,
      })
      expect(ok).toBe(true)

      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events).toHaveLength(1)
      const e = snap.events[0]
      expect(e.eventName).toBe('fs_watch_setup_failed')
      expect(e.rootPath).toBe('/Users/<redacted>/proj')
      expect(e.error).toBe('access denied: outside workspace')
      // 这个 error 同时含 access denied 和 outside —— preload_unavailable 排在
      // outside_workspace / access_denied 之前所以不会误命中；先匹配 outside
      expect(e.errorCode).toBe('outside_workspace')
      expect(e.source).toBe('result_failed')
      expect(e.timestamp).toBe(1_000)
      expect(e.id).toMatch(/^fs-watch-telem-/)

      expect(snap.counters['fs_watch_setup_failed.outside_workspace']).toBe(1)
    })

    it('Error 实例的 message 被抽出来', () => {
      reportFsWatchSetupFailed({
        rootPath: '/Users/alice/x',
        error: new Error('boom from main'),
        source: 'thrown',
        now: 2_000,
      })
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events[0].error).toBe('boom from main')
      expect(snap.events[0].errorCode).toBe('thrown_exception')
    })

    it('window.__TABTIN_FS_WATCH_TELEMETRY__ 被持久化', () => {
      reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: 3_000,
      })
      const w = window as unknown as {
        __TABTIN_FS_WATCH_TELEMETRY__?: {
          events: Array<{ rootPath: string; errorCode: string }>
          counters: Record<string, number>
        }
      }
      expect(w.__TABTIN_FS_WATCH_TELEMETRY__).toBeDefined()
      expect(w.__TABTIN_FS_WATCH_TELEMETRY__!.events).toHaveLength(1)
      expect(w.__TABTIN_FS_WATCH_TELEMETRY__!.events[0].rootPath).toBe(
        '/Users/<redacted>/proj',
      )
      expect(w.__TABTIN_FS_WATCH_TELEMETRY__!.counters['fs_watch_setup_failed.access_denied']).toBe(
        1,
      )
    })
  })

  describe('reportFsWatchSetupFailed — 5 分钟去重', () => {
    it('同 rootPath + 同 errorCode 在 5 分钟内只上报一次', () => {
      const t0 = 10_000
      const within = t0 + 4 * 60 * 1000
      const ok1 = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: t0,
      })
      const ok2 = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: within,
      })
      expect(ok1).toBe(true)
      expect(ok2).toBe(false)
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events).toHaveLength(1)
      expect(snap.counters['fs_watch_setup_failed.access_denied']).toBe(1)
    })

    it('5 分钟过后同 rootPath + 同 errorCode 重新上报', () => {
      const t0 = 10_000
      const after = t0 + 5 * 60 * 1000 + 1
      reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: t0,
      })
      const ok2 = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: after,
      })
      expect(ok2).toBe(true)
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events).toHaveLength(2)
      expect(snap.counters['fs_watch_setup_failed.access_denied']).toBe(2)
    })

    it('同 rootPath 不同 errorCode 不去重', () => {
      const t0 = 10_000
      reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'EACCES',
        source: 'result_failed',
        now: t0,
      })
      const ok2 = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/proj',
        error: 'ENOENT',
        source: 'result_failed',
        now: t0 + 1_000,
      })
      expect(ok2).toBe(true)
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events).toHaveLength(2)
      expect(snap.counters['fs_watch_setup_failed.access_denied']).toBe(1)
      expect(snap.counters['fs_watch_setup_failed.path_not_found']).toBe(1)
    })

    it('同 errorCode 不同 rootPath 不去重', () => {
      const t0 = 10_000
      reportFsWatchSetupFailed({
        rootPath: '/Users/alice/projA',
        error: 'EACCES',
        source: 'result_failed',
        now: t0,
      })
      const ok2 = reportFsWatchSetupFailed({
        rootPath: '/Users/alice/projB',
        error: 'EACCES',
        source: 'result_failed',
        now: t0 + 1_000,
      })
      expect(ok2).toBe(true)
      const snap = getFsWatchTelemetrySnapshot()
      expect(snap.events).toHaveLength(2)
      expect(snap.counters['fs_watch_setup_failed.access_denied']).toBe(2)
    })
  })
})
