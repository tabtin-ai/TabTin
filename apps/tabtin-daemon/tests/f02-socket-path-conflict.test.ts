/**
 * 回归测试：CC-001 / ST-034 / CT-014 — Electron + Daemon dev 模式 socket 路径冲突
 *
 * 问题：Daemon 和 Electron dev 模式均使用 ~/.tabtin/cli.sock，
 *       后启动者调用 unlinkSync 销毁先启动者的 socket 文件，导致先启动者 CLI Server 静默失效。
 *
 * 修复：Daemon 改用 ~/.tabtin/daemon-cli.sock，与 Electron dev 模式的 cli.sock 完全隔离。
 *       客户端通过 daemon-server.json（动态发现文件）获取实际 socket 路径，不受影响。
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startCLIServer, stopCLIServer } from '../src/transport/cli/cli-server.js'

const TABTIN_DIR = join(homedir(), '.tabtin')
const DAEMON_SOCK = join(TABTIN_DIR, 'daemon-cli.sock')
const ELECTRON_SOCK = join(TABTIN_DIR, 'cli.sock')
const DAEMON_SERVER_JSON = join(TABTIN_DIR, 'daemon-server.json')
const CLI_SERVER_SOURCE = fs.readFileSync(
  new URL('../src/transport/cli/cli-server.ts', import.meta.url),
  'utf-8',
)

describe('F02: Daemon socket path isolation (CC-001/ST-034/CT-014)', () => {
  afterEach(async () => {
    await stopCLIServer()
    for (const p of [DAEMON_SOCK, DAEMON_SERVER_JSON]) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })

  it('Daemon 使用 daemon-cli.sock 而非 cli.sock', () => {
    const info = startCLIServer({ version: '0.0.1-test' })

    if (process.platform !== 'win32') {
      expect(info.socketPath).toContain('daemon-cli.sock')
      expect(info.socketPath).not.toContain('/cli.sock')
    }
  })

  it('daemon-server.json discovery 使用 daemon-cli.sock', () => {
    expect(CLI_SERVER_SOURCE).toContain("socketName: 'daemon-cli.sock'")
    expect(CLI_SERVER_SOURCE).toContain("writeDiscoveryFile('daemon-server.json', owner.info, { source: 'daemon' })")
  })

  it('Daemon 的 socket 路径与 Electron dev 模式完全不同', () => {
    if (process.platform === 'win32') return

    const info = startCLIServer({ version: '0.0.1-test' })

    // 核心断言：Daemon socket 路径与 Electron dev 模式路径不同
    // Electron dev 使用 ~/.tabtin/cli.sock，Daemon 必须使用不同路径
    expect(info.socketPath).not.toBe(ELECTRON_SOCK)
    expect(info.socketPath).toBe(DAEMON_SOCK)
  })

  it('Daemon 停止时不会清理 Electron 的 cli.sock 路径', async () => {
    if (process.platform === 'win32') return

    // 使用一个临时文件模拟 Electron 的 cli.sock（不能覆写真实 socket）
    const tmpElectronSock = join(TABTIN_DIR, '_test_mock_electron.sock')
    fs.mkdirSync(TABTIN_DIR, { recursive: true })
    fs.writeFileSync(tmpElectronSock, 'mock')

    try {
      startCLIServer({ version: '0.0.1-test' })
      await stopCLIServer()

      // stopCLIServer 只清理 info.socketPath（即 daemon-cli.sock），不清理 cli.sock
      // 用临时文件验证：它应完好存在
      expect(fs.existsSync(tmpElectronSock)).toBe(true)
    } finally {
      try { fs.unlinkSync(tmpElectronSock) } catch { /* ignore */ }
    }
  })
})
