import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock child_process (osascript 调用)
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn()
vi.mock('node:child_process', () => {
  const mod = {
    execFile: (...args: unknown[]) => mockExecFile(...args),
    execFileSync: vi.fn(),
  }
  return { ...mod, default: mod }
})

vi.mock('../../logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import {
  captureAccessibilityTreeMac,
  findElementInSnapshot,
  collectCandidateNames,
} from '../desktop-accessibility'
import type { AccessibilitySnapshot, AccessibilityNode } from '@tabtin/desktop-contracts'
import { DesktopErrorCode } from '../desktop-error-codes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockExecFileSuccess(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, stdout, '')
    },
  )
}

function mockExecFileError(stderr: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error(stderr), '', stderr)
    },
  )
}

function mockExecFileSequence(responses: Array<{ stdout?: string; error?: string }>) {
  let callIdx = 0
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const resp = responses[callIdx] ?? responses[responses.length - 1]
      callIdx++
      if (resp.error) {
        cb(new Error(resp.error), '', resp.error)
      } else {
        cb(null, resp.stdout ?? '', '')
      }
    },
  )
}

const SAMPLE_NODES: AccessibilityNode[] = [
  {
    id: 'TextEdit#0',
    role: 'Window',
    name: 'Untitled',
    enabled: true,
    visible: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    children: [
      {
        id: 'TextEdit#1',
        role: 'Button',
        name: 'Share',
        enabled: true,
        visible: true,
        bounds: { x: 700, y: 10, width: 80, height: 30 },
      },
      {
        id: 'TextEdit#2',
        role: 'Button',
        name: 'Save',
        enabled: true,
        visible: true,
        bounds: { x: 600, y: 10, width: 80, height: 30 },
      },
      {
        id: 'TextEdit#3',
        role: 'Button',
        name: 'Save',
        enabled: false,
        visible: true,
        bounds: { x: 500, y: 10, width: 80, height: 30 },
      },
      {
        id: 'TextEdit#4',
        role: 'TextField',
        name: 'Search',
        enabled: true,
        visible: true,
        bounds: { x: 100, y: 50, width: 200, height: 30 },
        value: 'hello',
      },
    ],
  },
]

