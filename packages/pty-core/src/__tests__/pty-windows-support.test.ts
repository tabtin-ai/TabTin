/**
 * Windows 平台支持测试 — pty-core 部分
 * 覆盖：PowerShell marker 包装、Windows shell 路径解析、detectShellType
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { wrapCommand, detectShellType } from '../marker/command-wrapper'
import { generateMarkerPair } from '../marker/generator'

// ── detectShellType 测试 ──

describe('detectShellType - Windows shell 识别', () => {
  it('识别 powershell.exe', () => {
    expect(detectShellType('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell')
  })

  it('识别 pwsh.exe', () => {
    expect(detectShellType('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell')
  })

  it('识别 pwsh（无 .exe 后缀，WSL 场景）', () => {
    expect(detectShellType('/usr/bin/pwsh')).toBe('powershell')
  })

  it('识别 cmd.exe 为 posix（cmd 不在 powershell/fish 类别中）', () => {
    // cmd.exe 使用 posix 路径（它不是 PowerShell 也不是 fish）
    expect(detectShellType('C:\\Windows\\System32\\cmd.exe')).toBe('posix')
  })

  it('识别 bash 为 posix', () => {
    expect(detectShellType('/bin/bash')).toBe('posix')
  })

  it('识别 fish', () => {
    expect(detectShellType('/usr/bin/fish')).toBe('fish')
  })
})

// ── PowerShell wrapCommand 测试 ──

describe('wrapCommand - PowerShell 语法', () => {
  let markers: ReturnType<typeof generateMarkerPair>

  beforeEach(() => {
    markers = generateMarkerPair()
  })

  it('使用 Write-Host 输出 marker', () => {
    const result = wrapCommand('Get-ChildItem', markers, { shellType: 'powershell' })
    expect(result).toContain('Write-Host')
    expect(result).toContain(markers.startMarker)
    expect(result).toContain(markers.endMarkerPrefix)
  })

  it('使用 $LASTEXITCODE 获取退出码', () => {
    const result = wrapCommand('Get-ChildItem', markers, { shellType: 'powershell' })
    expect(result).toContain('$LASTEXITCODE')
  })

  it('使用 [char]0x1F 分隔符', () => {
    const result = wrapCommand('Get-ChildItem', markers, { shellType: 'powershell' })
    expect(result).toContain('$([char]0x1F)')
  })

  it('使用 Get-Location 获取 cwd', () => {
    const result = wrapCommand('Get-ChildItem', markers, { shellType: 'powershell' })
    expect(result).toContain('$(Get-Location)')
  })

  it('env 变量使用 $env: 语法', () => {
    const result = wrapCommand('echo test', markers, {
      shellType: 'powershell',
      env: { MY_VAR: 'hello' },
    })
    expect(result).toContain("$env:MY_VAR = 'hello'")
  })

  it('workingDirectory 使用 Set-Location', () => {
    const result = wrapCommand('echo test', markers, {
      shellType: 'powershell',
      workingDirectory: 'C:\\Users\\test',
    })
    expect(result).toContain("Set-Location 'C:\\Users\\test'")
  })

  it('PowerShell 引号中的单引号被正确转义', () => {
    const result = wrapCommand('echo test', markers, {
      shellType: 'powershell',
      env: { PATH_VAR: "it's a test" },
    })
    // PowerShell 用 '' 转义单引号
    expect(result).toContain("'it''s a test'")
  })
})

// ── POSIX wrapCommand 对比（确保未破坏） ──

describe('wrapCommand - POSIX 语法不受影响', () => {
  let markers: ReturnType<typeof generateMarkerPair>

  beforeEach(() => {
    markers = generateMarkerPair()
  })

  it('使用 echo 输出 marker', () => {
    const result = wrapCommand('ls', markers, { shellType: 'posix' })
    expect(result).toContain('echo')
    expect(result).toContain(markers.startMarker)
  })

  it('使用 $? 获取退出码', () => {
    const result = wrapCommand('ls', markers, { shellType: 'posix' })
    expect(result).toContain('$?')
  })

  it("使用 $'\\x1F' 分隔符", () => {
    const result = wrapCommand('ls', markers, { shellType: 'posix' })
    expect(result).toContain("$'\\x1F'")
  })
})

// ── Windows shell 路径解析测试 ──

describe('resolve-shell.ts - Windows shell 安全校验', () => {
  // 注意：这些测试验证导出的类型和常量，不模拟 process.platform
  it('SAFE_WINDOWS_SHELL_PATHS 包含 cmd.exe', async () => {
    const { SAFE_WINDOWS_SHELL_PATHS } = await import('../utils/resolve-shell')
    const paths = SAFE_WINDOWS_SHELL_PATHS.map(p => p.toLowerCase())
    expect(paths).toContain('c:\\windows\\system32\\cmd.exe')
  })

  it('SAFE_WINDOWS_SHELL_PATHS 包含 powershell.exe', async () => {
    const { SAFE_WINDOWS_SHELL_PATHS } = await import('../utils/resolve-shell')
    const paths = SAFE_WINDOWS_SHELL_PATHS.map(p => p.toLowerCase())
    expect(paths).toContain('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe')
  })

  it('SAFE_WINDOWS_SHELL_NAMES 包含已知 shell', async () => {
    const { SAFE_WINDOWS_SHELL_NAMES } = await import('../utils/resolve-shell')
    expect(SAFE_WINDOWS_SHELL_NAMES.has('cmd.exe')).toBe(true)
    expect(SAFE_WINDOWS_SHELL_NAMES.has('powershell.exe')).toBe(true)
    expect(SAFE_WINDOWS_SHELL_NAMES.has('pwsh.exe')).toBe(true)
  })

  it('DEFAULT_WINDOWS_SHELL 为 powershell.exe', async () => {
    const { DEFAULT_WINDOWS_SHELL } = await import('../utils/resolve-shell')
    expect(DEFAULT_WINDOWS_SHELL).toBe('powershell.exe')
  })

  it('Windows fallback 只包含 PowerShell 变体，避免 cmd.exe 生成 POSIX export', async () => {
    const { WINDOWS_FALLBACK_CANDIDATES } = await import('../utils/resolve-shell')
    expect(WINDOWS_FALLBACK_CANDIDATES[0].toLowerCase()).toContain('powershell.exe')
    expect(WINDOWS_FALLBACK_CANDIDATES.join('\n').toLowerCase()).not.toContain('cmd.exe')
  })

  it('Unix shell 验证仍然正常工作', async () => {
    const { isValidShell } = await import('../utils/resolve-shell')
    // 相对路径应被拒绝
    expect(isValidShell('bash')).toBe(false)
    expect(isValidShell('./bash')).toBe(false)
  })
})
