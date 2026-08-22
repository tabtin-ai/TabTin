/**
 * Unified Security Policy — 跨端统一的安全策略类型定义
 *
 * 所有策略的 SSOT，由 Django 从 Space.agent_config 解析后下发，
 * Daemon / Electron / MCP / CLI / iOS / Android 统一消费。
 */

// ---------------------------------------------------------------------------
// 终端执行模式
// ---------------------------------------------------------------------------

export type TerminalMode =
  | 'tabtin_only'  // 仅允许 tabtin CLI 命令
  | 'sandboxed'    // 白名单 + 黑名单，未知命令拒绝
  | 'regular'      // 宽松模式，仅拦截高危
  | 'blocked';     // 完全禁止终端执行

// ---------------------------------------------------------------------------
// 操作开关
// ---------------------------------------------------------------------------

export type SwitchAction = 'allow' | 'confirm' | 'block';

export const OPERATION_SWITCH_KEYS = [
  'git_read',
  'git_push',
  'git_destructive',
  'rm',
  'mv',
  'db_write',
  'db_schema',
  'package_install',
  'curl_read',
  'curl_mutate',
  'docker',
  'kubectl',
  'ssh',
] as const;

export type OperationSwitchKey = (typeof OPERATION_SWITCH_KEYS)[number];

export type OperationSwitches = Partial<Record<OperationSwitchKey, SwitchAction>>;

// ---------------------------------------------------------------------------
// 设备权限（设备（移动 + 桌面））
// ---------------------------------------------------------------------------
//
// 同时服务 TabPhone（screen_* 等）、TabDesktop（desktop_observe / desktop_input /
// desktop_window）两端。v1.0 注释"移动端"已过窄（TabDesktop Wave 2 · v1.3 → v1.4
// 明示），当前字段实际覆盖两类操控型 App。

export type DevicePermissionKey =
  | 'read_contacts'
  | 'read_sms'
  | 'send_sms'
  | 'read_calendar'
  | 'get_location'
  | 'read_media'
  | 'screen_capture'
  | 'screen_tap'
  | 'launch_app'
  // 强制停止应用：与 launch_app 拆分独立权限键，便于细粒度管控
  // （启动应用 vs 强制停止应用敏感度不同；管控类客户常需"可启动但不可强停"）。
  // 与 Django sandbox_policy.py 4 预设 + iOS WebSocketService.swift +
  // Android SecurityPolicyChecker.kt 共识一致；W A0.4 跨语言契约同步引入。
  | 'force_stop_app'
  | 'set_system'
  | 'read_call_log'
  | 'make_call'
  | 'read_notifications'
  | 'list_installed_apps'
  | 'device_info'
  | 'desktop_observe'
  | 'desktop_input'
  | 'desktop_window';

export type DevicePermissions = Partial<Record<DevicePermissionKey, SwitchAction>>;

// ---------------------------------------------------------------------------
// 沙箱配置
// ---------------------------------------------------------------------------

export type SandboxLevel = 'filesystem' | 'complete';
export type NetworkMode = 'allowed' | 'blocked' | 'custom';
export type SqlMode = 'read_only' | 'read_write' | 'blocked';

// ---------------------------------------------------------------------------
// 统一安全策略
// ---------------------------------------------------------------------------

export interface UnifiedSecurityPolicy {
  /** L1: 终端执行模式 */
  terminal_mode: TerminalMode;

  /** L2: 操作开关（sandboxed / regular 模式下有效） */
  operation_switches: OperationSwitches;

  /** L3: 沙箱级别 */
  sandbox_level: SandboxLevel;

  /** L3: 网络模式 */
  network_mode: NetworkMode;

  /** L3: 禁止读取的路径（glob 或 ~ 前缀） */
  deny_read_paths: string[];

  /** L3: 禁止写入的路径（glob 或 ~ 前缀） */
  deny_write_paths: string[];

  /** L4: SQL 执行模式 */
  sql_mode: SqlMode;

  /** L5: 设备权限（设备（移动 + 桌面）） */
  device_permissions: DevicePermissions;

  /** L6: 高危命令是否强制审批（regular 模式下生效）。默认 true */
  high_risk_requires_approval?: boolean;

  /**
   * L7: 沙箱路径授权（PRD 05 §6.8，W1A 类型就绪，WorkspacePathPolicy 实现留 W4B）。
   *
   * 每个 grant 声明：
   *   - path：被授权访问的绝对路径（根路径 '/' 在构造时硬拒）
   *   - read_only：该路径是否只允许读
   *   - source：grant 来源（system = 运行时默认；user = 用户配置；skill_declared = Skill manifest）
   *
   * 查询语义（W4B 实现）：longest-prefix 匹配；for_write 碰到 read_only grant raise。
   */
  sandbox_path_grants?: SandboxPathGrant[];

  /**
   * 远程挂载的命令白名单（PRD 05 §6.8 / openai 对应机制，本 PRD 作为数据结构预埋）。
   * 用户接第三方对象存储（OSS / WebDAV）时，本字段限制可在挂载路径下执行的命令集合。
   * Phase 2 才实装；W1A 仅定义字段，默认 undefined。
   */
  remote_mount_command_allowlist?: string[];
}

// ---------------------------------------------------------------------------
// 沙箱路径授权（SandboxPathGrant）— PRD 05 §6.8
// ---------------------------------------------------------------------------

export type SandboxPathGrantSource = 'system' | 'user' | 'skill_declared';

/**
 * 单个沙箱路径授权项。
 *
 * 校验规则（W4B `WorkspacePathPolicy` 会强制执行）：
 *   - `path` 必须是绝对路径（!startsWith('/') 构造即报错）
 *   - `path !== '/'`（filesystem root 被硬拒，防 `SandboxPathGrant({path:'/',read_only:true})` 打开整盘）
 *   - 相同 path 重复声明时后声明覆盖（但 `source` 优先级：skill_declared < user < system）
 */
export interface SandboxPathGrant {
  /** 绝对路径，不能是 '/' */
  path: string;
  /** true = 只允许读；for_write 查询会 raise WorkspaceReadOnlyError */
  read_only: boolean;
  /** 可选描述，用于审批 UI 显示 "授权来源：XXX" */
  description?: string;
  /** 授权来源，影响冲突时的优先级 */
  source: SandboxPathGrantSource;
}

// ---------------------------------------------------------------------------
// 策略决策结果（pipeline 四态）
// ---------------------------------------------------------------------------

/**
 * Pipeline 层的四态决策（PRD 05 §4 原则 2、§5.1）。
 *
 * - `allow` = 通过
 * - `deny`  = 拒绝
 * - `ask`   = 需要用户审批
 * - `passthrough` **是 pipeline 特有** —— "本层无意见，交下层"语义。多来源规则合并时
 *   必需的分层语义：例如 Layer 3 Rule Match 对某个工具规则库里没有命中任何规则
 *   → 返 passthrough；Layer 4 Memoization 再看；都没命中才到 Layer 5 / Layer 6。
 *
 * 最终提交给 tool_orchestration 的决策必须是 allow / deny / ask 之一（由 pipeline
 * driver 保证：若全部 Layer 都 passthrough，driver fail-closed 到 ask）。
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'passthrough';