const SAMPLE_SNAPSHOT: AccessibilitySnapshot = {
  capturedAt: '2026-04-23T10:00:00.000Z',
  targetWindow: { app: 'TextEdit', title: 'Untitled' },
  platform: 'darwin',
  rootNodes: SAMPLE_NODES,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('desktop-accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  describe('captureAccessibilityTreeMac', () => {
    it('应返回 AX 快照（macOS，前台窗口）', async () => {
      mockExecFileSequence([
        { stdout: 'TextEdit|||Untitled|||com.apple.TextEdit' },
        { stdout: JSON.stringify(SAMPLE_NODES) },
      ])

      const result = await captureAccessibilityTreeMac()
      expect(result.platform).toBe('darwin')
      expect(result.targetWindow.app).toBe('TextEdit')
      expect(result.rootNodes.length).toBeGreaterThan(0)
      expect(result.degraded).toBeUndefined()
    })

    it('空结果时应返回 degraded 信号', async () => {
      mockExecFileSequence([
        { stdout: 'Safari|||Some Page|||com.apple.Safari' },
        { stdout: '[]' },
      ])

      const result = await captureAccessibilityTreeMac()
      expect(result.rootNodes).toHaveLength(0)
      expect(result.degraded).toBeDefined()
      expect(result.degraded!.reason).toContain('未获取到任何 AX 节点')
    })

    it('TCC 权限未授予时应抛 AX_UNAVAILABLE', async () => {
      mockExecFileSequence([
        { stdout: 'TextEdit|||Untitled|||com.apple.TextEdit' },
        { error: 'not allowed assistive access' },
      ])

      await expect(captureAccessibilityTreeMac()).rejects.toMatchObject({
        code: DesktopErrorCode.AX_UNAVAILABLE,
      })
    })

    it('osascript 超时应抛 INTERNAL_ERROR', async () => {
      mockExecFileSequence([
        { stdout: 'TextEdit|||Untitled|||com.apple.TextEdit' },
        { error: 'timed out after 30000ms' },
      ])

      await expect(captureAccessibilityTreeMac()).rejects.toMatchObject({
        code: DesktopErrorCode.INTERNAL_ERROR,
      })
    })

    it('按窗口名查找不到时应抛 ELEMENT_NOT_FOUND', async () => {
      mockExecFileError('找不到匹配窗口')

      await expect(
        captureAccessibilityTreeMac({ window: 'NonExistent' }),
      ).rejects.toMatchObject({
        code: DesktopErrorCode.ELEMENT_NOT_FOUND,
      })
    })

    it('按 bundleId 查找成功', async () => {
      mockExecFileSequence([
        { stdout: 'TextEdit|||Untitled|||com.apple.TextEdit' },
        { stdout: JSON.stringify(SAMPLE_NODES) },
      ])

      const result = await captureAccessibilityTreeMac({
        bundleId: 'com.apple.TextEdit',
      })
      expect(result.targetWindow.bundleId).toBe('com.apple.TextEdit')
    })

    it('JSON 解析失败时应返回空节点 + degraded', async () => {
      mockExecFileSequence([
        { stdout: 'TextEdit|||Untitled|||com.apple.TextEdit' },
        { stdout: 'not valid json{{{' },
      ])

      const result = await captureAccessibilityTreeMac()
      expect(result.rootNodes).toHaveLength(0)
      expect(result.degraded).toBeDefined()
    })
  })

  describe('findElementInSnapshot', () => {
    it('按名称匹配（case-insensitive partial）', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'share')
      expect(node).not.toBeNull()
      expect(node!.role).toBe('Button')
      expect(node!.name).toBe('Share')
    })

    it('按名称 + 角色匹配', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'Save', 'Button')
      expect(node).not.toBeNull()
      expect(node!.name).toBe('Save')
    })

    it('nth 参数选第二个同名元素', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'Save', 'Button', 1)
      expect(node).not.toBeNull()
      expect(node!.id).toBe('TextEdit#3')
      expect(node!.enabled).toBe(false)
    })

    it('找不到时返回 null', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'NonExistent')
      expect(node).toBeNull()
    })

    it('角色不匹配时返回 null', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'Share', 'TextField')
      expect(node).toBeNull()
    })

    it('nth 越界时返回 null', () => {
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'Share', undefined, 5)
      expect(node).toBeNull()
    })
  })

  describe('collectCandidateNames', () => {
    it('收集所有有名称的元素', () => {
      const candidates = collectCandidateNames(SAMPLE_SNAPSHOT)
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates.some(c => c.includes('Share'))).toBe(true)
      expect(candidates.some(c => c.includes('Save'))).toBe(true)
    })

    it('按角色过滤', () => {
      const candidates = collectCandidateNames(SAMPLE_SNAPSHOT, 'TextField')
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toContain('Search')
    })

    it('limit 参数限制结果数量', () => {
      const candidates = collectCandidateNames(SAMPLE_SNAPSHOT, undefined, 2)
      expect(candidates.length).toBeLessThanOrEqual(2)
    })
  })

  describe('maxNodes 截断', () => {
    it('节点数超 maxNodes 时 JXA 输出 truncated=true', async () => {
      const truncatedResult = {
        roots: [{ id: 'T#0', role: 'Button', name: 'OK', enabled: true, visible: true }],
        truncated: true,
        nodeCount: 501,
      }
      mockExecFileSequence([
        { stdout: 'TestApp|||Window|||com.test.app' },
        { stdout: JSON.stringify(truncatedResult) },
      ])

      const result = await captureAccessibilityTreeMac({ maxNodes: 500 })
      expect(result.rootNodes).toHaveLength(1)
      expect(result.degraded).toBeDefined()
      expect(result.degraded!.reason).toContain('截断')
      expect(result.degraded!.reason).toContain('maxNodes=500')
    })

    it('未超限时无 truncated 标记', async () => {
      const normalResult = {
        roots: [{ id: 'T#0', role: 'Button', name: 'OK', enabled: true, visible: true }],
        truncated: false,
        nodeCount: 1,
      }
      mockExecFileSequence([
        { stdout: 'TestApp|||Window|||com.test.app' },
        { stdout: JSON.stringify(normalResult) },
      ])

      const result = await captureAccessibilityTreeMac({ maxNodes: 500 })
      expect(result.rootNodes).toHaveLength(1)
      expect(result.degraded).toBeUndefined()
    })
  })

  describe('findElementInSnapshot 与 enabled 字段', () => {
    it('能找到 enabled=false 的元素（clickElement 负责拒绝）', () => {
      // findElementInSnapshot 不做 enabled 过滤——它是纯查找。
      // enabled 检查由 clickElement 在调用 findElementInSnapshot 之后做。
      const node = findElementInSnapshot(SAMPLE_SNAPSHOT, 'Save', 'Button', 1)
      expect(node).not.toBeNull()
      expect(node!.enabled).toBe(false)
    })
  })
})
