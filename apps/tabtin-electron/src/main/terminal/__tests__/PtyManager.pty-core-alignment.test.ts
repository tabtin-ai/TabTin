import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../PtyManager'
import type { PtyHostClient, PtyHostSession } from '../PtyHost'
import { MARKER_PREFIX, wrapCommand, shellQuote } from '@tabtin/pty-core'

vi.mock('electron', () => ({
  app: {
    getLocale: () => 'zh-CN',
  },
}))

const { getCLIServerInfoMock, resolveShellMock } = vi.hoisted(() => ({
  getCLIServerInfoMock: vi.fn((): { socketPath?: string; token?: string } | null => null),
  resolveShellMock: vi.fn(() => '/bin/bash'),
}))

vi.mock('@tabtin/pty-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/pty-core')>()
  return {
    ...actual,
    resolveShell: resolveShellMock,
  }
})

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: getCLIServerInfoMock,
}))

class MockHostSession implements PtyHostSession {
  pid = 9527

  private spawnedHandler?: (event: { pid: number }) => void
  private dataHandler?: (data: string) => void
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void

  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler
    return { dispose: vi.fn() }
  })

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler
    return { dispose: vi.fn() }
  })

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler
    return { dispose: vi.fn() }
  })

  triggerData(data: string): void {
    this.dataHandler?.(data)
  }

  triggerExit(exitCode: number | null, signal?: number): void {
    this.exitHandler?.({ exitCode, signal })
  }
}

class MockPtyHostClient implements PtyHostClient {
  private readonly sessions: MockHostSession[] = []

  spawn = vi.fn((_options?: { env?: Record<string, string> }) => {
    const session = new MockHostSession()
    this.sessions.push(session)
    return session
  })

  getLastSession(): MockHostSession {
    const session = this.sessions.at(-1)
    if (!session) throw new Error('No host session created')
    return session
  }

