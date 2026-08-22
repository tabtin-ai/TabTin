/**
 * Regression tests for Wave 1 F3 — path/URL injection P0 fixes.
 *
 * P0-1: checkpoint project_path must be under workspace_root or ~/.tabtin/
 * P0-2: doc format URL parameter injection (encodeURIComponent)
 * P0-4: savePath must be under workspace_root / ~/.tabtin / tmpdir
 * P0-5: IPv6 SSRF bypass in validateUrl / isPrivateHost
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  validateUrl,
  isPrivateHost,
  validateSavePath,
} from '../src/platform/browser/DaemonBrowserService.js'

import { validateProjectPath } from '@tabtin/action-tools/headless'

const TEST_HOME = '/home/user'
const TEST_SANDBOX_ROOT = '/tmp/tabtin-sandbox'

function validateReadProjectPath(projectPath: string, workspaceRoot?: string) {
  validateProjectPath('read', projectPath, {
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    platformDataRoot: TEST_SANDBOX_ROOT,
    homeDir: TEST_HOME,
  })
}

function validateWriteProjectPath(projectPath: string, workspaceRoot?: string) {
  validateProjectPath('write', projectPath, {
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    platformDataRoot: TEST_SANDBOX_ROOT,
    homeDir: TEST_HOME,
  })
}

// ---------------------------------------------------------------------------
// P0-5 & SVC-08: isPrivateHost — covers IPv4 + IPv6
// ---------------------------------------------------------------------------
describe('isPrivateHost', () => {
  // ── IPv4 private ────────────────────────────────────────────────
  it.each([
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '100.127.255.255',
  ])('detects %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  // ── IPv6 private ────────────────────────────────────────────────
  it.each([
    '::1',
    '0:0:0:0:0:0:0:1',
    '::',
    '0:0:0:0:0:0:0:0',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'feb0::1',
  ])('detects IPv6 %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  // ── IPv4-mapped IPv6 ────────────────────────────────────────────
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
    '::ffff:a9fe:a9fe',
  ])('detects IPv4-mapped %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  // ── Public addresses (should NOT match) ─────────────────────────
  it.each([
    'example.com',
    '8.8.8.8',
    '1.1.1.1',
    '203.0.113.1',
    '2001:db8::1',
    'google.com',
    '100.128.0.1',
    '172.32.0.1',
    '11.0.0.1',
  ])('allows public %s', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P0-5: validateUrl — integration with isPrivateHost
// ---------------------------------------------------------------------------
describe('validateUrl', () => {
  it('allows http public URL', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow()
  })

  it('rejects non-http protocol', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(/不允许的 URL 协议/)
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/不允许的 URL 协议/)
  })

  it('rejects IPv4 private address', () => {
    expect(() => validateUrl('http://127.0.0.1/')).toThrow(/内网地址/)
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data')).toThrow(/内网地址/)
  })

  it('rejects IPv6 ULA address', () => {
    expect(() => validateUrl('http://[fc00::1]/')).toThrow(/内网地址/)
    expect(() => validateUrl('http://[fd12::1]/')).toThrow(/内网地址/)
  })

  it('rejects IPv6 link-local address', () => {
    expect(() => validateUrl('http://[fe80::1]/')).toThrow(/内网地址/)
  })

  it('rejects IPv4-mapped IPv6', () => {
    expect(() => validateUrl('http://[::ffff:127.0.0.1]/')).toThrow(/内网地址/)
  })

  it('rejects invalid URL', () => {
    expect(() => validateUrl('not-a-url')).toThrow(/无效的 URL/)
  })
})

// ---------------------------------------------------------------------------
// P0-4 & SVC-07: validateSavePath
// ---------------------------------------------------------------------------
describe('validateSavePath', () => {
  const tabtinDir = join(homedir(), '.tabtin')
  const tmpDir = tmpdir()
  const cwd = process.cwd()

  it('allows path under ~/.tabtin/', () => {
    expect(() =>
      validateSavePath(join(tabtinDir, 'screenshots', 'test.png')),
    ).not.toThrow()
  })

  it('allows path under tmpdir', () => {
    expect(() =>
      validateSavePath(join(tmpDir, 'screenshot.png')),
    ).not.toThrow()
  })

  it('allows path under cwd', () => {
    expect(() =>
      validateSavePath(join(cwd, 'output', 'file.pdf')),
    ).not.toThrow()
  })

  it('allows path under explicit workspaceRoot', () => {
    expect(() =>
      validateSavePath('/home/user/project/output/test.pdf', '/home/user/project'),
    ).not.toThrow()
  })

  it('rejects absolute path outside allowed dirs', () => {
    expect(() => validateSavePath('/etc/passwd')).toThrow(/不在允许的目录范围内/)
  })

  it('rejects ~/.ssh write attempt', () => {
    expect(() =>
      validateSavePath(join(homedir(), '.ssh', 'authorized_keys')),
    ).toThrow(/不在允许的目录范围内/)
  })

  it('rejects path traversal escape', () => {
    expect(() =>
      validateSavePath(join(tabtinDir, '..', '..', 'etc', 'passwd')),
    ).toThrow(/不在允许的目录范围内/)
  })
})

// ---------------------------------------------------------------------------
// P0-1 & CP-P0-1: validateProjectPath
// ---------------------------------------------------------------------------
describe('validateProjectPath', () => {
  const tabtinDir = join(TEST_HOME, '.tabtin')

  it('allows path under workspace_root', () => {
    expect(() =>
      validateWriteProjectPath('/home/user/my-project', '/home/user/my-project'),
    ).not.toThrow()
  })

  it('allows path under ~/.tabtin/', () => {
    expect(() =>
      validateWriteProjectPath(join(tabtinDir, 'checkpoints', 'abc')),
    ).not.toThrow()
  })

  it('allows sub-directory of workspace_root', () => {
    expect(() =>
      validateWriteProjectPath('/workspace/sub/dir', '/workspace'),
    ).not.toThrow()
  })

  it('rejects /etc', () => {
    expect(() =>
      validateWriteProjectPath('/etc', '/home/user/project'),
    ).toThrow(/outside the allowed workspace/)
  })

  it('rejects /home without workspace_root set', () => {
    expect(() => validateWriteProjectPath('/home')).toThrow(
      /outside the allowed workspace/,
    )
  })

  it('rejects path traversal from workspace_root', () => {
    expect(() =>
      validateWriteProjectPath('/home/user/project/../../other', '/home/user/project'),
    ).toThrow(/outside the allowed workspace/)
  })

  it('rejects system directory even with empty workspace_root', () => {
    expect(() =>
      validateReadProjectPath('/var/lib/secret', ''),
    ).toThrow(/outside allowed directories/)
  })
})

// ---------------------------------------------------------------------------
// P0-2 & SVC-05: format URL injection (structural verification)
// ---------------------------------------------------------------------------
describe('format URL parameter injection', () => {
  it('encodeURIComponent prevents parameter injection', () => {
    const malicious = 'markdown&admin=true&delete=all'
    const encoded = encodeURIComponent(malicious)
    expect(encoded).not.toContain('&')
    expect(encoded).toBe('markdown%26admin%3Dtrue%26delete%3Dall')
  })

  it('safe format values pass through unchanged', () => {
    expect(encodeURIComponent('markdown')).toBe('markdown')
    expect(encodeURIComponent('html')).toBe('html')
    expect(encodeURIComponent('txt')).toBe('txt')
  })
})
