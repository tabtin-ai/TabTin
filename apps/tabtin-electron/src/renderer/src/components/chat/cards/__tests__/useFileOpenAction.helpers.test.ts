/**
 * useFileOpenAction · 单根契约下文件路径处理 helper 单测
 *
 * 测试单根契约（见 docs/single-root-space-prd.md §2.4）的核心路径解析行为：
 *   - 相对路径锚定到 working_dir
 *   - 内/外部判断（`isInsideWorkingDir`）
 *   - normalize / basename / isAbsolutePath 边角
 *
 * 这些 helper 仍用于判断文件是否在 working_dir 内（外部文件需额外
 * appendSessionAllowedPath）。左键打开一律走 TabCode（root 仍固定
 * working_dir），不再 fallback 系统应用。表驱动覆盖各种路径形态。
 */

import { describe, it, expect } from 'vitest'
import {
  basename,
  dirnamePath,
  isAbsolutePath,
  normalizePath,
  resolveAgainstWorkingDir,
  resolveFileCardPath,
  isInsideWorkingDir,
} from '../hooks/useFileOpenAction'

describe('useFileOpenAction · 路径 helper', () => {
  describe('isAbsolutePath', () => {
    it.each([
      ['', false],
      ['relative.md', false],
      ['./relative.md', false],
      ['../up.md', false],
      ['src/foo.ts', false],
      ['/Users/me/file.md', true],
      ['/', true],
      ['C:/Users/me/file.md', true],
      ['D:/path', true],
      ['c:/lower.md', true],
    ])('%s → %s', (input, expected) => {
      expect(isAbsolutePath(input)).toBe(expected)
    })
  })

  describe('normalizePath', () => {
    it('Windows \\ 转 /，去掉末尾 /', () => {
      expect(normalizePath('C:\\Users\\me\\proj\\')).toBe('C:/Users/me/proj')
      expect(normalizePath('/tmp/proj/')).toBe('/tmp/proj')
      expect(normalizePath('/tmp/proj///')).toBe('/tmp/proj')
    })
    it('折叠 . 和 .. 段，避免前缀判断被路径穿越绕过', () => {
      expect(normalizePath('/Users/me/space/../outside.md')).toBe('/Users/me/outside.md')
      expect(normalizePath('C:\\Users\\me\\space\\..\\outside.md')).toBe('C:/Users/me/outside.md')
    })
    it('空字符串保留为空', () => {
      expect(normalizePath('')).toBe('')
    })
  })

  describe('basename', () => {
    it.each([
      ['/Users/me/file.md', 'file.md'],
      ['/Users/me/proj/', 'proj'],
      ['file.md', 'file.md'],
      ['', ''],
      ['/', '/'],
    ])('%s → %s', (input, expected) => {
      expect(basename(input)).toBe(expected)
    })
  })

  describe('dirnamePath', () => {
    it.each([
      ['/Users/me/proj/README.md', '/Users/me/proj'],
      ['/Users/me/proj', '/Users/me'],
      ['/', '/'],
    ])('%s → %s', (input, expected) => {
      expect(dirnamePath(input)).toBe(expected)
    })
  })

  describe('resolveAgainstWorkingDir', () => {
    it('working_dir 为空 → 返回 null', () => {
      expect(resolveAgainstWorkingDir('foo.md', '')).toBeNull()
      expect(resolveAgainstWorkingDir('foo.md', null)).toBeNull()
      expect(resolveAgainstWorkingDir('foo.md', undefined)).toBeNull()
    })

    it('相对路径拼接到 working_dir 根', () => {
      expect(resolveAgainstWorkingDir('foo.md', '/Users/me/proj')).toBe('/Users/me/proj/foo.md')
      expect(resolveAgainstWorkingDir('src/main.ts', '/Users/me/proj')).toBe('/Users/me/proj/src/main.ts')
    })

    it('working_dir 末尾斜杠被规范化', () => {
      expect(resolveAgainstWorkingDir('foo.md', '/Users/me/proj/')).toBe('/Users/me/proj/foo.md')
      expect(resolveAgainstWorkingDir('foo.md', '/Users/me/proj///')).toBe('/Users/me/proj/foo.md')
    })

    it('./ 前缀被剥掉', () => {
      expect(resolveAgainstWorkingDir('./foo.md', '/Users/me/proj')).toBe('/Users/me/proj/foo.md')
    })

    it('.. 相对路径先按 working_dir 锚定再规范化', () => {
      expect(resolveAgainstWorkingDir('../outside.md', '/Users/me/proj')).toBe('/Users/me/outside.md')
    })
  })

  describe('resolveFileCardPath', () => {
    it('reveal/open 使用同一规则把相对路径锚到 working_dir', () => {
      expect(resolveFileCardPath('report.md', '/Users/me/space')).toBe('/Users/me/space/report.md')
      expect(resolveFileCardPath('./nested/report.md', '/Users/me/space')).toBe('/Users/me/space/nested/report.md')
    })

    it('绝对路径保持原值，不被拼到 working_dir 下', () => {
      expect(resolveFileCardPath('/tmp/report.md', '/Users/me/space')).toBe('/tmp/report.md')
      expect(resolveFileCardPath('D:/TabTin/report.md', 'C:/Users/me/space')).toBe('D:/TabTin/report.md')
    })

    it('没有 working_dir 时保留原始相对路径，交给下游权限层拒绝或处理', () => {
      expect(resolveFileCardPath('report.md', '')).toBe('report.md')
    })

    it('相对路径穿越会折叠为真实绝对路径，供边界判断拒绝', () => {
      expect(resolveFileCardPath('../outside.md', '/Users/me/space')).toBe('/Users/me/outside.md')
      expect(isInsideWorkingDir(resolveFileCardPath('../outside.md', '/Users/me/space'), '/Users/me/space')).toBe(false)
    })
  })

  describe('isInsideWorkingDir', () => {
    const wd = '/Users/me/proj'

    it.each([
      [wd, wd, true],
      [`${wd}/`, wd, true],
      [`${wd}/file.md`, wd, true],
      [`${wd}/src/main.ts`, wd, true],
      ['/Users/me/proj-other', wd, false], // 同前缀不同目录
      ['/Users/me/projother/x', wd, false], // 防 prefix 误判
      ['/Users/me', wd, false],
      ['/tmp/foo.md', wd, false],
      ['', wd, false],
      [wd, '', false],
      ['', '', false],
    ])('%s in %s → %s', (file, root, expected) => {
      expect(isInsideWorkingDir(file, root)).toBe(expected)
    })

    it('Windows 路径前缀判断（同款语义）', () => {
      const winWD = 'C:\\Users\\me\\proj'
      expect(isInsideWorkingDir('C:\\Users\\me\\proj\\file.md', winWD)).toBe(true)
      expect(isInsideWorkingDir('C:\\Users\\me\\other', winWD)).toBe(false)
    })
  })
})
