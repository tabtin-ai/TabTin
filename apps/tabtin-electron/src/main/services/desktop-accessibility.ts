/**
 * macOS Accessibility Tree 采集（osascript + System Events）。
 *
 * 规范 § 4.6.2 路径 a：Node 主进程 → execFile('osascript', ...) → System Events
 * → ui elements of process → 递归遍历 → stdout JSON。
 *
 * 已知限制（规范 § 4.6.2 · 路径 a 坑点）：
 * - 单次查询耗时几百 ms（复杂层级 1-2s）
 * - TCC 权限要求：需要"辅助功能"权限
 * - App Sandbox 影响下 AX 元素可能只部分暴露
 */

import { execFile } from 'node:child_process'
import { createLogger } from '../logger'
import { DesktopError, DesktopErrorCode } from './desktop-error-codes'
import { escapeAppleScript } from './desktop-window-helpers'
import type { AccessibilityNode, AccessibilitySnapshot, AccessibilityTreeOpts } from '@tabtin/desktop-contracts'

const log = createLogger('DesktopAX')

const AX_TIMEOUT_MS = 30_000

const INTERACTIVE_ROLES = new Set([
  'AXButton', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXCheckBox',
  'AXRadioButton', 'AXMenuItem', 'AXMenu', 'AXMenuBar', 'AXLink',
  'AXSlider', 'AXIncrementor', 'AXTabGroup', 'AXTab', 'AXList',
  'AXRow', 'AXOutline', 'AXTable', 'AXCell', 'AXScrollBar',
  'AXToolbar', 'AXPopUpButton', 'AXDisclosureTriangle',
  'AXStaticText', 'AXImage', 'AXGroup', 'AXSplitGroup',
])

function normalizeRole(axRole: string): string {
  return axRole.replace(/^AX/, '')
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; encoding: BufferEncoding },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString() ?? err.message
        reject(new Error(msg))
      } else {
        resolve(stdout?.toString() ?? '')
      }
    })
  })
}

/**
 * 获取前台应用名称 + 标题。
 */
async function getFrontmostAppInfo(): Promise<{ app: string; title: string; bundleId?: string }> {
  const script = `
tell application "System Events"
  set fp to first application process whose frontmost is true
  set appName to name of fp
  set winTitle to ""
  try
    set winTitle to name of front window of fp
  end try
  set bid to bundle identifier of fp
  return appName & "|||" & winTitle & "|||" & bid
end tell`
  try {
    const raw = await execFileAsync('osascript', ['-e', script], {
      timeout: 5000,
      encoding: 'utf-8',
    })
    const parts = raw.trim().split('|||')
    return {
      app: parts[0] ?? 'Unknown',
      title: parts[1] ?? '',
      bundleId: parts[2] || undefined,
    }
  } catch (err) {
    log.warn('getFrontmostAppInfo failed:', err)
    return { app: 'Unknown', title: '' }
  }
}

/**
 * 构造 macOS osascript 脚本，递归遍历指定进程的 UI 元素。
 *
 * 返回 JSON 格式的元素树。使用 AppleScript（非 JXA）因为 System Events
 * 的 UI elements 在 AppleScript 中更稳定。
 */