  getLastSpawnEnv(): Record<string, string> {
    return this.spawn.mock.calls.at(-1)?.[0]?.env ?? {}
  }
}

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('PtyManager pty-core alignment (PTY-008/009, D-01/02/03)', () => {
  let hostClient: MockPtyHostClient
  let manager: PtyManager

  beforeEach(() => {
    getCLIServerInfoMock.mockReset()
    getCLIServerInfoMock.mockReturnValue(null)
    resolveShellMock.mockReset()
    resolveShellMock.mockReturnValue('/bin/bash')
    hostClient = new MockPtyHostClient()
    manager = new PtyManager(hostClient, new MockProcessTerminator() as any)
  })

  afterEach(() => {
    manager.cleanup()
  })

  describe('PTY-008 / D-01: executeCommand uses wrapCommand + generateMarkerPair', () => {
    it('写入 pty 的命令包含 pty-core 格式的 start/end marker', async () => {
      expect(manager.spawn('s1', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s1', 'echo hello', { blockUntilMs: 5_000 })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toMatch(/echo "__TABTIN_CMD_START_[a-f0-9]{32}__"/)
      expect(written).toMatch(/echo "__TABTIN_CMD_END_[a-f0-9]{32}_\$\?"\$'\\x1F'"\$\(pwd\)__"/)
      expect(written).toContain('echo hello')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]+__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]+_/)![0]
      host.triggerData(`${startMarker}\nhello\n${endMarkerPrefix}0_/tmp__\n`)

      const result = await resultP
      expect(result.output).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('生成的 marker 与 pty-core generateMarkerPair 格式一致', async () => {
      expect(manager.spawn('s-fmt', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-fmt', 'ls', { blockUntilMs: 5_000 })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      const startNonce = written.match(/__TABTIN_CMD_START_([a-f0-9]{32})__/)![1]
      const endNonce = written.match(/__TABTIN_CMD_END_([a-f0-9]{32})_/)![1]
      expect(startNonce).toHaveLength(32)
      expect(endNonce).toHaveLength(32)
      expect(startNonce).not.toBe(endNonce)

      const expected = {
        startMarker: `${MARKER_PREFIX}START_${startNonce}__`,
        endMarkerPrefix: `${MARKER_PREFIX}END_${endNonce}_`,
      }
      expect(written).toContain(expected.startMarker)
      expect(written).toContain(expected.endMarkerPrefix)

      host.triggerData(`${expected.startMarker}\n\n${expected.endMarkerPrefix}0_/tmp__\n`)
      await resultP
    })
  })

  describe('PTY-009: shellQuote 统一（不再使用 JSON.stringify）', () => {
    it('env 变量值使用 shellQuote 单引号转义', () => {
      const written = wrapCommand(
        'echo $MY_VAR',
        {
          nonce: 'endnonce',
          startMarker: '__TABTIN_CMD_START_startnonce__',
          endMarkerPrefix: '__TABTIN_CMD_END_endnonce_',
        },
        {
          env: { MY_VAR: "hello 'world'" },
        },
      )
      expect(written).toContain(`export MY_VAR=${shellQuote("hello 'world'")}`)
      expect(written).not.toContain('JSON')
      expect(written).not.toContain(`"hello 'world'"`)
    })

    it('workingDirectory 使用 shellQuote 单引号转义', async () => {
      expect(manager.spawn('s-wd', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-wd', 'pwd', {
        blockUntilMs: 5_000,
        workingDirectory: '/path/with spaces',
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain(`cd ${shellQuote('/path/with spaces')}`)
      expect(written).not.toContain(`cd "/path/with spaces"`)

      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]+_/)![0]
      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]+__/)![0]
      host.triggerData(`${startMarker}\n/path/with spaces\n${endMarkerPrefix}0_/path/with spaces__\n`)
      await resultP
    })
  })

  describe('D-02: buildCommandSetup 已删除', () => {
    it('PtyManager 模块不导出 buildCommandSetup', async () => {
      const mod = await import('../PtyManager')
      expect(mod).not.toHaveProperty('buildCommandSetup')
    })
  })

  describe('D-03: marker 解析使用 parseEndMarker / extractMarkerTail', () => {
    it('checkPendingCommandMarker 正确解析含下划线路径的 cwd', async () => {
      expect(manager.spawn('s-parse', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-parse', 'cd /my_project/sub_dir && pwd', {
        blockUntilMs: 5_000,
      })

      const written = host.write.mock.calls.at(-1)?.[0] as string
      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]+__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]+_/)![0]

      host.triggerData(
        `${startMarker}\n/my_project/sub_dir\n${endMarkerPrefix}0_/my_project/sub_dir__\n`,
      )

      const result = await resultP
      expect(result.exitCode).toBe(0)
      expect(result.cwd).toBe('/my_project/sub_dir')
      expect(result.output).toBe('/my_project/sub_dir')
    })

    it('checkPendingCommandMarker 正确处理非零 exitCode', async () => {
      expect(manager.spawn('s-exit', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-exit', 'false', { blockUntilMs: 5_000 })

      const written = host.write.mock.calls.at(-1)?.[0] as string
      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]+__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]+_/)![0]

      host.triggerData(`${startMarker}\n\n${endMarkerPrefix}1_/tmp__\n`)

      const result = await resultP
      expect(result.exitCode).toBe(1)
      expect(result.cwd).toBe('/tmp')
    })

    it('backgrounded watcher 使用 extractMarkerTail + parseEndMarker 解析完成', async () => {
      expect(manager.spawn('s-bg', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-bg', 'sleep 999', { blockUntilMs: 0 })
      const result = await resultP
      expect(result.backgrounded).toBe(true)

      const written = host.write.mock.calls.at(-1)?.[0] as string
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]+_/)![0]
      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]+__/)![0]

      host.triggerData(`${startMarker}\ndone\n${endMarkerPrefix}42_/home/user__\n`)

      const session = manager.getSession('s-bg')
      expect(session?.lastExitCode).toBe(42)
      expect(session?.cwd).toBe('/home/user')
    })

    it('wrappedCmd 与 pty-core wrapCommand 输出一致', async () => {
      expect(manager.spawn('s-wrap', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-wrap', 'echo test', {
        blockUntilMs: 5_000,
        workingDirectory: '/work',
        context: { env: { FOO: 'bar' } } as any,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      const endNonce = written.match(/__TABTIN_CMD_END_([a-f0-9]{32})_/)![1]

      const markers = {
        nonce: endNonce,
        startMarker,
        endMarkerPrefix,
      }
      const expected = wrapCommand('echo test', markers, {
        env: { FOO: 'bar' },
        workingDirectory: '/work',
      })
      expect(written).toBe(expected)

      host.triggerData(`${markers.startMarker}\ntest\n${markers.endMarkerPrefix}0_/work__\n`)
      await resultP
    })

    it('CLI 命令优先注入当前 Electron CLI Server socket/token', async () => {
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '\\\\.\\pipe\\tabtin-electron-cli-11688',
        token: 'transport-token',
      })

      expect(manager.spawn('s-cli-env', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-cli-env', 'tabtin doctor', {
        blockUntilMs: 5_000,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain(`export TABTIN_SOCK=${shellQuote('\\\\.\\pipe\\tabtin-electron-cli-11688')}`)
      expect(written).toContain(`export _TABTIN_TRANSPORT_TOKEN=${shellQuote('transport-token')}`)

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0_/tmp__\n`)
      await resultP
    })

    it('交互式 shell 创建与重启都注入当前 Electron CLI Server socket/token', () => {
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '/tmp/cli-im-2.sock',
        token: 'instance-token',
      })

      expect(manager.spawn('s-interactive-cli-env', { cwd: '/tmp' })).toBe(true)
      expect(hostClient.getLastSpawnEnv()).toMatchObject({
        TABTIN_SOCK: '/tmp/cli-im-2.sock',
        _TABTIN_TRANSPORT_TOKEN: 'instance-token',
      })

      expect((manager as unknown as {
        restartSessionShell: (sessionId: string) => boolean
      }).restartSessionShell('s-interactive-cli-env')).toBe(true)
      expect(hostClient.getLastSpawnEnv()).toMatchObject({
        TABTIN_SOCK: '/tmp/cli-im-2.sock',
        _TABTIN_TRANSPORT_TOKEN: 'instance-token',
      })
    })

    it('交互式 shell 的显式 transport 环境优先且不混入当前 token', () => {
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '/tmp/current.sock',
        token: 'current-token',
      })

      expect(manager.spawn('s-interactive-explicit-cli-env', {
        cwd: '/tmp',
        env: { TABTIN_SOCK: '/tmp/explicit.sock' },
      })).toBe(true)

      expect(hostClient.getLastSpawnEnv()).toMatchObject({
        TABTIN_SOCK: '/tmp/explicit.sock',
      })
      expect(hostClient.getLastSpawnEnv()._TABTIN_TRANSPORT_TOKEN).toBeUndefined()

      expect((manager as unknown as {
        restartSessionShell: (sessionId: string) => boolean
      }).restartSessionShell('s-interactive-explicit-cli-env')).toBe(true)
      expect(hostClient.getLastSpawnEnv()).toMatchObject({
        TABTIN_SOCK: '/tmp/explicit.sock',
      })
      expect(hostClient.getLastSpawnEnv()._TABTIN_TRANSPORT_TOKEN).toBeUndefined()
    })

    it('PowerShell shell 下使用 Windows 可生效的 env 语法', async () => {
      resolveShellMock.mockReturnValue(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      )
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '\\\\.\\pipe\\tabtin-electron-cli-11688',
        token: 'transport-token',
      })

      expect(manager.spawn('s-cli-env-pwsh', { cwd: 'C:\\work' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-cli-env-pwsh', 'tabtin doctor', {
        blockUntilMs: 5_000,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain("$env:TABTIN_SOCK = '\\\\.\\pipe\\tabtin-electron-cli-11688'")
      expect(written).toContain("$env:_TABTIN_TRANSPORT_TOKEN = 'transport-token'")
      expect(written).not.toContain('export TABTIN_SOCK=')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0\x1fC:\\work__\n`)
      await resultP
    })

    it('命令包装使用 session 创建时的真实 shellType', async () => {
      resolveShellMock.mockReturnValue(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      )
      expect(manager.spawn('s-session-shell', { cwd: 'C:\\work' })).toBe(true)

      resolveShellMock.mockReturnValue('/bin/bash')
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-session-shell', 'tabtin doctor', {
        blockUntilMs: 5_000,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain('Write-Host')
      expect(written).not.toContain('echo "__TABTIN_CMD_START_')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0\x1fC:\\work__\n`)
      await resultP
    })

    it('显式 context.env 的 socket/token 优先于当前 Electron CLI Server', async () => {
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '\\\\.\\pipe\\tabtin-electron-cli-server',
        token: 'server-token',
      })

      expect(manager.spawn('s-cli-env-explicit', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-cli-env-explicit', 'tabtin doctor', {
        blockUntilMs: 5_000,
        context: {
          env: {
            TABTIN_SOCK: 'explicit-sock',
            _TABTIN_TRANSPORT_TOKEN: 'explicit-token',
          },
        } as any,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain(`export TABTIN_SOCK=${shellQuote('explicit-sock')}`)
      expect(written).toContain(`export _TABTIN_TRANSPORT_TOKEN=${shellQuote('explicit-token')}`)
      expect(written).not.toContain('tabtin-electron-cli-server')
      expect(written).not.toContain('server-token')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0_/tmp__\n`)
      await resultP
    })

    it('显式 env 只传 socket 时不会混入当前 Electron CLI Server token', async () => {
      getCLIServerInfoMock.mockReturnValue({
        socketPath: '\\\\.\\pipe\\tabtin-electron-cli-server',
        token: 'server-token',
      })

      expect(manager.spawn('s-cli-env-partial-explicit', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-cli-env-partial-explicit', 'tabtin doctor', {
        blockUntilMs: 5_000,
        context: {
          env: {
            TABTIN_SOCK: 'explicit-sock',
          },
        } as any,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).toContain(`export TABTIN_SOCK=${shellQuote('explicit-sock')}`)
      expect(written).not.toContain('_TABTIN_TRANSPORT_TOKEN')
      expect(written).not.toContain('server-token')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0_/tmp__\n`)
      await resultP
    })

    it('当前 Electron CLI Server 信息不完整时不注入 socket/token', async () => {
      getCLIServerInfoMock.mockReturnValue({ socketPath: '\\\\.\\pipe\\missing-token' })

      expect(manager.spawn('s-cli-env-missing-server', { cwd: '/tmp' })).toBe(true)
      const host = hostClient.getLastSession()

      const resultP = manager.executeCommand('s-cli-env-missing-server', 'tabtin doctor', {
        blockUntilMs: 5_000,
      })
      await vi.waitFor(() => expect(host.write).toHaveBeenCalled())

      const written = host.write.mock.calls.at(-1)?.[0] as string
      expect(written).not.toContain('TABTIN_SOCK')
      expect(written).not.toContain('_TABTIN_TRANSPORT_TOKEN')

      const startMarker = written.match(/__TABTIN_CMD_START_[a-f0-9]{32}__/)![0]
      const endMarkerPrefix = written.match(/__TABTIN_CMD_END_[a-f0-9]{32}_/)![0]
      host.triggerData(`${startMarker}\n[]\n${endMarkerPrefix}0_/tmp__\n`)
      await resultP
    })
  })
})
