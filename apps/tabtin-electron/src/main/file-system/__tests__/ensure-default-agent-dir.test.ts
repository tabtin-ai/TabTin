/**
 * ensureDefaultAgentDir 单测
 *
 * 覆盖「开箱即用」默认目录的核心契约：
 *   - 在 home 下的 TabTin/Team 父目录里按 Space 名建目录并真实 mkdir
 *   - 显示名归一（剔除文件系统非法字符 / 首尾点空白 / 空名回退）
 *   - collision-safe：同名目录已存在时追加 -2/-3…，不复用别的 Space 的根
 *
 * 只 mock electron 的 app.getPath('home') 指到临时目录，其余走真实 fs。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

let homeRoot = ''
let originalRuntimeProfile: string | undefined

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homeRoot
      return os.tmpdir()
    },
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

import { ensureDefaultAgentDirImpl, sanitizeSpaceDirName } from '../ipc'

describe('sanitizeSpaceDirName', () => {
  it('保留中英文与数字', () => {
    expect(sanitizeSpaceDirName('我的 Space 2')).toBe('我的 Space 2')
  })

  it('剔除文件系统非法字符并折叠空白', () => {
    expect(sanitizeSpaceDirName('a/b:c*?"<>|d')).toBe('a b c d')
  })

  it('去除首尾点与空白', () => {
    expect(sanitizeSpaceDirName('  ..hello..  ')).toBe('hello')
  })

  it('空名回退到 Space', () => {
    expect(sanitizeSpaceDirName('   ')).toBe('工作区')
    expect(sanitizeSpaceDirName('')).toBe('工作区')
  })
})

describe('ensureDefaultAgentDirImpl', () => {
  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-home-'))
    originalRuntimeProfile = process.env.TABTIN_RUNTIME_PROFILE
    process.env.TABTIN_RUNTIME_PROFILE = 'production'
  })
  afterEach(() => {
    try { fs.rmSync(homeRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    if (originalRuntimeProfile === undefined) delete process.env.TABTIN_RUNTIME_PROFILE
    else process.env.TABTIN_RUNTIME_PROFILE = originalRuntimeProfile
  })

  it('在 ~/TabTin/<团队>/<名字> 下真实创建目录', async () => {
    const res = await ensureDefaultAgentDirImpl({
      organizationName: 'Team A',
      spaceName: 'Demo',
    })
    expect(res.success).toBe(true)
    expect(res.path).toBe(path.join(homeRoot, 'TabTin', 'Team A', 'Demo'))
    expect(fs.existsSync(res.path!)).toBe(true)
    expect(fs.statSync(res.path!).isDirectory()).toBe(true)
  })

  it('同团队同名目录已存在时追加数字后缀', async () => {
    const input = { organizationName: 'Team A', spaceName: 'Demo' }
    const first = await ensureDefaultAgentDirImpl(input)
    const second = await ensureDefaultAgentDirImpl(input)
    expect(first.path).toBe(path.join(homeRoot, 'TabTin', 'Team A', 'Demo'))
    expect(second.path).toBe(path.join(homeRoot, 'TabTin', 'Team A', 'Demo-2'))
    expect(fs.existsSync(second.path!)).toBe(true)
  })

  it('对含非法字符的 Space 名先归一再建目录', async () => {
    const res = await ensureDefaultAgentDirImpl({
      organizationName: 'Team/A',
      spaceName: 'a/b:c',
    })
    expect(res.success).toBe(true)
    expect(res.path).toBe(path.join(homeRoot, 'TabTin', 'Team A', 'a b c'))
    expect(fs.existsSync(res.path!)).toBe(true)
  })

  it('兼容旧字符串调用，仍落在 ~/TabTin/<名字>', async () => {
    const res = await ensureDefaultAgentDirImpl('Legacy')
    expect(res.success).toBe(true)
    expect(res.path).toBe(path.join(homeRoot, 'TabTin', 'Legacy'))
    expect(fs.existsSync(res.path!)).toBe(true)
  })

  it('Preprod 使用独立的用户可见 Workspace 根目录', async () => {
    process.env.TABTIN_RUNTIME_PROFILE = 'preprod'
    const res = await ensureDefaultAgentDirImpl({
      organizationName: 'Team A',
      spaceName: 'Demo',
    })
    expect(res).toMatchObject({
      success: true,
      path: path.join(homeRoot, 'TabTin Preprod', 'Team A', 'Demo'),
    })
  })

  it('并发创建同名目录时原子分配不同根', async () => {
    const input = { organizationName: 'Team A', spaceName: 'Demo' }
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureDefaultAgentDirImpl(input)))
    const paths = results.map((result) => result.path)
    expect(results.every((result) => result.success)).toBe(true)
    expect(new Set(paths).size).toBe(8)
    expect(paths).toContain(path.join(homeRoot, 'TabTin', 'Team A', 'Demo'))
    expect(paths).toContain(path.join(homeRoot, 'TabTin', 'Team A', 'Demo-8'))
  })
})
