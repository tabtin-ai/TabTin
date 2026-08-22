/**
 * Accessibility Tree 类型定义（规范 § 4.6.2 · 模块四）。
 *
 * AX 快照以 JSON 形式返回给 Agent（或 CLI `--format table` 打印）。
 * 数据结构与规范 § 4.6.2 "数据结构" 段一一对应。
 */

/** AX 节点——递归结构，表示一个可访问性元素。 */
export interface AccessibilityNode {
  /** 节点稳定 id，用于 click-element 精确定位 */
  id: string
  /** 元素角色（Button / Edit / MenuItem / Link …） */
  role: string
  /** 元素可见名（case-insensitive partial match） */
  name?: string
  /** 输入类控件的当前文本（截断到 200 字符） */
  value?: string
  /** 元素逻辑坐标（与主坐标系一致） */
  bounds?: { x: number; y: number; width: number; height: number }
  /** 元素是否可交互 */
  enabled: boolean
  /** 元素是否在视口内可见 */
  visible: boolean
  /** 子节点 */
  children?: AccessibilityNode[]
}

/** AX 快照根结构——返回给 Agent 的完整响应。 */
export interface AccessibilitySnapshot {
  /** 快照时间戳 */
  capturedAt: string
  /** 快照所针对的前台/指定窗口 */
  targetWindow: { app: string; title: string; bundleId?: string }
  /** 平台标识 */
  platform: 'darwin' | 'win32'
  /** 顶层节点列表 */
  rootNodes: AccessibilityNode[]
  /** 降级信号：AX 查询部分失败时仍返回部分节点 */
  degraded?: { reason: string }
}

/** captureAccessibilityTree 入参。 */
export interface AccessibilityTreeOpts {
  /** 按窗口标题子串匹配（大小写不敏感） */
  window?: string
  /** macOS bundle id 定位 */
  bundleId?: string
  /** AX 树递归深度上限（默认 4） */
  maxDepth?: number
  /** 仅返回交互元素白名单（默认 true） */
  interactiveOnly?: boolean
  /** 返回节点数上限（默认 500），超出截断并返回 degraded 标记 */
  maxNodes?: number
}

/** clickElement 入参。 */
export interface ClickElementOpts {
  /** 元素可见名（必填） */
  name: string
  /** 限定角色 */
  role?: string
  /** Windows UIA AutomationId */
  automationId?: string
  /** 同名多元素取第 N 个（0-based，默认 0） */
  nth?: number
  /** 鼠标按钮 */
  button?: 'left' | 'right' | 'middle'
  /** 点击次数 */
  count?: number
}

/** clickElement 返回值。 */
export interface ClickElementResult {
  done: true
  matched: { id: string; role: string; name?: string; bounds?: { x: number; y: number; width: number; height: number } }
}

/** typeIntoElement 入参。 */
export interface TypeIntoElementOpts {
  /** 元素可见名（必填） */
  name: string
  /** 限定角色 */
  role?: string
  /** Windows UIA AutomationId */
  automationId?: string
  /** 要输入的文本 */
  text: string
  /** 走剪贴板粘贴 */
  clipboard?: boolean
}

/** typeIntoElement 返回值。 */
export interface TypeIntoElementResult {
  done: true
  matched: { id: string; role: string; name?: string; bounds?: { x: number; y: number; width: number; height: number } }
}
