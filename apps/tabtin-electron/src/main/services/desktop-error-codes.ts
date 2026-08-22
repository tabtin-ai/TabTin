/**
 * TabDesktop 错误码枚举 + 轻量错误对象。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.4 / § 6.11.1 / § 10 Q9。
 *
 * 位置选型（Wave 2 · v1.3 → v1.4 决策说明）：
 * - 规范 § 9.2 第 6 条指导放 `packages/tabtin-contracts/desktop/` 或等价契约包。
 * - 工作区当前无 `packages/tabtin-contracts` 包；现有的 `@tabtin/contracts` 是
 *   面向 SDK 跨边界（Web / Electron / 外部集成）共享的类型包（`packages/contracts/`），
 *   使用 `tsup` 打包为 runtime + types。
 * - TabDesktop 错误码的消费者仅限 Electron 主进程（路由 / Executor / 审计日志）
 *   + 同进程 TS 代码，**不跨 SDK 边界**；引入到 `@tabtin/contracts` 会扩展其
 *   "跨端共享"语义并带来不必要的构建依赖。
 * - 对照对象 `TabPhoneErrorCode` 的位置正是
 *   `apps/tabtin-electron/src/main/tabphone/types.ts:270-303`（Electron 同进程、
 *   同产品语义"操控型 App 的执行器具体故障"）——TabDesktop 选相同位置与其对齐。
 * - 结论：本文件落在 `apps/tabtin-electron/src/main/services/desktop-error-codes.ts`，
 *   集中定义枚举 + `DesktopError` 轻量类（仿 `TabPhoneError` 结构：`code / message /
 *   details?`），HTTP 路由、Executor、审计三处统一引用。
 *
 * 命名风格：SCREAMING_SNAKE_CASE 字符串枚举，与 `TabPhoneErrorCode` 完全一致
 * （见规范 § 6.11.1）。
 */

/**
 * 桌面操控错误分类枚举（`DesktopErrorCode`）。
 *
 * Wave 2 落代码版本须包含规范 § 3.4 + § 6.11.1 列出的 13 项——任何新增/删除
 * 都要同步规范与审计消费方，不在本文件内部擅自改动。
 */
export enum DesktopErrorCode {
  /** 未知路由（404）：CLI 侧命令名拼错或规范外路由 */
  UNKNOWN_ROUTE = 'UNKNOWN_ROUTE',
  /** 请求参数非法（400，Wave 2 目标态为 422）：body 字段缺失、类型错误、枚举值非法 */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  /** 策略拒绝（403）：安全预设 / 规则对当前动作判定 block */
  POLICY_BLOCKED = 'POLICY_BLOCKED',
  /** 需要审批（403）：策略判定 confirm 且 Guard 未授权 */
  NEEDS_APPROVAL = 'NEEDS_APPROVAL',
  /** 权限不足（403）：锁未持有 / 快捷键注册失败 / mac 辅助功能未授权等兜底 */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** 锁冲突（403，v1.1 · Wave 2 从 PERMISSION_DENIED 细化）：桌面操控被其它 session 占用 */
  LOCK_CONFLICT = 'LOCK_CONFLICT',
  /** 会话过期（403）：空闲超过 10min 自动结束 */
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  /** 平台不支持（400，Wave 2 新增）：Linux 等非 macOS/win32 平台的顶层拦截 */
  UNSUPPORTED_PLATFORM = 'UNSUPPORTED_PLATFORM',
  /**
   * 显示器配置变化（403，v1.1 · Wave 2 新增）：
   * session 首次截屏冻结的 bounds 在后续 takeScreenshot 时被检测到不一致，
   * 自动 endSession 并抛出（见 § 5.3 规则 8 / § 8.2 示范 D）
   */
  DISPLAY_CONFIG_CHANGED = 'DISPLAY_CONFIG_CHANGED',
  /** macOS TCC 未授权（403，Wave 2 新增）：屏幕录制 / 辅助功能权限未授予 */
  TCC_DENIED = 'TCC_DENIED',
  /** 用户中止（403，Wave 2 新增）：中止快捷键触发 abortController.abort() 后 */
  ABORTED = 'ABORTED',
  /** 内部错误（500 / 503）：执行器抛错 / Executor 未初始化 */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  /** 兜底（500，Wave 2）：所有未归类异常，便于审计聚合 */
  UNKNOWN = 'UNKNOWN',
  /**
   * 元素未找到（400，模块四 · AX Tree）：click-element / type-into-element
   * 按 name + role 在 AX 快照中找不到匹配元素。
   */
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  /**
   * AX 服务不可用（403，模块四 · AX Tree）：macOS 辅助功能权限未授予导致
   * AX 查询被系统拒绝，或 osascript / PowerShell 子进程异常退出。
   */
  AX_UNAVAILABLE = 'AX_UNAVAILABLE',
}

/**
 * Desktop 错误字符串集合（对应枚举所有键，便于运行时 guard）。
 * 仅内部守卫使用；外部代码请引用 `DesktopErrorCode.XXX` 而非字面量。
 */
export const DESKTOP_ERROR_CODES: ReadonlySet<DesktopErrorCode> = new Set<DesktopErrorCode>(
  Object.values(DesktopErrorCode),
)

/**
 * 判断任意值是否属于 `DesktopErrorCode` 枚举（运行时 guard）。
 */
export function isDesktopErrorCode(value: unknown): value is DesktopErrorCode {
  return typeof value === 'string' && DESKTOP_ERROR_CODES.has(value as DesktopErrorCode)
}

/**
 * 轻量错误类——仿 `TabPhoneError` 结构（`code / message / details?`）。
 *
 * Executor 抛出业务错误时建议用 `DesktopError`，路由层 catch 后可直接用
 * `err.code` 填充响应体 `code` 字段 + 审计 `errorCode` 字段，避免"英文串匹配
 * 推断分类"的反模式。
 */
export class DesktopError extends Error {
  public readonly code: DesktopErrorCode
  public readonly details?: Record<string, unknown>

  constructor(
    code: DesktopErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
    this.details = details
    // 兼容 ES2022 之前的 TS target，保证 instanceof 生效
    Object.setPrototypeOf(this, DesktopError.prototype)
  }
}
