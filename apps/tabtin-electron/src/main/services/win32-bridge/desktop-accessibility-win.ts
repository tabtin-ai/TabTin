/**
 * Windows Accessibility Tree 采集（通过 bridge.py UIAutomation）。
 *
 * 与 macOS 侧 `desktop-accessibility.ts` 的 `captureAccessibilityTreeMac` 对等：
 * - 数据结构共用 `AccessibilityNode`（contracts 包已定义）
 * - 返回 `AccessibilitySnapshot`（platform: 'win32'）
 * - 错误码复用 `ELEMENT_NOT_FOUND` / `AX_UNAVAILABLE`
 *
 * 调用链：TS → bridge-manager.call('capture_accessibility_tree', ...) → bridge.py →
 * UIAutomation COM 或 PowerShell fallback → stdout JSON → TS 解析。
 */

import { createLogger } from '../../logger'
import { DesktopError, DesktopErrorCode } from '../desktop-error-codes'
import { getWin32BridgeManager } from './bridge-manager'
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  AccessibilityTreeOpts,
} from '@tabtin/desktop-contracts'

const log = createLogger('DesktopAXWin')

/**
 * Windows AX 树采集入口。
 *
 * @throws DesktopError(AX_UNAVAILABLE) - bridge.py 不可用或 UIA 查询失败
 * @throws DesktopError(ELEMENT_NOT_FOUND) - 找不到指定窗口
 */
export async function captureAccessibilityTreeWin(
  opts: AccessibilityTreeOpts = {},
): Promise<AccessibilitySnapshot> {
  const bridge = getWin32BridgeManager()

  const params: Record<string, unknown> = {
    maxDepth: opts.maxDepth ?? 4,
    interactiveOnly: opts.interactiveOnly !== false,
  }

  if (opts.window) {
    params.window = opts.window
  }

  // FIXME(Win真机验): bundleId 在 Windows 上的对应概念是进程名或 AppUserModelID，
  // 当前直接当窗口标题搜索，真机验证时需要确认映射逻辑
  if (opts.bundleId) {
    params.window = opts.bundleId
  }

  let result: Record<string, unknown>
  try {
    result = await bridge.call('capture_accessibility_tree', params)
  } catch (err) {
    if (err instanceof DesktopError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new DesktopError(
      DesktopErrorCode.AX_UNAVAILABLE,
      `Windows AX 查询失败：${msg.slice(0, 200)}。` +
      `本次 AX 查询未执行。` +
      `请检查 bridge.py 状态，或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
    )
  }

  const rawNodes = (result.rootNodes as unknown[]) ?? []
  const rootNodes = normalizeNodes(rawNodes)

  // 获取窗口标题信息
  let targetWindow: { app: string; title: string; bundleId?: string } = {
    app: 'Unknown',
    title: opts.window ?? '',
  }

  try {
    const hwnd = result.hwnd as number | undefined
    if (hwnd && opts.window) {
      targetWindow = { app: opts.window, title: opts.window }
    }
  } catch {
    // 保持默认
  }

  return {
    capturedAt: new Date().toISOString(),
    targetWindow,
    platform: 'win32',
    rootNodes,
    degraded: rootNodes.length === 0
      ? { reason: '未获取到任何 AX 节点——目标应用可能不暴露 UIAutomation 信息' }
      : undefined,
  }
}

/**
 * 将 bridge.py 返回的原始节点数组标准化为 `AccessibilityNode[]`。
 */
function normalizeNodes(raw: unknown[]): AccessibilityNode[] {
  const nodes: AccessibilityNode[] = []
  for (const item of raw) {
    const node = normalizeNode(item)
    if (node) nodes.push(node)
  }
  return nodes
}

function normalizeNode(raw: unknown): AccessibilityNode | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const role = String(obj.role ?? '')
  if (!role) return null

  const node: AccessibilityNode = {
    id: String(obj.id ?? ''),
    role,
    enabled: obj.enabled !== false,
    visible: obj.visible !== false,
  }

  if (obj.name) node.name = String(obj.name)
  if (obj.value !== undefined && obj.value !== null) {
    const v = String(obj.value)
    node.value = v.length > 200 ? v.slice(0, 200) : v
  }

  if (obj.bounds && typeof obj.bounds === 'object') {
    const b = obj.bounds as Record<string, number>
    node.bounds = {
      x: Number(b.x ?? 0),
      y: Number(b.y ?? 0),
      width: Number(b.width ?? 0),
      height: Number(b.height ?? 0),
    }
  }

  if (Array.isArray(obj.children) && obj.children.length > 0) {
    node.children = normalizeNodes(obj.children)
    if (node.children.length === 0) delete node.children
  }

  return node
}

/**
 * 将 AX 快照序列化为 accessibilityText（类 DOM 文本）。
 *
 * 格式：`<role name="..." [bounds=...] [enabled=...]>...</role>`
 * 与规范 § 9.4.1 第 4 项 + contracts 占位的 `accessibilityText` 字段对齐。
 */
export function serializeAccessibilityText(nodes: AccessibilityNode[], maxDepth = 3): string {
  const lines: string[] = []

  function walk(nodeList: AccessibilityNode[], depth: number, indent: string): void {
    for (const node of nodeList) {
      const attrs: string[] = []
      if (node.name) attrs.push(`name="${node.name}"`)
      if (node.bounds) {
        attrs.push(`bounds="${node.bounds.x},${node.bounds.y},${node.bounds.width},${node.bounds.height}"`)
      }
      if (!node.enabled) attrs.push('enabled="false"')
      if (node.value) attrs.push(`value="${node.value.slice(0, 50)}"`)

      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : ''

      if (node.children && node.children.length > 0 && depth < maxDepth) {
        lines.push(`${indent}<${node.role}${attrStr}>`)
        walk(node.children, depth + 1, indent + '  ')
        lines.push(`${indent}</${node.role}>`)
      } else {
        lines.push(`${indent}<${node.role}${attrStr} />`)
      }
    }
  }

  walk(nodes, 0, '')
  return lines.join('\n')
}
