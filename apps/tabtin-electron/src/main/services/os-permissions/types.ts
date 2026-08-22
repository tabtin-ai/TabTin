/**
 * OS 系统权限统一类型定义
 *
 * 这里只描述「操作系统给 TabTin 这个 App 的能力」，
 * 与业务层的 HITL 审批（ApprovalManager / approval_memo / yolo）正交，
 * 不要把任何业务概念混进来。
 */

export type PermissionKind =
  // macOS 专属：写到 TCC-protected 路径需要的隐私授权
  | 'fullDiskAccess'    // 完全磁盘访问（Privacy_AllFiles）
  | 'screenCapture'     // 屏幕录制（Privacy_ScreenCapture）
  | 'accessibility'     // 辅助功能（Privacy_Accessibility）
  | 'automation'        // 自动化 / Apple Events（Privacy_Automation）
  // 跨平台
  | 'microphone'        // 麦克风
  | 'notifications'     // 系统通知
  | 'location'          // 位置服务

export type PermissionStatus =
  | 'granted'           // 已授权
  | 'denied'            // 用户拒绝
  | 'not-determined'    // 未询问 / 尚不确定（可检测项尚未拿到明确结果）
  | 'restricted'        // 系统级受限（家长控制 / MDM 限制）
  | 'not-applicable'    // 当前平台无此概念（如 Windows 没有 FullDiskAccess）
  | 'unknown'           // 检测失败（调用有效但抛异常）

/**
 * 检测能力：
 *  - supported（默认）：能向系统查到相对可信的状态
 *  - unsupported：Electron 无可靠 API，status 仅作占位（常见 not-determined），
 *    UI 应展示「无法自动检测」；总览分母仍计入（与列表适用项一致，见 ），
 *    但 tagline「必要权限已齐」只看 supported 项
 */
export type PermissionDetection = 'supported' | 'unsupported'

export interface PermissionDescriptor {
  kind: PermissionKind
  status: PermissionStatus
  platform: NodeJS.Platform
  /** App 内能否主动触发系统弹窗请求（仅 macOS 的 microphone / camera / accessibility 等支持） */
  canRequest: boolean
  /** 能否一键跳转系统设置对应隐私 pane */
  canOpenSettings: boolean
  /** 省略时视为 supported */
  detection?: PermissionDetection
  /**
   * macOS 辅助功能未信任时：当前进程展示名（Electron / TabTin Dev / TabTin），
   * 供设置页提示用户去系统列表勾选正确条目。
   */
  processLabel?: string
  /**
   * macOS TCC 部分权限在系统设置打开后，需要重启当前 App 进程后检测 API
   * 才会返回 granted。UI 用它解释“系统已开但客户端仍待确认”的过渡状态。
   */
  requiresAppRestartAfterGrant?: boolean
}

export interface OsPermissionsApi {
  /** 返回所有权限当前状态（按 ALL_PERMISSION_KINDS 顺序） */
  list(): Promise<PermissionDescriptor[]>
  /** 重新检测单项 */
  check(kind: PermissionKind): Promise<PermissionDescriptor>
  /** 主动请求（仅 canRequest=true 的项有效） */
  request(kind: PermissionKind): Promise<PermissionStatus>
  /** 跳转系统设置对应隐私 pane；返回是否成功打开 URL */
  openSystemSettings(kind: PermissionKind): Promise<boolean>
}

/** 列表展示顺序：按用途分组（数据 → 屏幕控制 → 输入设备 → 输出） */
export const ALL_PERMISSION_KINDS: readonly PermissionKind[] = [
  'fullDiskAccess',
  'screenCapture',
  'accessibility',
  'automation',
  'microphone',
  'location',
  'notifications',
] as const

/** 权限分组（仅渲染层用，main 不消费） */
export type PermissionGroup = 'data' | 'screen' | 'input' | 'output'

export const PERMISSION_GROUP_MAP: Record<PermissionKind, PermissionGroup> = {
  fullDiskAccess: 'data',
  screenCapture: 'screen',
  accessibility: 'screen',
  automation: 'screen',
  microphone: 'input',
  location: 'input',
  notifications: 'output',
}
