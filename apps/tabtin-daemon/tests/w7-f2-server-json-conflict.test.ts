/**
 * I-4 (P1): Electron ↔ Daemon dev-server.json path conflict fix.
 *
 * Daemon now writes daemon-server.json; CLI discovery prefers it
 * over Electron's dev-server.json, with TABTIN_SOCK as highest priority.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startCLIServer, stopCLIServer } from '../src/transport/cli/cli-server.js'

const TABTIN_DIR = join(homedir(), '.tabtin')
const DAEMON_SERVER_PATH = join(TABTIN_DIR, 'daemon-server.json')
const DEV_SERVER_PATH = join(TABTIN_DIR, 'dev-server.json')
const CLI_SERVER_SOURCE = fs.readFileSync(
  new URL('../src/transport/cli/cli-server.ts', import.meta.url),
  'utf-8',
)

function startTestServer() {
  const socketPath = join(TABTIN_DIR, `daemon-cli-test-${process.pid}-${Date.now()}.sock`)
  return startCLIServer({ version: '0.0.1-test', socketPath })
}

describe('I-4: Server JSON path conflict', () => {
  afterEach(async () => {
    await stopCLIServer()
    for (const p of [DAEMON_SERVER_PATH, DEV_SERVER_PATH]) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  })

  describe('Daemon writes daemon-server.json (not dev-server.json)', () => {
    it('creates daemon-server.json on start', () => {
      expect(CLI_SERVER_SOURCE).toContain("writeDiscoveryFile('daemon-server.json', owner.info, { source: 'daemon' })")
      expect(CLI_SERVER_SOURCE).not.toContain("writeDiscoveryFile('dev-server.json'")
    })

    it('does NOT create dev-server.json', () => {
      try { fs.unlinkSync(DEV_SERVER_PATH) } catch { /* ignore */ }

      startTestServer()

      expect(fs.existsSync(DEV_SERVER_PATH)).toBe(false)
    })

    it('cleans up daemon-server.json on stop', async () => {
      startTestServer()

      await stopCLIServer()
      expect(CLI_SERVER_SOURCE).toContain("cleanupDiscoveryFile('daemon-server.json')")
    })

    it('does not interfere with existing dev-server.json from Electron', async () => {
      const electronData = {
        token: 'electron-token-abc',
        sock: '/tmp/electron.sock',
        pid: 99999,
        startedAt: new Date().toISOString(),
      }
      fs.mkdirSync(TABTIN_DIR, { recursive: true })
      fs.writeFileSync(DEV_SERVER_PATH, JSON.stringify(electronData), 'utf-8')

      startTestServer()

      expect(fs.existsSync(DEV_SERVER_PATH)).toBe(true)
      const electronContent = JSON.parse(fs.readFileSync(DEV_SERVER_PATH, 'utf-8'))
      expect(electronContent.token).toBe('electron-token-abc')

      expect(CLI_SERVER_SOURCE).toContain("writeDiscoveryFile('daemon-server.json', owner.info, { source: 'daemon' })")
      expect(CLI_SERVER_SOURCE).not.toContain("writeDiscoveryFile('dev-server.json'")
    })

    it('daemon-server.json has 0o600 permissions', () => {
      startTestServer()

      if (process.platform !== 'win32' && fs.existsSync(DAEMON_SERVER_PATH)) {
        const stat = fs.statSync(DAEMON_SERVER_PATH)
        const mode = stat.mode & 0o777
        expect(mode).toBe(0o600)
      }
    })
  })
})
