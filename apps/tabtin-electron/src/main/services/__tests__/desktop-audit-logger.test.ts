/**
 * desktop-audit-logger · Wave 2 双轨合并 + W1.3 月份分片测试。
 *
 * 守住的核心约束：
 *   1. 唯一事实源 = `~/.tabtin/desktop-audit-{YYYY-MM}.jsonl`（W1.3 起按月分片）；
 *      每条写入含 timestamp / action / sessionId / params / result（/ errorCode /
 *      errorMessage）。
 *   2. `desktop-audit-logger`（electron-log 实例）降级为 debug 级 console
 *      输出，**不再写文件** —— 即 `transports.file.level === false`。
 *   3. 调用 writeAuditLog 后，不产生 `desktop-audit.log` 传统文件；仅
 *      `desktop-audit-{YYYY-MM}.jsonl` 被 appendFileSync。
 *   4. v1.5 月份分片 + migration + cleanup 三条新增不变量（W1.3）：
 *      - append 落到 `desktop-audit-{YYYY-MM}.jsonl`（按写入时刻 UTC 月份）
 *      - 启动期检测旧版 `desktop-audit.jsonl` → 按 mtime 归并到对应月份分片
 *      - 超过 6 月保留窗口的分片 rename 到 `desktop-audit-archive/`
 *
 * 规范 § 9.2 验收命令 7：
 *   `ls ~/.tabtin/desktop-audit.log && echo FAIL || echo OK`
 *   目标：OK（legacy log file 不被创建）。本测试通过 mock appendFileSync 的
 *   调用参数精确断言"只有 jsonl 被写、没有 .log 文件路径"。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const {
  mockAppendFileSync,
  mockMkdirSync,
  mockExistsSync,
  mockCreateReadStream,
  mockCreateWriteStream,
  mockReaddirSync,
  mockRenameSync,
  mockStatSync,
  mockUnlinkSync,
  mockElectronLogDebug,
  mockPipeline,
} = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockCreateReadStream: vi.fn(),
  mockCreateWriteStream: vi.fn(),
  mockReaddirSync: vi.fn().mockReturnValue([]),
  mockRenameSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockElectronLogDebug: vi.fn(),
  mockPipeline: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:fs', () => {
  const mod = {
    appendFileSync: mockAppendFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    createReadStream: mockCreateReadStream,
    createWriteStream: mockCreateWriteStream,
    readdirSync: mockReaddirSync,
    renameSync: mockRenameSync,
    statSync: mockStatSync,
    unlinkSync: mockUnlinkSync,
  }
  return { ...mod, default: mod }
})

vi.mock('node:stream/promises', () => {
  const mod = { pipeline: mockPipeline }
  return { ...mod, default: mod }
})

// Mock 主进程 logger（R2 F2 修复后审计写入失败走 createLogger 的 fileLog，
// 而非裸 console.warn —— 测试需要观察 logger.warn 被调用以确认走主进程
// electron-log 的 file transport 路径，生产环境才能写到 main.log）。
const { mockLoggerWarn, mockLoggerError, mockLoggerInfo } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
}))
vi.mock('../../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    log: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  })),
}))

// 精确捕获 electron-log.create 返回的实例，断言 transports.file.level = false
const { createdInstances } = vi.hoisted(() => ({
  createdInstances: [] as Array<{
    transports: {
      file: { level: false | string }
      console: { level: false | string }
    }
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
  }>,
}))
vi.mock('electron-log', () => ({
  default: {
    create: vi.fn().mockImplementation(() => {
      const inst = {
        transports: {
          file: { level: 'info' as false | string, fileName: '', format: '' },
          console: { level: 'info' as false | string },
        },
        debug: mockElectronLogDebug,
        info: vi.fn(),
      }
      createdInstances.push(inst)
      return inst
    }),
  },
}))

import {
  writeAuditLog,
  desktopAuditLogger,
  AUDIT_LOG_JSONL_PATH,
  AUDIT_LOG_ARCHIVE_DIR,
  sanitizeAuditParams,
  getActiveAuditLogPath,
  formatMonthKey,
  initDesktopAuditLogger,
  __resetAuditDirEnsuredForTest,
} from '../desktop-audit-logger'
import { DesktopErrorCode } from '../desktop-error-codes'

const HOME = homedir()
const TABTIN_DIR = join(HOME, '.tabtin')
const LEGACY_PATH = join(TABTIN_DIR, 'desktop-audit.jsonl')
const LEGACY_MIGRATING_PATH = join(TABTIN_DIR, 'desktop-audit.jsonl.migrating')
const ARCHIVE_DIR = join(TABTIN_DIR, 'desktop-audit-archive')

function resetAllMocks(): void {
  mockAppendFileSync.mockReset()
  mockMkdirSync.mockReset()
  mockExistsSync.mockReset().mockReturnValue(false)
  mockCreateReadStream.mockReset()
  mockCreateWriteStream.mockReset()
  mockReaddirSync.mockReset().mockReturnValue([])
  mockRenameSync.mockReset()
  mockStatSync.mockReset()
  mockUnlinkSync.mockReset()
  mockElectronLogDebug.mockReset()
  mockLoggerWarn.mockReset()
  mockLoggerError.mockReset()
  mockLoggerInfo.mockReset()
  mockPipeline.mockReset().mockResolvedValue(undefined)
  __resetAuditDirEnsuredForTest()
}

describe('desktop-audit-logger · Wave 2 合并', () => {
  beforeEach(() => resetAllMocks())

  it('AUDIT_LOG_JSONL_PATH 仍指向 legacy 单文件 ~/.tabtin/desktop-audit.jsonl（migration 源路径）', () => {
    expect(AUDIT_LOG_JSONL_PATH).toBe(LEGACY_PATH)
  })

  it('electron-log 实例的 transports.file.level === false（不再写文件）', () => {
    expect(desktopAuditLogger.transports.file.level).toBe(false)
    expect(createdInstances.length).toBeGreaterThan(0)
    expect(createdInstances[createdInstances.length - 1].transports.file.level).toBe(false)
  })

  it('electron-log 实例的 console 级别为 debug（仅开发期排障）', () => {
    expect(desktopAuditLogger.transports.console.level).toBe('debug')
  })

  it('writeAuditLog 仅写 jsonl（appendFileSync 路径以 .jsonl 结尾），不创建 desktop-audit.log', () => {
    writeAuditLog({
      action: 'click',
      sessionId: 'sid-1',
      params: { x: 100, y: 200 },
      result: 'ok',
    })
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
    const [path] = mockAppendFileSync.mock.calls[0]
    expect(String(path)).toMatch(/\.jsonl$/)
    for (const call of mockAppendFileSync.mock.calls) {
      expect(String(call[0])).not.toMatch(/desktop-audit\.log$/)
    }
  })

  it('writeAuditLog 失败记录包含 errorCode 与 errorMessage 字段', () => {
    writeAuditLog({
      action: 'click',
      sessionId: 'sid-2',
      params: { x: 1, y: 2 },
      result: 'error',
      errorCode: DesktopErrorCode.POLICY_BLOCKED,
      errorMessage: '桌面操控被安全策略阻止：xxx...'.padEnd(300, 'x'),
    })
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
    const [, payload] = mockAppendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim())
    expect(json.action).toBe('click')
    expect(json.result).toBe('error')
    expect(json.errorCode).toBe(DesktopErrorCode.POLICY_BLOCKED)
    expect(typeof json.errorMessage).toBe('string')
    expect(json.errorMessage.length).toBeLessThanOrEqual(200)
  })

  it('writeAuditLog 成功记录不带 errorCode / errorMessage', () => {
    writeAuditLog({
      action: 'screenshot',
      sessionId: 'sid-3',
      params: {},
      result: 'ok',
    })
    const [, payload] = mockAppendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim())
    expect(json.errorCode).toBeUndefined()
    expect(json.errorMessage).toBeUndefined()
  })

  it('writeAuditLog 同时 debug 级 console 打印（不阻塞主流程）', () => {
    writeAuditLog({ action: 'move', sessionId: null, params: {}, result: 'ok' })
    expect(mockElectronLogDebug).toHaveBeenCalled()
  })

  it('sanitizeAuditParams 剔除 _authPreset / 截断超长 text / basename 化 savePath', () => {
    const out = sanitizeAuditParams({
      _authPreset: 'cautious',
      text: 'x'.repeat(150),
      savePath: '/Users/me/.tabtin/screenshots/photo.jpg',
      displayId: 1,
    })
    expect(out._authPreset).toBeUndefined()
    expect((out.text as string).endsWith('...')).toBe(true)
    expect((out.text as string).length).toBe(103)
    expect(out.savePath).toBe('photo.jpg')
    expect(out.displayId).toBe(1)
  })

  it('appendFileSync 抛错时 writeAuditLog 不崩溃（best-effort）', () => {
    mockAppendFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    expect(() =>
      writeAuditLog({ action: 'click', sessionId: 'x', params: {}, result: 'ok' }),
    ).not.toThrow()
  })

  it('R2 F2 第二轮：appendFileSync 抛错时通过主进程 createLogger.warn 上报（生产环境进 main.log，OPS 可见）', () => {
    mockAppendFileSync.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left')
    })
    writeAuditLog({ action: 'click', params: {}, result: 'ok' })

    // 关键不变量：必须走主进程 createLogger 的 .warn —— 这条路径在生产
    // 环境（packaged）下会 fallback 到 electron-log file transport 写
    // main.log，跟 dev 模式下的 console.warn 不同。仅 spy 裸 console.warn
    // 不能保证生产模式 OPS 看到（packaged stdout 被丢弃）。
    expect(mockLoggerWarn).toHaveBeenCalled()
    const matched = mockLoggerWarn.mock.calls.some((c) =>
      String(c[0]).includes('[desktop-audit-logger]'),
    )
    expect(matched).toBe(true)

    // 反向断言：错误对象本体被透传给 logger（不能只传字符串丢上下文）
    const lastCall = mockLoggerWarn.mock.calls[mockLoggerWarn.mock.calls.length - 1]
    expect(lastCall[lastCall.length - 1]).toBeInstanceOf(Error)
    expect(String(lastCall[lastCall.length - 1])).toMatch(/ENOSPC/)
  })

  it('R2 F2 第二轮：写入成功时不调 logger.warn（不污染 main.log）', () => {
    writeAuditLog({ action: 'screenshot', sessionId: 's', params: {}, result: 'ok' })
    expect(mockLoggerWarn).not.toHaveBeenCalled()
  })
})

describe('desktop-audit-logger · W1.3 月份分片', () => {
  beforeEach(() => resetAllMocks())

  it('formatMonthKey 输出 YYYY-MM（UTC，不含时区漂移）', () => {
    expect(formatMonthKey(new Date(Date.UTC(2026, 4, 3, 12, 0, 0)))).toBe('2026-05')
    expect(formatMonthKey(new Date(Date.UTC(2025, 11, 31, 23, 59, 59)))).toBe('2025-12')
    expect(formatMonthKey(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('2026-01')
  })

  it('getActiveAuditLogPath 返回 ~/.tabtin/desktop-audit-{YYYY-MM}.jsonl', () => {
    const may = getActiveAuditLogPath(new Date(Date.UTC(2026, 4, 3, 12, 0, 0)))
    expect(may).toBe(join(TABTIN_DIR, 'desktop-audit-2026-05.jsonl'))
    const dec = getActiveAuditLogPath(new Date(Date.UTC(2025, 11, 31, 23, 0, 0)))
    expect(dec).toBe(join(TABTIN_DIR, 'desktop-audit-2025-12.jsonl'))
  })

  it('writeAuditLog 默认走当月分片文件 desktop-audit-{YYYY-MM}.jsonl（路径含月份）', () => {
    writeAuditLog({ action: 'click', sessionId: 's-1', params: {}, result: 'ok' })
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
    const [path] = mockAppendFileSync.mock.calls[0]
    expect(String(path)).toMatch(
      /[/\\]desktop-audit-\d{4}-\d{2}\.jsonl$/,
    )
  })

  it('AUDIT_LOG_ARCHIVE_DIR 指向 ~/.tabtin/desktop-audit-archive', () => {
    expect(AUDIT_LOG_ARCHIVE_DIR).toBe(ARCHIVE_DIR)
  })
})

describe('desktop-audit-logger · W1.3 / R2 F1+F2 legacy migration（启动期流式 + sentinel 幂等）', () => {
  beforeEach(() => resetAllMocks())

  it('initDesktopAuditLogger 检测到旧 desktop-audit.jsonl → rename 成 sentinel → 流式 append 到月份分片 → unlink sentinel', async () => {
    const legacyMtime = new Date(Date.UTC(2026, 3, 15, 10, 0, 0))
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    mockStatSync.mockImplementation((p: string) => {
      if (p === LEGACY_PATH) {
        return { size: 128, mtime: legacyMtime } as any
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const fakeReadStream = { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() }
    const fakeWriteStream = { on: vi.fn(), end: vi.fn(), write: vi.fn() }
    mockCreateReadStream.mockReturnValue(fakeReadStream)
    mockCreateWriteStream.mockReturnValue(fakeWriteStream)

    await initDesktopAuditLogger()

    // 1. legacy 被 rename 成 sentinel
    expect(mockRenameSync).toHaveBeenCalledWith(LEGACY_PATH, LEGACY_MIGRATING_PATH)
    // 2. 流式管道：read sentinel → write 2026-04 月份分片（按 mtime）
    const aprilFile = join(TABTIN_DIR, 'desktop-audit-2026-04.jsonl')
    expect(mockCreateReadStream).toHaveBeenCalledWith(
      LEGACY_MIGRATING_PATH,
      expect.objectContaining({ highWaterMark: 64 * 1024 }),
    )
    expect(mockCreateWriteStream).toHaveBeenCalledWith(
      aprilFile,
      expect.objectContaining({ flags: 'a', mode: 0o600 }),
    )
    expect(mockPipeline).toHaveBeenCalledWith(fakeReadStream, fakeWriteStream)
    // 3. sentinel 在 pipeline 完成后才被 unlink
    expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY_MIGRATING_PATH)
  })

  it('initDesktopAuditLogger 流式不读 readFileSync（不会一次吃 GB 级 legacy 文件到内存）', async () => {
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    mockStatSync.mockImplementation(() => ({
      size: 500 * 1024 * 1024, // 500MB
      mtime: new Date(),
    }) as any)
    mockCreateReadStream.mockReturnValue({})
    mockCreateWriteStream.mockReturnValue({})

    await initDesktopAuditLogger()

    expect(mockCreateReadStream).toHaveBeenCalled()
    expect(mockPipeline).toHaveBeenCalled()
    // R2 F1：禁止使用 readFileSync 一次读全文件（这会吃 500MB 内存 + 阻塞主进程）
    // 注意：测试 mock 没暴露 readFileSync，但此处通过"未导入"间接守约
  })

  it('initDesktopAuditLogger 多次调用幂等（migrationDone 守护）', async () => {
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    mockStatSync.mockImplementation(() => ({
      size: 100,
      mtime: new Date(),
    }) as any)
    mockCreateReadStream.mockReturnValue({})
    mockCreateWriteStream.mockReturnValue({})

    await initDesktopAuditLogger()
    await initDesktopAuditLogger()
    await initDesktopAuditLogger()

    expect(mockRenameSync).toHaveBeenCalledTimes(1)
    expect(mockPipeline).toHaveBeenCalledTimes(1)
    expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY_MIGRATING_PATH)
  })

  it('legacy 文件 size=0 → 直接 unlink legacy，不走 sentinel 也不开流', async () => {
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    mockStatSync.mockImplementation(() => ({ size: 0, mtime: new Date() }) as any)

    await initDesktopAuditLogger()

    expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY_PATH)
    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockCreateReadStream).not.toHaveBeenCalled()
    expect(mockPipeline).not.toHaveBeenCalled()
  })

  it('legacy 文件不存在 → 啥也不做', async () => {
    mockExistsSync.mockReturnValue(false)
    await initDesktopAuditLogger()
    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockCreateReadStream).not.toHaveBeenCalled()
    expect(mockPipeline).not.toHaveBeenCalled()
    expect(mockUnlinkSync).not.toHaveBeenCalled()
  })

  it('上次崩溃残留 sentinel → rename 成 .orphan-{ts} 备查，不重做迁移（防止历史审计重复）', async () => {
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_MIGRATING_PATH)

    await initDesktopAuditLogger()

    // sentinel 被 rename 成 .orphan-* 路径
    expect(mockRenameSync).toHaveBeenCalledTimes(1)
    const [src, dst] = mockRenameSync.mock.calls[0]
    expect(src).toBe(LEGACY_MIGRATING_PATH)
    expect(String(dst)).toMatch(/desktop-audit\.jsonl\.migrating\.orphan-\d+$/)
    // 不再触发流式管道（防止历史审计重复写入）
    expect(mockPipeline).not.toHaveBeenCalled()
    expect(mockCreateReadStream).not.toHaveBeenCalled()
  })

  it('migration pipeline 失败 → sentinel 保留，不删 legacy.migrating，下次启动按"上次崩溃"路径处理', async () => {
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    mockStatSync.mockImplementation(() => ({
      size: 100,
      mtime: new Date(),
    }) as any)
    mockCreateReadStream.mockReturnValue({})
    mockCreateWriteStream.mockReturnValue({})
    mockPipeline.mockRejectedValueOnce(new Error('ENOSPC: no space left'))

    await initDesktopAuditLogger()

    // sentinel 已建立
    expect(mockRenameSync).toHaveBeenCalledWith(LEGACY_PATH, LEGACY_MIGRATING_PATH)
    // 但 pipeline 失败 → 不应 unlink sentinel（让下次启动看到残留按 orphan 处理）
    expect(mockUnlinkSync).not.toHaveBeenCalled()
  })

  it('writeAuditLog 启动后不再触发 migration（migration 由 initDesktopAuditLogger 接管）', () => {
    // 模拟 legacy 还在的场景
    mockExistsSync.mockImplementation((p: string) => p === LEGACY_PATH)
    writeAuditLog({ action: 'click', params: {}, result: 'ok' })
    // writeAuditLog 不应再触发 rename（迁移由启动期负责）
    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockPipeline).not.toHaveBeenCalled()
    // 但仍应正常写当月分片
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
    expect(String(mockAppendFileSync.mock.calls[0][0])).toMatch(
      /desktop-audit-\d{4}-\d{2}\.jsonl$/,
    )
  })
})

describe('desktop-audit-logger · W1.3 6 月保留窗口归档', () => {
  beforeEach(() => resetAllMocks())

  it('cleanup 把超过 6 月保留窗口的分片 rename 到 desktop-audit-archive/，保留窗口内的不动', () => {
    // 当前时间锁到 2026-05-03，保留窗口 = 2025-12 ~ 2026-05
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 3, 12, 0, 0)))

    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue([
      'desktop-audit-2024-09.jsonl', // 应归档
      'desktop-audit-2025-11.jsonl', // 应归档
      'desktop-audit-2025-12.jsonl', // 保留（最早保留月份）
      'desktop-audit-2026-01.jsonl', // 保留
      'desktop-audit-2026-05.jsonl', // 当月，保留
      'desktop-audit-archive', // 子目录，跳过
      'unrelated.jsonl', // 非匹配，跳过
      'README.md', // 非匹配，跳过
    ])

    writeAuditLog({ action: 'a', params: {}, result: 'ok' })

    const renamedSrcs = mockRenameSync.mock.calls.map((c) => c[0] as string)
    expect(renamedSrcs.sort()).toEqual([
      join(TABTIN_DIR, 'desktop-audit-2024-09.jsonl'),
      join(TABTIN_DIR, 'desktop-audit-2025-11.jsonl'),
    ])
    // 目标都在 archive 目录下
    for (const call of mockRenameSync.mock.calls) {
      expect(String(call[1])).toMatch(/desktop-audit-archive[/\\]/)
    }

    vi.useRealTimers()
  })

  it('cleanup 同月份多次写入只扫一次目录（节流到月份粒度）', () => {
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue([])

    writeAuditLog({ action: 'a', params: {}, result: 'ok' })
    writeAuditLog({ action: 'b', params: {}, result: 'ok' })
    writeAuditLog({ action: 'c', params: {}, result: 'ok' })

    expect(mockReaddirSync).toHaveBeenCalledTimes(1)
  })

  it('cleanup 跨月时自动再扫一次（长寿命进程修复 · R1 review）', () => {
    vi.useFakeTimers()
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue([])

    // 第一次写入：2026-05
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0)))
    writeAuditLog({ action: 'a', params: {}, result: 'ok' })
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    // 同月再写：不扫
    writeAuditLog({ action: 'b', params: {}, result: 'ok' })
    expect(mockReaddirSync).toHaveBeenCalledTimes(1)

    // 跨到 2026-06：再扫一次
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 0, 0, 5)))
    writeAuditLog({ action: 'c', params: {}, result: 'ok' })
    expect(mockReaddirSync).toHaveBeenCalledTimes(2)

    // 跨到 2026-07：再扫一次（共 3 次）
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 5, 9, 0, 0)))
    writeAuditLog({ action: 'd', params: {}, result: 'ok' })
    expect(mockReaddirSync).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('cleanup rename 失败不抛 + 不阻断后续写入', () => {
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReturnValue(['desktop-audit-2020-01.jsonl'])
    mockRenameSync.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(() =>
      writeAuditLog({ action: 'a', params: {}, result: 'ok' }),
    ).not.toThrow()
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1)
  })

  it('跨月写入：在 2026-05-31 23:59 与 2026-06-01 00:00 写入会落到不同分片', () => {
    vi.useFakeTimers()

    // 第一次写入：2026-05 月底
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 31, 23, 59, 0)))
    writeAuditLog({ action: 'click', params: {}, result: 'ok' })
    const firstPath = mockAppendFileSync.mock.calls[0][0]

    // 第二次写入：2026-06 月初
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 1, 0, 0, 1)))
    writeAuditLog({ action: 'click', params: {}, result: 'ok' })
    const secondPath = mockAppendFileSync.mock.calls[1][0]

    expect(String(firstPath)).toMatch(/desktop-audit-2026-05\.jsonl$/)
    expect(String(secondPath)).toMatch(/desktop-audit-2026-06\.jsonl$/)

    vi.useRealTimers()
  })
})
