/**
 * @tabtin/os-errors — 类型定义
 *
 * OS 级文件 / 网络访问异常的统一抽象。Agent 拿到的不是裸 errno，
 * 而是带「用户引导 + Agent 行为约束 + 可选恢复工具提示」的结构化错误。
 *
 * 设计原则：
 *   - 错误码跨平台中立（OS_PERMISSION_DENIED 同时覆盖 macOS TCC / Windows ACL / Linux EACCES）
 *   - 「用户该做什么」由错误产生处生成（中文人话），Agent 转述即可，不做语义匹配
 *   - terminal=true 表示 Agent 不应重试该 (path, code)，由 runtime 节流模块强制执行
 */

/**
 * 跨平台错误码集 —— 平台特化判断完成后归一到这里。
 * Agent runtime / Tool 层 / UI 层 / CLI 都只看这套码。
 */
export type OSErrorCode =
  /** 系统级权限拒绝：macOS TCC、Windows NTFS ACL、Linux POSIX */
  | 'OS_PERMISSION_DENIED'
  /** 杀软或安全策略拦截（主要 Windows 第三方杀软 + Defender 受控文件夹） */
  | 'OS_AV_BLOCKED'
  /** 云盘占位文件未下载到本地：iCloud Drive / OneDrive Files On-Demand / 百度网盘 */
  | 'CLOUD_NOT_DOWNLOADED'
  /** 网络共享卷需凭据：SMB / 映射盘符 */
  | 'NETWORK_CREDENTIAL_REQUIRED'
  /** Windows MAX_PATH=260 未启用长路径 */
  | 'PATH_TOO_LONG'
  /** 磁盘已加密未解锁：FileVault / BitLocker / LUKS */
  | 'DISK_LOCKED'
  /** 文件被其他进程占用 */
  | 'TARGET_BUSY'
  /** 路径不存在（区别于 PERMISSION_DENIED：用户输错路径而非权限问题） */
  | 'TARGET_NOT_FOUND';

/**
 * 路径所属类目 —— 用来选对应的 LLM 模板。
 * macOS 上同样是 EPERM，访问可移除卷和访问 iCloud 给用户的指引完全不同。
 */
export type OSErrorCategory =
  | 'RemovableVolume' // /Volumes/<外接盘>、外接 USB / SD 卡
  | 'CloudStorage' // iCloud Drive、OneDrive、百度网盘等
  | 'Documents' // ~/Documents
  | 'Desktop' // ~/Desktop
  | 'Downloads' // ~/Downloads
  | 'NetworkVolume' // 网络共享卷 SMB / AFP
  | 'FullDisk' // 需 Full Disk Access 才能访问的系统路径
  | 'Other'; // 其他 / 未识别

/** 给 Agent 推荐的恢复动作类型 —— 不强制 UI 渲染，主要供 deepLink 使用 */
export type RecoveryActionType =
  | 'open_system_settings'
  | 'restart_app'
  | 'choose_alternate_path'
  | 'whitelist_in_av'
  | 'wait_cloud_sync'
  | 'reauth_credential';

export interface RecoveryAction {
  type: RecoveryActionType;
  /** 给用户看的简短描述 */
  label: string;
  /** 可选：系统设置深度链接（macOS x-apple.systempreferences:、Windows windowsdefender: 等） */
  deepLink?: string;
}

/** 内部完整错误对象 —— 工具层创建后通过 serialize 给 Agent */
export interface OSError {
  code: OSErrorCode;
  category: OSErrorCategory;
  /** Node 进程的 platform，固定为 darwin / win32 / linux 之一 */
  platform: NodeJS.Platform;
  /** 原始操作的目标路径 —— 直接展示给用户 */
  path: string;
  /** 原始 errno / Win32 error code / 错误消息 —— 给开发者 telemetry，不展示给用户 */
  rawDetail: string;
  /** 是否禁止 Agent 重试（重试也会失败，浪费 token） */
  terminal: boolean;
  /** 中文用户引导 —— Agent 直接转述给用户，禁止改步骤 */
  userGuidance: string;
  /** Agent 必须遵守的硬约束（"不要 sudo"、"不要重试此路径"、"先确认是否重启" 等） */
  agentDirectives: string[];
  /** 可选恢复动作 —— Agent 可在转述时附 deepLink */
  recoveryActions: RecoveryAction[];
}

/**
 * 给后端 / Agent 看的精简序列化形态 —— Tool 层把 OSError 打包成这种。
 * 所有 Agent 决策需要的内容都在 llm_message 一段自然语言里，
 * 其余字段供 runtime 节流 / telemetry / 日志使用。
 */
export interface OSToolError {
  code: OSErrorCode;
  category: OSErrorCategory;
  platform: NodeJS.Platform;
  path: string;
  terminal: boolean;
  /** Agent 唯一需要读的字段 —— 自包含，含用户引导 + 约束 + 工具提示 */
  llm_message: string;
  /** 仅给 telemetry / 排错使用，不应进入 LLM context */
  raw_detail: string;
}

/**
 * 检测某个错误是否 @tabtin/os-errors 抛出的 OSError。
 *
 * **shape 判断**（不要求 instanceof）：跨进程 / mock 测试场景下都能命中。
 *
 * **空值防御**（Wave 1 第三轮 技术视角 Review 必修）：
 * `typeof null === 'object'` 是 JS 历史包袱——纯 typeof 检查会让
 * `{ osError: null }` 错误对象命中本函数，下游 `renderForAgent(osError)`
 * 取字段时立即运行时 NPE。这条防御在 `'osError' in err` 之后显式拒绝
 * `null`，让 shape 判断真的安全。
 */
export function isOSError(err: unknown): err is { osError: OSError } {
  if (typeof err !== 'object' || err === null) return false;
  if (!('osError' in err)) return false;
  const inner = (err as { osError: unknown }).osError;
  // 显式拒绝 null（防 NPE）+ Array（osError 应当是 plain object，array 让下游
  // 拿字段时返回 undefined 形成"假命中真 NPE"）+ 非 object 类型。
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}
