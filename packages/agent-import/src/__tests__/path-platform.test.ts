/**
 * 跨平台 Application Support / APPDATA / XDG 路径决议。
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ImportIO } from '../io.js'
import {
  assertImportSourcePath,
  isForbiddenPath,
  resolveSourcePaths,
  resolveVendorAppDataDir,
} from '../paths.js'

function mockIo(opts: {
  platform: NodeJS.Platform
  home?: string
  env?: Record<string, string | undefined>
}): ImportIO {
  const home = opts.home ?? (opts.platform === 'win32' ? 'C:\\Users\\tester' : '/Users/tester')
  const env = opts.env ?? {}
  return {
    exists: async () => false,
    stat: async () => null,
    readdir: async () => [],
    readTextFile: async () => '',
    readBinaryFile: async () => Buffer.alloc(0),
    async *readJsonlLines() {},
    querySqlite: async () => [],
    writeAttachment: async () => '',
    env: (name) => env[name],
    homedir: () => home,
    platform: () => opts.platform,
  }
}

describe('resolveVendorAppDataDir', () => {
  it('Windows 用 APPDATA', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    expect(resolveVendorAppDataDir(io, 'Cursor')).toBe(
      path.join('C:\\Users\\tester\\AppData\\Roaming', 'Cursor'),
    )
  })

  it('Windows 无 APPDATA 时回退 AppData/Roaming', () => {
    const io = mockIo({ platform: 'win32', env: {} })
    expect(resolveVendorAppDataDir(io, 'Claude')).toBe(
      path.join('C:\\Users\\tester', 'AppData', 'Roaming', 'Claude'),
    )
  })

  it('macOS 用 Library/Application Support', () => {
    const io = mockIo({ platform: 'darwin' })
    expect(resolveVendorAppDataDir(io, 'Cursor')).toBe(
      path.join('/Users/tester', 'Library', 'Application Support', 'Cursor'),
    )
  })

  it('Linux 用 XDG_CONFIG_HOME 或 ~/.config', () => {
    const withXdg = mockIo({
      platform: 'linux',
      home: '/home/tester',
      env: { XDG_CONFIG_HOME: '/custom/config' },
    })
    expect(resolveVendorAppDataDir(withXdg, 'Cursor')).toBe(
      path.join('/custom/config', 'Cursor'),
    )
    const defaultLinux = mockIo({ platform: 'linux', home: '/home/tester', env: {} })
    expect(resolveVendorAppDataDir(defaultLinux, 'Claude')).toBe(
      path.join('/home/tester', '.config', 'Claude'),
    )
  })
})

describe('resolveSourcePaths platform branches', () => {
  it('Windows Cursor 指向 Roaming state.vscdb', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    const paths = resolveSourcePaths(io, 'cursor')
    expect(paths.extras.stateDb).toBe(
      path.join(
        'C:\\Users\\tester\\AppData\\Roaming',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    )
    expect(paths.extras.workspaceStorageDir).toBe(
      path.join('C:\\Users\\tester\\AppData\\Roaming', 'Cursor', 'User', 'workspaceStorage'),
    )
    expect(paths.extras.stateDb).not.toMatch(/Library[/\\]Application Support/)
  })

  it('Windows Claude Desktop 索引在 APPDATA/Claude', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    const paths = resolveSourcePaths(io, 'claude_code')
    expect(paths.extras.desktopSessionsDir).toBe(
      path.join('C:\\Users\\tester\\AppData\\Roaming', 'Claude', 'claude-code-sessions'),
    )
  })

  it('macOS Cursor 仍走 Application Support', () => {
    const io = mockIo({ platform: 'darwin' })
    const paths = resolveSourcePaths(io, 'cursor')
    expect(paths.extras.stateDb).toBe(
      path.join(
        '/Users/tester',
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    )
  })

  it('Codex / WorkBuddy 仍为 home 点目录（跨平台）', () => {
    const win = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    expect(resolveSourcePaths(win, 'codex').roots[0]).toBe(
      path.join('C:\\Users\\tester', '.codex'),
    )
    expect(resolveSourcePaths(win, 'workbuddy').extras.db).toBe(
      path.join('C:\\Users\\tester', '.workbuddy', 'workbuddy.db'),
    )
  })
})

describe('isForbiddenPath cross-platform Claude Desktop', () => {
  it('拦截 mac / Windows / Linux Claude 凭据与 Cookies-journal', () => {
    expect(
      isForbiddenPath('/Users/a/Library/Application Support/Claude/Cookies'),
    ).toBe(true)
    expect(
      isForbiddenPath('C:\\Users\\a\\AppData\\Roaming\\Claude\\Cookies-journal'),
    ).toBe(true)
    expect(
      isForbiddenPath('C:\\Users\\a\\AppData\\Roaming\\Claude\\config.json'),
    ).toBe(true)
    expect(isForbiddenPath('/home/a/.config/Claude/buddy-tokens.json')).toBe(true)
  })

  it('自定义 APPDATA 时凭 io 解析根仍拦 Claude Cookies', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'D:\\CustomData' },
    })
    expect(isForbiddenPath('D:\\CustomData\\Claude\\Cookies', io)).toBe(true)
    expect(
      isForbiddenPath('D:\\CustomData\\Claude\\claude-code-sessions\\x\\local_1.json', io),
    ).toBe(false)
  })

  it('不拦 Claude Desktop 会话索引', () => {
    expect(
      isForbiddenPath(
        'C:\\Users\\a\\AppData\\Roaming\\Claude\\claude-code-sessions\\x\\local_1.json',
      ),
    ).toBe(false)
  })
})

describe('assertImportSourcePath Windows Cursor whitelist', () => {
  it('接受 Windows Roaming 下的 workspace 图片路径', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    const inside = path.join(
      'C:\\Users\\tester\\AppData\\Roaming',
      'Cursor',
      'User',
      'workspaceStorage',
      'abc',
      'images',
      'x.png',
    )
    expect(() => assertImportSourcePath(io, 'cursor', inside)).not.toThrow()
  })

  it('拒绝 mac 风格路径在 Windows IO 下越权', () => {
    const io = mockIo({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    })
    const macStyle = path.join(
      'C:\\Users\\tester',
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    )
    expect(() => assertImportSourcePath(io, 'cursor', macStyle)).toThrow(/白名单根目录/)
  })
})
