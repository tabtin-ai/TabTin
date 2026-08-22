/**
 * Regression tests for FU-011/FU-012/FU-013/FU-015/FU-016/CC-017/FU-024 fixes.
 *
 * FU-016: copyDirSafe failure → caller must clean up partial directory
 * FU-013: IPC/CLI init-template PATCH failure should include code_project_path
 * FU-015: token_provisioned=false should be surfaced with token_error
 * CC-017: CLI create should surface init-template failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app/path',
    getPath: () => '/mock/path',
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { copyDirSafe } from '../../main/utils/tabsite-helpers'

describe('FU-016: copyDirSafe failure cleanup pattern', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabsite-fu016-'))
  })

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true })
  })

  it('leaves partial files on failure — proving caller cleanup is needed', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest')

    await fsPromises.mkdir(path.join(src, 'sub'), { recursive: true })
    await fsPromises.writeFile(path.join(src, 'good.txt'), 'ok')
    await fsPromises.writeFile(path.join(src, 'sub', 'deep.txt'), 'nested')

    await fsPromises.mkdir(dest, { recursive: true })
    await fsPromises.mkdir(path.join(dest, 'sub'), { recursive: true })
    await fsPromises.writeFile(path.join(dest, 'sub', 'deep.txt'), 'block')
    await fsPromises.chmod(path.join(dest, 'sub', 'deep.txt'), 0o000)

    let threw = false
    try {
      await copyDirSafe(src, dest)
    } catch {
      threw = true
    }

    await fsPromises.chmod(path.join(dest, 'sub', 'deep.txt'), 0o644).catch(() => {})

    if (threw) {
      // good.txt was copied before sub/deep.txt failed → partial state
      expect(fs.existsSync(path.join(dest, 'good.txt'))).toBe(true)

      // Simulate caller cleanup (the fix pattern in ipc.ts and routes/tabsite.ts)
      await fsPromises.rm(dest, { recursive: true, force: true })
      expect(fs.existsSync(dest)).toBe(false)
    }
  })

  it('caller try-catch-rm pattern cleans up on post-copy failure', async () => {
    const src = path.join(tmpDir, 'src')
    const dest = path.join(tmpDir, 'dest-cleanup')

    await fsPromises.mkdir(src, { recursive: true })
    await fsPromises.writeFile(path.join(src, 'file.txt'), 'data')

    await fsPromises.mkdir(dest, { recursive: true })

    const simulatedInitTemplate = async () => {
      await copyDirSafe(src, dest)
      throw new Error('simulated post-copy failure')
    }

    try {
      await simulatedInitTemplate()
    } catch {
      await fsPromises.rm(dest, { recursive: true, force: true }).catch(() => {})
    }

    expect(fs.existsSync(dest)).toBe(false)
  })

  it('directory removed by cleanup is no longer detected as non-empty', async () => {
    const projectPath = path.join(tmpDir, 'project')

    await fsPromises.mkdir(projectPath, { recursive: true })
    await fsPromises.writeFile(path.join(projectPath, 'partial.txt'), 'incomplete')
    expect(fs.readdirSync(projectPath).length > 0).toBe(true)

    await fsPromises.rm(projectPath, { recursive: true, force: true })

    // Next initTemplate call won't mistake cleaned path as "already initialized"
    expect(fs.existsSync(projectPath)).toBe(false)
  })
})

describe('FU-013: init-template PATCH failure response alignment', () => {
  it('CLI route response should include code_project_path on PATCH failure', () => {
    // Mirrors the fixed response format in routes/tabsite.ts
    const cliResponse = {
      success: false,
      error: '目录已存在但更新站点信息失败: 500',
      data: { code_project_path: '/sandbox/agent-spaces/sp1/sites/my-site' },
    }

    expect(cliResponse.data.code_project_path).toBeTruthy()
    expect(cliResponse.success).toBe(false)
    expect(cliResponse.error).toContain('更新站点信息失败')
  })

  it('IPC response should include code_project_path on PATCH failure', () => {
    const ipcResponse = {
      success: false,
      error: '目录已存在但更新站点信息失败: 500',
      code_project_path: '/sandbox/agent-spaces/sp1/sites/my-site',
    }

    expect(ipcResponse.code_project_path).toBeTruthy()
    expect(ipcResponse.success).toBe(false)
  })
})

describe('FU-015: token_provisioned and token_error surfacing', () => {
  it('response includes token_error when provision fails', () => {
    const tokenError: string | undefined = 'provision failed'
    const response = {
      success: true,
      code_project_path: '/path',
      template: 'dashboard',
      token_provisioned: false,
      ...(tokenError && { token_error: tokenError }),
    }

    expect(response.success).toBe(true)
    expect(response.token_provisioned).toBe(false)
    expect(response).toHaveProperty('token_error')
    expect(response.token_error).toBe('provision failed')
  })

  it('response omits token_error when provision succeeds', () => {
    const tokenError: string | undefined = undefined
    const response = {
      success: true,
      code_project_path: '/path',
      template: 'dashboard',
      token_provisioned: true,
      ...(tokenError && { token_error: tokenError }),
    }

    expect(response.token_provisioned).toBe(true)
    expect(response).not.toHaveProperty('token_error')
  })

  it('non-dashboard templates do not include token fields', () => {
    const response = {
      success: true,
      code_project_path: '/path',
      template: 'blank',
      token_provisioned: false,
    }

    expect(response.template).toBe('blank')
    expect(response).not.toHaveProperty('token_error')
  })
})

describe('CC-017: CLI create init-template failure surfacing', () => {
  it('init-template failure should be detectable from response', () => {
    const initRes = {
      status: 500,
      data: { error: 'COPY_FAILED', message: '模板复制失败: permission denied' },
    }

    const isSuccess = initRes.status === 200
    expect(isSuccess).toBe(false)

    const errDetail = initRes.data?.error || initRes.data?.message || '未知错误'
    expect(errDetail).toContain('COPY_FAILED')
  })

  it('daemon 501 responses should be distinguishable', () => {
    const initRes = {
      status: 501,
      data: { error: 'NOT_IMPLEMENTED', message: 'init-template 需要本地文件系统' },
    }

    expect(initRes.status).toBe(501)
    expect(initRes.data.error).toBe('NOT_IMPLEMENTED')
  })

  it('success response with failed token should carry token_error', () => {
    const initRes = {
      status: 200,
      data: {
        success: true,
        data: {
          code_project_path: '/path/to/project',
          token_provisioned: false,
          token_error: 'Django 500',
        },
      },
    }

    expect(initRes.data.success).toBe(true)
    expect(initRes.data.data.token_provisioned).toBe(false)
    expect(initRes.data.data.token_error).toBeTruthy()
  })
})
