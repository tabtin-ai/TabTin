/**
 * Windows Accessibility Tree 采集 + accessibilityText 序列化 测试。
 *
 * 在 macOS 上跑 mock——mock 掉 bridge-manager.call，只测
 * 节点标准化 + 文本序列化 + 错误处理 的正确性。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock bridge-manager
// ---------------------------------------------------------------------------

const mockBridgeCall = vi.fn()

vi.mock('../win32-bridge/bridge-manager', () => ({
  getWin32BridgeManager: () => ({
    call: mockBridgeCall,
    start: vi.fn(),
    ready: true,
    dispose: vi.fn(),
  }),
}))

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
  captureAccessibilityTreeWin,
  serializeAccessibilityText,
} from '../win32-bridge/desktop-accessibility-win'
import { DesktopErrorCode, DesktopError } from '../desktop-error-codes'
import type { AccessibilityNode } from '@tabtin/desktop-contracts'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureAccessibilityTreeWin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('正常采集返回 AccessibilitySnapshot (platform=win32)', async () => {
    mockBridgeCall.mockResolvedValue({
      rootNodes: [
        {
          id: 'win#0',
          role: 'Window',
          name: '记事本',
          enabled: true,
          visible: true,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [
            {
              id: 'win#1',
              role: 'Edit',
              name: '文本编辑区',
              value: 'Hello World',
              enabled: true,
              visible: true,
              bounds: { x: 10, y: 30, width: 780, height: 560 },
            },
          ],
        },
      ],
      hwnd: 12345,
    })

    const snapshot = await captureAccessibilityTreeWin()

    expect(snapshot.platform).toBe('win32')
    expect(snapshot.rootNodes).toHaveLength(1)
    expect(snapshot.rootNodes[0].role).toBe('Window')
    expect(snapshot.rootNodes[0].name).toBe('记事本')
    expect(snapshot.rootNodes[0].children).toHaveLength(1)
    expect(snapshot.rootNodes[0].children![0].role).toBe('Edit')
    expect(snapshot.rootNodes[0].children![0].value).toBe('Hello World')
    expect(snapshot.degraded).toBeUndefined()
  })

  it('传 window 参数定位窗口', async () => {
    mockBridgeCall.mockResolvedValue({ rootNodes: [], hwnd: 999 })

    const snapshot = await captureAccessibilityTreeWin({ window: 'Chrome' })

    expect(mockBridgeCall).toHaveBeenCalledWith('capture_accessibility_tree', {
      maxDepth: 4,
      interactiveOnly: true,
      window: 'Chrome',
    })
    expect(snapshot.degraded).toBeDefined()
    expect(snapshot.degraded!.reason).toContain('未获取到')
  })

  it('传 maxDepth / interactiveOnly', async () => {
    mockBridgeCall.mockResolvedValue({ rootNodes: [], hwnd: 111 })

    await captureAccessibilityTreeWin({ maxDepth: 6, interactiveOnly: false })

    expect(mockBridgeCall).toHaveBeenCalledWith('capture_accessibility_tree', {
      maxDepth: 6,
      interactiveOnly: false,
    })
  })

  it('bridge 抛 DesktopError → 透传', async () => {
    mockBridgeCall.mockRejectedValue(
      new DesktopError(DesktopErrorCode.AX_UNAVAILABLE, 'bridge 不可用'),
    )

    await expect(captureAccessibilityTreeWin()).rejects.toMatchObject({
      code: DesktopErrorCode.AX_UNAVAILABLE,
    })
  })

  it('bridge 抛非 DesktopError → 包装为 AX_UNAVAILABLE', async () => {
    mockBridgeCall.mockRejectedValue(new Error('连接断开'))

    await expect(captureAccessibilityTreeWin()).rejects.toMatchObject({
      code: DesktopErrorCode.AX_UNAVAILABLE,
    })
  })

  it('空节点数组 → degraded 信号', async () => {
    mockBridgeCall.mockResolvedValue({ rootNodes: [], hwnd: 0 })

    const snapshot = await captureAccessibilityTreeWin()
    expect(snapshot.rootNodes).toHaveLength(0)
    expect(snapshot.degraded).toBeDefined()
  })

  it('节点 value 超 200 字符截断', async () => {
    const longValue = 'x'.repeat(300)
    mockBridgeCall.mockResolvedValue({
      rootNodes: [{ id: 'w#0', role: 'Edit', value: longValue, enabled: true, visible: true }],
      hwnd: 1,
    })

    const snapshot = await captureAccessibilityTreeWin()
    expect(snapshot.rootNodes[0].value).toHaveLength(200)
  })

  it('节点缺少 role → 被过滤', async () => {
    mockBridgeCall.mockResolvedValue({
      rootNodes: [
        { id: 'w#0', role: '', enabled: true, visible: true },
        { id: 'w#1', role: 'Button', name: 'OK', enabled: true, visible: true },
      ],
      hwnd: 1,
    })

    const snapshot = await captureAccessibilityTreeWin()
    expect(snapshot.rootNodes).toHaveLength(1)
    expect(snapshot.rootNodes[0].role).toBe('Button')
  })
})

describe('serializeAccessibilityText', () => {
  it('序列化简单节点树为类 DOM 文本', () => {
    const nodes: AccessibilityNode[] = [
      {
        id: 'w#0',
        role: 'Window',
        name: '记事本',
        enabled: true,
        visible: true,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        children: [
          {
            id: 'w#1',
            role: 'Button',
            name: '保存',
            enabled: true,
            visible: true,
            bounds: { x: 10, y: 10, width: 80, height: 30 },
          },
          {
            id: 'w#2',
            role: 'Edit',
            name: '内容',
            value: 'Hello',
            enabled: true,
            visible: true,
            bounds: { x: 10, y: 50, width: 780, height: 540 },
          },
        ],
      },
    ]

    const text = serializeAccessibilityText(nodes)
    expect(text).toContain('<Window name="记事本"')
    expect(text).toContain('<Button name="保存"')
    expect(text).toContain('<Edit name="内容"')
    expect(text).toContain('value="Hello"')
    expect(text).toContain('</Window>')
  })

  it('叶子节点使用自闭合标签', () => {
    const nodes: AccessibilityNode[] = [
      { id: 'w#0', role: 'Button', name: 'OK', enabled: true, visible: true },
    ]
    const text = serializeAccessibilityText(nodes)
    expect(text).toContain('<Button name="OK" />')
  })

  it('disabled 元素标记 enabled="false"', () => {
    const nodes: AccessibilityNode[] = [
      { id: 'w#0', role: 'Button', name: '禁用按钮', enabled: false, visible: true },
    ]
    const text = serializeAccessibilityText(nodes)
    expect(text).toContain('enabled="false"')
  })

  it('超过 maxDepth 的子节点变成自闭合', () => {
    const nodes: AccessibilityNode[] = [
      {
        id: 'w#0', role: 'Window', enabled: true, visible: true,
        children: [{
          id: 'w#1', role: 'Group', enabled: true, visible: true,
          children: [{
            id: 'w#2', role: 'Button', name: 'Deep', enabled: true, visible: true,
          }],
        }],
      },
    ]
    const text = serializeAccessibilityText(nodes, 1)
    expect(text).toContain('<Window>')
    expect(text).toContain('<Group />')
    expect(text).not.toContain('Deep')
  })

  it('空节点数组返回空字符串', () => {
    const text = serializeAccessibilityText([])
    expect(text).toBe('')
  })
})
