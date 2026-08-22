/**
 * Unit tests for fix-process-path.
 *
 * 关注点：
 *   1. detectUserShell 在三种来源（SHELL env / /etc/passwd / fallback）下的取值
 *   2. prependBinDirs 去重 + 顺序保持
 *   3. fixProcessPath 在受限 PATH 下能 fallback 补出常见 user bin
 *   4. fixProcessPath 失败永不抛错（保留原 PATH）
 *   5. Windows 平台直接 noop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { fixProcessPath, __test } from '../src/platform/system/process/fix-process-path.js'

const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_SHELL = process.env.SHELL

describe('fix-process-path', () => {
  beforeEach(() => {
    process.env.PATH = ORIGINAL_PATH
    process.env.SHELL = ORIGINAL_SHELL
  })

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH
    process.env.SHELL = ORIGINAL_SHELL
    vi.restoreAllMocks()
  })

  describe('prependBinDirs', () => {
    it('在空 PATH 下追加候选目录', () => {
      const result = __test.prependBinDirs('', ['/foo/bin', '/bar/bin'])
      expect(result).toBe(`/foo/bin${path.delimiter}/bar/bin`)
    })

    it('已存在的目录不重复添加', () => {
      const before = `/foo/bin${path.delimiter}/usr/bin`
      const result = __test.prependBinDirs(before, ['/foo/bin', '/baz/bin'])
      expect(result).toBe(`/baz/bin${path.delimiter}/foo/bin${path.delimiter}/usr/bin`)
    })

    it('全部已存在时返回原值', () => {
      const before = `/foo/bin${path.delimiter}/bar/bin`
      const result = __test.prependBinDirs(before, ['/foo/bin', '/bar/bin'])
      expect(result).toBe(before)
    })

    it('空 dirs 数组返回原值', () => {
      const before = `/foo/bin${path.delimiter}/bar/bin`
      expect(__test.prependBinDirs(before, [])).toBe(before)
    })
  })

  describe('detectUserShell', () => {
    it('优先用 SHELL env（用户 shell 启动 daemon CLI）', () => {
      process.env.SHELL = '/bin/zsh'
      expect(__test.detectUserShell()).toBe('/bin/zsh')
    })

    it('SHELL 没设时回退（/etc/passwd 或 /bin/sh）', () => {
      delete process.env.SHELL
      const result = __test.detectUserShell()
      // 至少能拿到一个非空字符串（具体值依赖运行环境）
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('collectUserBinDirs', () => {
    it('返回的所有目录都真实存在', () => {
      const dirs = __test.collectUserBinDirs()
      const fs = require('node:fs')
      for (const d of dirs) {
        expect(fs.existsSync(d), `${d} should exist`).toBe(true)
        expect(fs.statSync(d).isDirectory(), `${d} should be a directory`).toBe(true)
      }
    })

    it('macOS 时优先包含 /opt/homebrew/bin（arm64）或 /usr/local/bin（x64）', () => {
      if (process.platform !== 'darwin') return
      const dirs = __test.collectUserBinDirs()
      const expectedHomebrew = process.arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin'
      const fs = require('node:fs')
      if (fs.existsSync(expectedHomebrew)) {
        expect(dirs).toContain(expectedHomebrew)
      }
    })
  })

  describe('fixProcessPath', () => {
    it('Windows 平台直接 noop', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        const before = process.env.PATH
        const result = fixProcessPath({ log: () => undefined })
        expect(result.source).toBe('noop-windows')
        expect(process.env.PATH).toBe(before)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })

    it('受限 PATH 下能补出至少一个用户 bin 目录', () => {
      if (process.platform === 'win32') return // Windows 单独测过 noop
      // 模拟 LaunchServices 给的精简 PATH
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
      delete process.env.SHELL
      const before = process.env.PATH

      const logs: Array<{ level: string; msg: string }> = []
      const result = fixProcessPath({ log: (level, msg) => logs.push({ level, msg }) })

      // 期望要么 fix-path 起作用，要么 fallback 补了 user bin
      expect(['fix-path', 'fallback']).toContain(result.source)
      expect(result.after.length).toBeGreaterThan(before.length)
      expect(process.env.PATH).toBe(result.after)
    })

    it('完整 PATH 下不会破坏原 PATH', () => {
      if (process.platform === 'win32') return
      // 用一个明显完整的 PATH（含 homebrew）跑
      const home = os.homedir()
      const richPath = [
        '/opt/homebrew/bin',
        path.join(home, '.cargo', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(path.delimiter)
      process.env.PATH = richPath

      const result = fixProcessPath({ log: () => undefined })

      // 即使 fix-path 改了 PATH，也至少要包含原本所有段
      const afterSegs = (process.env.PATH || '').split(path.delimiter)
      const beforeSegs = richPath.split(path.delimiter)
      for (const seg of beforeSegs) {
        expect(afterSegs).toContain(seg)
      }
      // source 可能是 unchanged / fix-path / fallback 任一种
      expect(['unchanged', 'fix-path', 'fallback']).toContain(result.source)
    })

    it('返回的 before/after 字符串语义一致', () => {
      const originalBefore = process.env.PATH || ''
      const result = fixProcessPath({ log: () => undefined })
      expect(result.before).toBe(originalBefore)
      expect(result.after).toBe(process.env.PATH || '')
    })
  })
})