function buildAxScript(processName: string, maxDepth: number, interactiveOnly: boolean, maxNodes: number): string {
  const escapedName = escapeAppleScript(processName)
  const jxaScript = `
var se = Application("System Events");
var proc = se.processes["${escapedName}"];
var maxD = ${maxDepth};
var maxN = ${maxNodes};
var interactive = ${interactiveOnly ? 'true' : 'false'};
var interactiveRoles = ${JSON.stringify([...INTERACTIVE_ROLES])};
var nodeId = 0;
var nodeCount = 0;
var truncated = false;

function traverse(el, depth) {
  if (depth > maxD) return null;
  if (nodeCount >= maxN) { truncated = true; return null; }
  try {
    var role = "";
    try { role = el.role(); } catch(e) {}
    if (!role) return null;

    if (interactive && interactiveRoles.indexOf(role) === -1 && depth > 0) {
      var kids = [];
      try {
        var uis = el.uiElements();
        for (var i = 0; i < uis.length; i++) {
          var c = traverse(uis[i], depth + 1);
          if (c) kids.push(c);
        }
      } catch(e) {}
      if (kids.length === 0) return null;
      return { _passthrough: true, children: kids };
    }

    nodeCount++;
    var node = { id: "${escapedName}#" + (nodeId++), role: role.replace(/^AX/, ""), enabled: true, visible: true };

    try { var n = el.name(); if (n) node.name = String(n); } catch(e) {}
    try { var v = el.value(); if (v !== undefined && v !== null) { var sv = String(v); node.value = sv.length > 200 ? sv.substring(0, 200) : sv; } } catch(e) {}
    try {
      var pos = el.position();
      var sz = el.size();
      if (pos && sz) {
        node.bounds = { x: pos[0], y: pos[1], width: sz[0], height: sz[1] };
        if (sz[0] <= 0 || sz[1] <= 0) return null;
        if (pos[0] < -10000) return null;
      }
    } catch(e) {}
    try { node.enabled = el.enabled(); } catch(e) {}

    if (depth < maxD) {
      try {
        var uis = el.uiElements();
        var kids = [];
        for (var i = 0; i < uis.length; i++) {
          var c = traverse(uis[i], depth + 1);
          if (c) {
            if (c._passthrough) {
              for (var j = 0; j < c.children.length; j++) kids.push(c.children[j]);
            } else {
              kids.push(c);
            }
          }
        }
        if (kids.length > 0) node.children = kids;
      } catch(e) {}
    }
    return node;
  } catch(e) { return null; }
}

var roots = [];
try {
  var wins = proc.windows();
  for (var w = 0; w < wins.length; w++) {
    var r = traverse(wins[w], 0);
    if (r && !r._passthrough) roots.push(r);
    else if (r && r._passthrough) {
      for (var j = 0; j < r.children.length; j++) roots.push(r.children[j]);
    }
  }
} catch(e) {}

// 如果窗口没拿到，尝试从顶层 UI elements 入手
if (roots.length === 0) {
  try {
    var uis = proc.uiElements();
    for (var i = 0; i < uis.length; i++) {
      var r = traverse(uis[i], 0);
      if (r && !r._passthrough) roots.push(r);
      else if (r && r._passthrough) {
        for (var j = 0; j < r.children.length; j++) roots.push(r.children[j]);
      }
    }
  } catch(e) {}
}

JSON.stringify({ roots: roots, truncated: truncated, nodeCount: nodeCount });
`
  return jxaScript
}

/**
 * macOS AX 树采集入口。
 *
 * @throws DesktopError(AX_UNAVAILABLE) - TCC 权限缺失或 osascript 执行失败
 * @throws DesktopError(ELEMENT_NOT_FOUND) - 找不到指定窗口/进程
 */
