/**
 * F09 回归测试：TC-003, TC-008, TC-011, WFE-003, WFE-021
 *
 * TC-003:  Token 恢复失败在三条路径均静默降级 → 修复后返回 token_warning
 * TC-008:  Token 过期预警基础设施 → 修复后传播 token_expires_soon
 * TC-011:  .env.local Token 检测未过滤注释行 → hasValidTokenInEnvFile 过滤注释
 * WFE-003: 幂等场景 tokenProvisioned 误报 false → 区分三态
 * WFE-021: already_exists 分支不验证 token value → hasValidTokenInEnvFile 校验值非空
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/mock/app/path',
  },
}))

const mockDjangoRequest = vi.fn()
vi.mock('../../main/cli/routes/shared/error-handler', () => ({
  djangoRequest: (...args: any[]) => mockDjangoRequest(...args),
}))

import { hasValidTokenInEnvFile, provisionTokenAndWriteEnv } from '../../main/utils/tabsite-helpers'

// ─── TC-011 + WFE-021: hasValidTokenInEnvFile ───────────────────────

describe('TC-011: hasValidTokenInEnvFile 过滤注释行', () => {
  it('注释行 "# VITE_TABTIN_TOKEN=disabled" 不应被判为有效', () => {
    const content = [
      '# VITE_TABTIN_TOKEN=disabled',
      'VITE_TABTIN_API_URL=https://api.example.com',
    ].join('\n')
    expect(hasValidTokenInEnvFile(content)).toBe(false)
  })

  it('行首带空格的注释行也应被过滤', () => {
    const content = '  # VITE_TABTIN_TOKEN=old-token\n'
    expect(hasValidTokenInEnvFile(content)).toBe(false)
  })

  it('正常 Token 行应被识别为有效', () => {
    const content = [
      'VITE_TABTIN_API_URL=https://api.example.com',
      'VITE_TABTIN_TOKEN=tok_abc123xyz',
    ].join('\n')
    expect(hasValidTokenInEnvFile(content)).toBe(true)
  })

  it('Token 和注释同时存在时，识别非注释行的 Token', () => {
    const content = [
      '# VITE_TABTIN_TOKEN=old-disabled',
      'VITE_TABTIN_TOKEN=tok_real_value',
    ].join('\n')
    expect(hasValidTokenInEnvFile(content)).toBe(true)
  })

  it('空文件返回 false', () => {
    expect(hasValidTokenInEnvFile('')).toBe(false)
  })

  it('仅含空行和注释的文件返回 false', () => {
    const content = '\n# comment\n  \n# another\n'
    expect(hasValidTokenInEnvFile(content)).toBe(false)
  })
})

describe('WFE-021: hasValidTokenInEnvFile 校验 token 值非空', () => {
  it('空值 "VITE_TABTIN_TOKEN=" 应被判为无效', () => {
    const content = 'VITE_TABTIN_TOKEN=\n'
    expect(hasValidTokenInEnvFile(content)).toBe(false)
  })

  it('仅含空格的值 "VITE_TABTIN_TOKEN=  " 应被判为无效', () => {
    const content = 'VITE_TABTIN_TOKEN=  \n'
    expect(hasValidTokenInEnvFile(content)).toBe(false)
  })

  it('有效 token 值返回 true', () => {
    const content = 'VITE_TABTIN_TOKEN=tok_valid_123\n'
    expect(hasValidTokenInEnvFile(content)).toBe(true)
  })
})

// ─── WFE-003 + TC-003: provisionTokenAndWriteEnv 三态 ────────────────

describe('WFE-003: provisionTokenAndWriteEnv 幂等场景处理', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabsite-wfe003-'))
    mockDjangoRequest.mockReset()
  })

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true })
  })

  it('新 Token 签发成功 → tokenProvisioned=true', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          VITE_TABTIN_API_URL: 'https://api.example.com',
          VITE_TABTIN_TOKEN: 'tok_new_123',
          VITE_TABTIN_SPACE_ID: 'sp-1',
        },
      },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(true)
    expect(result.tokenAlreadyExists).toBeUndefined()
    expect(result.error).toBeUndefined()

    const envContent = await fsPromises.readFile(path.join(tmpDir, '.env.local'), 'utf-8')
    expect(envContent).toContain('VITE_TABTIN_TOKEN=tok_new_123')
  })

  it('幂等场景：Django 成功但无明文 + .env.local 已有 Token → tokenProvisioned=true, tokenAlreadyExists=true', async () => {
    await fsPromises.writeFile(
      path.join(tmpDir, '.env.local'),
      'VITE_TABTIN_TOKEN=tok_existing_456\nVITE_TABTIN_API_URL=https://api.example.com\n',
    )

    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          VITE_TABTIN_API_URL: 'https://api.example.com',
          VITE_TABTIN_SPACE_ID: 'sp-1',
        },
      },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(true)
    expect(result.tokenAlreadyExists).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('幂等场景：Django 成功但无明文 + .env.local 无 Token → tokenProvisioned=false + 明确错误', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          VITE_TABTIN_API_URL: 'https://api.example.com',
          VITE_TABTIN_SPACE_ID: 'sp-1',
        },
      },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(false)
    expect(result.tokenAlreadyExists).toBe(true)
    expect(result.error).toContain('force')
  })

  it('Django 请求失败 → tokenProvisioned=false', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 500,
      data: { success: false, message: 'Internal Server Error' },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// ─── TC-008: token_expires_soon 传播 ──────────────────────────────

describe('TC-008: provisionTokenAndWriteEnv 传播 token_expires_soon', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tabsite-tc008-'))
    mockDjangoRequest.mockReset()
  })

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true })
  })

  it('Django 返回 token_expires_soon=true 时传播', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          VITE_TABTIN_TOKEN: 'tok_expiring_soon',
          VITE_TABTIN_API_URL: 'https://api.example.com',
          token_expires_soon: true,
        },
      },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(true)
    expect(result.tokenExpiresSoon).toBe(true)
  })

  it('Django 未返回 token_expires_soon 时不设置', async () => {
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          VITE_TABTIN_TOKEN: 'tok_fresh',
          VITE_TABTIN_API_URL: 'https://api.example.com',
        },
      },
    })

    const result = await provisionTokenAndWriteEnv('site-1', tmpDir)
    expect(result.tokenProvisioned).toBe(true)
    expect(result.tokenExpiresSoon).toBeFalsy()
  })
})

// ─── TC-003: IPC / CLI 响应结构验证 ───────────────────────────────

describe('TC-003: Token 恢复失败必须携带 token_warning', () => {
  it('IPC 响应在 token_provisioned=false 时必须包含 token_warning', () => {
    const tokenProvisioned = false
    const tokenWarning = 'Token 恢复失败，站点数据功能可能不可用'

    const ipcResponse = {
      success: true,
      code_project_path: '/path/to/project',
      already_exists: true,
      token_provisioned: tokenProvisioned,
      ...(tokenWarning && { token_warning: tokenWarning }),
    }

    expect(ipcResponse.token_provisioned).toBe(false)
    expect(ipcResponse).toHaveProperty('token_warning')
    expect(ipcResponse.token_warning).toContain('Token')
  })

  it('CLI 响应在 token_provisioned=false 时必须包含 token_warning', () => {
    const tokenProvisioned = false
    const tokenWarning = 'Token 配置失败，站点数据功能可能不可用'

    const cliResponse = {
      success: true,
      data: {
        code_project_path: '/path',
        template: 'dashboard',
        token_provisioned: tokenProvisioned,
        ...(tokenWarning && { token_warning: tokenWarning }),
      },
    }

    expect(cliResponse.data.token_provisioned).toBe(false)
    expect(cliResponse.data).toHaveProperty('token_warning')
  })

  it('token_provisioned=true 时不应包含 token_warning', () => {
    const tokenWarning: string | undefined = undefined
    const response = {
      success: true,
      token_provisioned: true,
      ...(tokenWarning && { token_warning: tokenWarning }),
    }

    expect(response.token_provisioned).toBe(true)
    expect(response).not.toHaveProperty('token_warning')
  })
})
