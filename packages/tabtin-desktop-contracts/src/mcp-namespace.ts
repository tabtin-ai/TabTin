/**
 * `tabtin:desktop:*` MCP 命名空间常量（规范 § 3.5.3 · 模块零定型）。
 *
 * v2.0 不强制 TabDesktop 走 MCP 子进程通信（仍然是 Electron 主进程内 +
 * Go CLI HTTP 同机环回的 v1 架构），但**预留命名空间**——将来 TabDesktop
 * 拆出独立 MCP server（让本地 Daemon / 远端 Cloud 模式接入）时，工具名 /
 * 资源 URI 不需要改 SKILL，只换 dispatcher。
 *
 * 模块零阶段：
 * - 工具名常量统一从这里导出（grep `tabtin:desktop:` 可见）；
 * - 资源 URI 前缀统一从这里导出；
 * - **不真注册 MCP server**——v1 仍走 Go CLI → HTTP 路径。
 *
 * 后续模块加新工具按 `TABTIN_DESKTOP_TOOL_NAMES.<NAME>` 命名约定，
 * 避免与 TabPhone（`tabtin:phone:*`）/ TabWeb（`tabtin:web:*`）冲突。
 */

/** `tabtin:desktop:*` 工具名常量集合 —— v1 与 Go CLI / HTTP 路由一对一对齐。 */
export const TABTIN_DESKTOP_TOOL_NAMES = {
  /** 截屏 + 建立 session（规范 § 4.1）。 */
  SCREENSHOT: 'tabtin:desktop:screenshot',
  /** 单击 / 双击 / 三击 / 中键 / 右键（规范 § 4.2）。 */
  CLICK: 'tabtin:desktop:click',
  /** 鼠标滚动（规范 § 4.2）。 */
  SCROLL: 'tabtin:desktop:scroll',
  /** 鼠标拖拽（规范 § 4.2）。 */
  DRAG: 'tabtin:desktop:drag',
  /** 鼠标移动（规范 § 4.2）。 */
  MOVE: 'tabtin:desktop:move',
  /** 键盘输入（含 clipboard 路径，规范 § 4.3）。 */
  TYPE: 'tabtin:desktop:type',
  /** 单按键（含修饰键，规范 § 4.3）。 */
  KEY: 'tabtin:desktop:key',
  /** 组合键（规范 § 4.3）。 */
  HOTKEY: 'tabtin:desktop:hotkey',
  /** 列窗口（规范 § 4.4）。 */
  WINDOWS: 'tabtin:desktop:windows',
  /** 激活窗口（规范 § 4.4）。 */
  ACTIVATE: 'tabtin:desktop:activate',
  /** 打开应用（规范 § 4.4）。 */
  OPEN: 'tabtin:desktop:open',
  /** 批处理（规范 § 4.5.2 · Wave 3 落地）。 */
  BATCH: 'tabtin:desktop:batch',
  /** 会话开始（规范 § 5.1）。 */
  SESSION_START: 'tabtin:desktop:session_start',
  /** 会话结束（规范 § 5.1）。 */
  SESSION_END: 'tabtin:desktop:session_end',
  /** 会话内白名单扩权（规范 § 6.12 · Wave 2 落地）。 */
  SESSION_EXTEND_ALLOWLIST: 'tabtin:desktop:session_extend_allowlist',
  /** 权限诊断（规范 § 4.4.3.1）。 */
  ACCESSIBILITY: 'tabtin:desktop:accessibility',
  /** 撤销持久化授权（规范 § 6.3）。 */
  REVOKE_APPROVAL: 'tabtin:desktop:revoke_approval',
} as const

/** 工具名常量的字符串字面量 union 类型（编译期校验调用方传值）。 */
export type TabtinDesktopToolName =
  (typeof TABTIN_DESKTOP_TOOL_NAMES)[keyof typeof TABTIN_DESKTOP_TOOL_NAMES]

/**
 * 资源 URI 前缀。具体形态如 `tabtin-desktop://session/<sessionId>` /
 * `tabtin-desktop://screenshot/<sessionId>/<step>` 等。
 *
 * 模块零阶段不强制资源型 URI 落地（v1 截图走 file path 而非 MCP resource）；
 * 模块四 AX Tree 引入"按元素 id 索引"时可能升级为 resource URI 形态。
 */
export const TABTIN_DESKTOP_RESOURCE_URI_PREFIX = 'tabtin-desktop://'

/**
 * 工具名命名空间前缀（grep 验收锚点）。所有 TabDesktop 相关工具应以此为前缀。
 */
export const TABTIN_DESKTOP_TOOL_NAMESPACE_PREFIX = 'tabtin:desktop:'