export async function captureAccessibilityTreeMac(
  opts: AccessibilityTreeOpts = {},
): Promise<AccessibilitySnapshot> {
  const maxDepth = opts.maxDepth ?? 4
  const interactiveOnly = opts.interactiveOnly !== false

  let targetApp: { app: string; title: string; bundleId?: string }

  if (opts.window || opts.bundleId) {
    // 按窗口标题/bundleId 定位
    const searchScript = opts.bundleId
      ? `
tell application "System Events"
  set fp to first application process whose bundle identifier is "${escapeAppleScript(opts.bundleId)}"
  set appName to name of fp
  set winTitle to ""
  try
    set winTitle to name of front window of fp
  end try
  return appName & "|||" & winTitle & "|||" & "${escapeAppleScript(opts.bundleId)}"
end tell`
      : `
tell application "System Events"
  set allProcs to application processes whose visible is true
  repeat with p in allProcs
    try
      set wins to windows of p
      repeat with w in wins
        if name of w contains "${escapeAppleScript(opts.window!)}" then
          return (name of p) & "|||" & (name of w) & "|||" & (bundle identifier of p)
        end if
      end repeat
      if name of p contains "${escapeAppleScript(opts.window!)}" then
        set winTitle to ""
        try
          set winTitle to name of front window of p
        end try
        return (name of p) & "|||" & winTitle & "|||" & (bundle identifier of p)
      end if
    end try
  end repeat
  error "找不到匹配窗口"
end tell`

    try {
      const raw = await execFileAsync('osascript', ['-e', searchScript], {
        timeout: 5000,
        encoding: 'utf-8',
      })
      const parts = raw.trim().split('|||')
      targetApp = {
        app: parts[0] ?? 'Unknown',
        title: parts[1] ?? '',
        bundleId: parts[2] || undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('辅助功能') || msg.includes('assistive') || msg.includes('not allowed')) {
        throw new DesktopError(
          DesktopErrorCode.AX_UNAVAILABLE,
          `Accessibility Tree 不可用：macOS 辅助功能权限未授予。` +
          `本次 AX 查询未执行。` +
          `请在「系统设置 → 隐私与安全性 → 辅助功能」中启用 TabTin，然后重试；` +
          `或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
        )
      }
      throw new DesktopError(
        DesktopErrorCode.ELEMENT_NOT_FOUND,
        `找不到目标窗口：按 ${opts.window ? `标题「${opts.window}」` : `bundleId「${opts.bundleId}」`} 未能匹配到可见窗口/进程。` +
        `本次 AX 查询未执行。` +
        `请确认目标应用已启动且窗口可见，或使用 tabtin desktop windows 列出当前所有窗口后重试。`,
      )
    }
  } else {
    targetApp = await getFrontmostAppInfo()
  }

  const maxNodes = opts.maxNodes ?? 500
  const jxaScript = buildAxScript(targetApp.app, maxDepth, interactiveOnly, maxNodes)

  let rawJson: string
  try {
    rawJson = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxaScript], {
      timeout: AX_TIMEOUT_MS,
      encoding: 'utf-8',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('辅助功能') || msg.includes('assistive') || msg.includes('not allowed') || msg.includes('AXError')) {
      throw new DesktopError(
        DesktopErrorCode.AX_UNAVAILABLE,
        `Accessibility Tree 不可用：macOS 辅助功能权限未授予或 AX 查询被系统拒绝。` +
        `本次 AX 查询未执行。` +
        `请在「系统设置 → 隐私与安全性 → 辅助功能」中启用 TabTin，` +
        `或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
      )
    }
    if (msg.includes('timed out') || msg.includes('ETIMEDOUT')) {
      throw new DesktopError(
        DesktopErrorCode.INTERNAL_ERROR,
        `AX 查询超时（超过 ${AX_TIMEOUT_MS / 1000} 秒）：目标应用 UI 层级可能过于复杂。` +
        `本次 AX 查询未完成。` +
        `建议降低 --max-depth 参数，或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
      )
    }
    throw new DesktopError(
      DesktopErrorCode.AX_UNAVAILABLE,
      `AX 查询失败：${msg.slice(0, 200)}。` +
      `本次 AX 查询未执行。` +
      `请检查目标应用状态，或使用 tabtin desktop screenshot + 坐标点击作为替代。`,
    )
  }

  let rootNodes: AccessibilityNode[]
  let truncated = false
  try {
    const parsed = JSON.parse(rawJson.trim())
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.roots)) {
      rootNodes = parsed.roots
      truncated = !!parsed.truncated
    } else if (Array.isArray(parsed)) {
      rootNodes = parsed
    } else {
      rootNodes = []
    }
  } catch {
    log.warn('AX tree JSON parse failed, raw:', rawJson.slice(0, 500))
    rootNodes = []
  }

  const degradedReasons: string[] = []
  if (rootNodes.length === 0) {
    degradedReasons.push('未获取到任何 AX 节点——目标应用可能不暴露 Accessibility 信息')
  }
  if (truncated) {
    degradedReasons.push(`节点数超出上限（maxNodes=${maxNodes}），AX 树已截断，深层元素可能缺失`)
  }

  return {
    capturedAt: new Date().toISOString(),
    targetWindow: targetApp,
    platform: 'darwin',
    rootNodes,
    degraded: degradedReasons.length > 0
      ? { reason: degradedReasons.join('；') }
      : undefined,
  }
}

/**
 * 在 AX 快照中按 name + role + nth 查找元素。
 *
 * @returns 匹配的节点，或 null（未找到）。
 */
export function findElementInSnapshot(
  snapshot: AccessibilitySnapshot,
  name: string,
  role?: string,
  nth = 0,
): AccessibilityNode | null {
  const matches: AccessibilityNode[] = []
  const nameLower = name.toLowerCase()

  function walk(nodes: AccessibilityNode[]) {
    for (const node of nodes) {
      const nodeNameLower = (node.name ?? '').toLowerCase()
      const nameMatch = nodeNameLower.includes(nameLower)
      const roleMatch = !role || node.role.toLowerCase() === role.toLowerCase()
      if (nameMatch && roleMatch) {
        matches.push(node)
      }
      if (node.children) walk(node.children)
    }
  }

  walk(snapshot.rootNodes)
  return matches[nth] ?? null
}

/**
 * 收集 AX 快照中所有与指定角色匹配的元素名称（用于错误提示）。
 */
export function collectCandidateNames(
  snapshot: AccessibilitySnapshot,
  role?: string,
  limit = 10,
): string[] {
  const candidates: string[] = []

  function walk(nodes: AccessibilityNode[]) {
    for (const node of nodes) {
      if (candidates.length >= limit) return
      const roleMatch = !role || node.role.toLowerCase() === role.toLowerCase()
      if (roleMatch && node.name) {
        candidates.push(`${node.role}:"${node.name}"`)
      }
      if (node.children) walk(node.children)
    }
  }

  walk(snapshot.rootNodes)
  return candidates
}
