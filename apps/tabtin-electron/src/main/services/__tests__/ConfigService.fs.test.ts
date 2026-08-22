import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mockState = vi.hoisted(() => ({
  userDataPath: '',
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockState.userDataPath
      return os.tmpdir()
    },
  },
}))

describe('ConfigService filesystem persistence', () => {
  let tmpRoot = ''

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-config-service-'))
    mockState.userDataPath = path.join(tmpRoot, 'TabTin Dev')
    vi.resetModules()
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('首次保存配置时自动创建 userData 目录并落盘', async () => {
    expect(fs.existsSync(mockState.userDataPath)).toBe(false)

    const { AppConfigService } = await import('../ConfigService')
    const service = AppConfigService.getInstance()

    service.set('ws.gatewayId', 'electron-test-device')

    const configPath = path.join(mockState.userDataPath, 'app-config.json')
    expect(fs.existsSync(configPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
      'ws.gatewayId': 'electron-test-device',
    })
  })
})
